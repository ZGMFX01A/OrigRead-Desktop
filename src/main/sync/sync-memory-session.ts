import type {
  SyncAuthProtocolObject,
  SyncCoverage,
  SyncEndpointSession,
  SyncOperationBatchResult,
  SyncOperationEnvelope,
  SyncOperationsPage,
  SyncPeerCapabilities,
  SyncSessionNegotiation,
  SyncSnapshotBundleWire,
  SyncStateVectorResponse,
  SyncRange,
  SyncBlobChunk,
  SyncBlobPersistedAck,
  SyncBlobStatus,
  SyncCursor,
  SyncCoverageVector,
  SyncReplicationPolicy
} from '../../shared/sync-protocol'
import { createHash } from 'node:crypto'
import {
  SYNC_PROTOCOL_VERSION,
  emptySyncCoverageVector,
  normalizeSyncCoverage,
  coveragePrefix,
  mergeSyncCoverage
} from '../../shared/sync-protocol'
import { validateSyncOperationEnvelope, verifySyncOperationSignature } from './sync-operation-wire'

const DEFAULT_CAPABILITIES: SyncPeerCapabilities = {
  protocolVersions: [SYNC_PROTOCOL_VERSION],
  replicationLanes: ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH'],
  snapshotClasses: ['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'],
  blobTransfer: true,
  maxOperationBatch: 500,
  maxBlobChunkBytes: 1_048_576,
  supportsRangeResume: true
}

interface MemoryMember {
  publicKey: string
  status: 'ACTIVE' | 'REVOKED'
  authEpoch: number
}

/** Deterministic transport fixture used by unit tests and local-only development. */
export class SyncMemoryHub {
  private readonly operations = new Map<string, SyncOperationEnvelope>()
  private readonly members = new Map<string, MemoryMember>()
  private readonly snapshots = new Map<string, SyncSnapshotBundleWire>()
  private readonly blobs = new Map<string, Uint8Array>()
  private readonly blobExpectedBytes = new Map<string, number>()
  private readonly blobPersistedAt = new Map<string, number>()
  private readonly acks = new Map<string, SyncCoverageVector>()
  private closed = false

  registerMember(syncSpaceId: string, deviceId: string, publicKey: string, authEpoch = 0): void {
    this.members.set(this.memberKey(syncSpaceId, deviceId), { publicKey, status: 'ACTIVE', authEpoch })
  }

  revokeMember(syncSpaceId: string, deviceId: string, authEpoch: number): void {
    const member = this.members.get(this.memberKey(syncSpaceId, deviceId))
    if (member) this.members.set(this.memberKey(syncSpaceId, deviceId), { ...member, status: 'REVOKED', authEpoch })
  }

  session(syncSpaceId: string, localDeviceId: string): SyncEndpointSession {
    return new MemoryEndpointSession(this, syncSpaceId, localDeviceId)
  }

  close(): void { this.closed = true }

  private memberKey(space: string, device: string): string { return `${space}\u0000${device}` }

  private coverage(): SyncCoverageVector {
    const received: SyncCoverage = {}
    const retained: SyncCoverage = {}
    for (const operation of this.operations.values()) {
      received[operation.replicationLaneId] ??= {}
      retained[operation.replicationLaneId] ??= {}
      const current = coveragePrefix(received, operation.replicationLaneId, operation.actorIncarnationId)
      if (operation.sequence === current + 1) {
        received[operation.replicationLaneId]![operation.actorIncarnationId] = operation.sequence
        // Recompute the prefix after a late gap is filled.
        let next = operation.sequence + 1
        while ([...this.operations.values()].some((candidate) => candidate.replicationLaneId === operation.replicationLaneId && candidate.actorIncarnationId === operation.actorIncarnationId && candidate.sequence === next)) next++
        received[operation.replicationLaneId]![operation.actorIncarnationId] = next - 1
      }
      retained[operation.replicationLaneId]![operation.actorIncarnationId] = Math.max(
        retained[operation.replicationLaneId]![operation.actorIncarnationId] ?? 0,
        operation.sequence
      )
    }
    const applied = [...this.acks.values()].map((ack) => ack.applied).reduce(mergeCoverage, {})
    const snapshot = [...this.acks.values()].map((ack) => ack.snapshot).reduce(mergeCoverage, {})
    const stableGc = [...this.acks.values()].map((ack) => ack.stableGc).reduce(mergeCoverage, {})
    return { received, applied, retained, snapshot, stableGc }
  }

  private assertOpen(): void { if (this.closed) throw new Error('Sync memory hub is closed') }

  private endpoint(localDeviceId: string, space: string): MemoryEndpointSession {
    return new MemoryEndpointSession(this, space, localDeviceId)
  }

  private putOperations(batch: SyncOperationEnvelope[]): SyncOperationBatchResult {
    this.assertOpen()
    const acceptedOperationIds: string[] = []
    const duplicateOperationIds: string[] = []
    const rejected: SyncOperationBatchResult['rejected'] = []
    for (const operation of batch) {
      try {
        validateSyncOperationEnvelope(operation)
        const member = this.members.get(this.memberKey(operation.syncSpaceId, operation.authorDeviceId))
        if (!member) throw new Error('AUTH_FAILED: unknown author device')
        if (!verifySyncOperationSignature(operation, member.publicKey)) throw new Error('AUTH_FAILED: invalid author signature')
        const existing = this.operations.get(operation.operationId)
        const dot = [...this.operations.values()].find((candidate) => candidate.actorIncarnationId === operation.actorIncarnationId && candidate.replicationLaneId === operation.replicationLaneId && candidate.sequence === operation.sequence)
        if (existing || dot) {
          const same = JSON.stringify(existing ?? dot) === JSON.stringify(operation)
          if (!same) throw new Error('DOT_COLLISION: immutable dot differs')
          duplicateOperationIds.push(operation.operationId)
        } else {
          this.operations.set(operation.operationId, { ...operation })
          acceptedOperationIds.push(operation.operationId)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = message.startsWith('AUTH_FAILED') ? 'AUTH_FAILED' : message.startsWith('DOT_COLLISION') ? 'DOT_COLLISION' : 'INVALID_OPERATION'
        rejected.push({ operationId: typeof operation?.operationId === 'string' ? operation.operationId : null, code, message })
      }
    }
    return { acceptedOperationIds, duplicateOperationIds, rejected, coverage: this.coverage(), serverCursor: null }
  }

  private getOperations(ranges: SyncRange[]): SyncOperationsPage {
    this.assertOpen()
    const operations = [...this.operations.values()]
      .filter((operation) => ranges.some((range) => range.replicationLaneId === operation.replicationLaneId && range.actorIncarnationId === operation.actorIncarnationId && operation.sequence >= range.fromSequence && operation.sequence <= range.toSequence))
      .sort(compareOperation)
    return { operations, nextCursor: null, coverage: this.coverage(), serverCursor: null }
  }

  private snapshot(requirement?: { class?: SyncSnapshotBundleWire['snapshotClass']; lanes?: string[] }): SyncSnapshotBundleWire | null {
    const requestedLanes = new Set(requirement?.lanes ?? [])
    const candidates = [...this.snapshots.values()]
      .filter((snapshot) => !requirement?.class || snapshot.snapshotClass === requirement.class)
      .filter((snapshot) => {
        if (requestedLanes.size === 0) return true
        const snapshotLanes = new Set(snapshot.shards.map((shard) => shard.replicationLaneId))
        return snapshotLanes.size === requestedLanes.size &&
          [...requestedLanes].every((lane) => snapshotLanes.has(lane))
      })
      .sort((left, right) => right.capturedAt - left.capturedAt)
    const snapshot = candidates[0]
    return snapshot ?? null
  }

  private putSnapshot(snapshot: SyncSnapshotBundleWire): void { this.snapshots.set(snapshot.snapshotBundleId, snapshot) }

  private putBlob(syncSpaceId: string, chunk: SyncBlobChunk): SyncBlobPersistedAck | null {
    if (!/^[a-f0-9]{64}$/.test(chunk.hash)) throw new Error('BLOB_HASH invalid hash')
    if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0) {
      throw new Error('BLOB_SIZE invalid offset or size')
    }
    const expected = this.blobExpectedBytes.get(chunk.hash)
    if (expected != null && expected !== chunk.totalBytes) throw new Error('BLOB_SIZE total size changed')
    this.blobExpectedBytes.set(chunk.hash, chunk.totalBytes)
    if (chunk.restart && chunk.offset !== 0) throw new Error('BLOB_OFFSET restart must begin at zero')
    const wholeBlobRetry = chunk.offset === 0 && chunk.isFinal && chunk.bytes.byteLength === chunk.totalBytes
    const current = chunk.restart || wholeBlobRetry ? new Uint8Array() : this.blobs.get(chunk.hash) ?? new Uint8Array()
    if (chunk.offset !== current.length) throw new Error('Blob offset mismatch')
    const next = new Uint8Array(current.length + chunk.bytes.length)
    next.set(current)
    next.set(chunk.bytes, current.length)
    if (next.length > chunk.totalBytes) throw new Error('BLOB_SIZE exceeds declared size')
    if (chunk.isFinal) {
      if (next.length !== chunk.totalBytes) throw new Error('BLOB_SIZE incomplete final chunk')
      const hash = createHash('sha256').update(next).digest('hex')
      if (hash !== chunk.hash) throw new Error('BLOB_HASH content hash mismatch')
    }
    this.blobs.set(chunk.hash, next)
    if (!chunk.isFinal) return null
    const persistedAt = Date.now()
    this.blobPersistedAt.set(chunk.hash, persistedAt)
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncSpaceId,
      hash: chunk.hash,
      replicaId: 'memory-hub',
      totalBytes: chunk.totalBytes,
      persistedAt
    }
  }

  private blobStatus(hash: string): SyncBlobStatus | null {
    const totalBytes = this.blobExpectedBytes.get(hash)
    if (totalBytes == null) return null
    const bytes = this.blobs.get(hash) ?? new Uint8Array()
    const persistedAt = this.blobPersistedAt.get(hash) ?? null
    const complete = persistedAt != null
    if (complete && (bytes.byteLength !== totalBytes || createHash('sha256').update(bytes).digest('hex') !== hash)) {
      throw new Error('BLOB_HASH durable memory blob is corrupt')
    }
    return {
      hash,
      totalBytes,
      receivedBytes: bytes.byteLength,
      receivedPrefixSha256: createHash('sha256').update(bytes).digest('hex'),
      complete,
      replicaId: complete ? 'memory-hub' : null,
      persistedAt
    }
  }

  private getBlob(hash: string, range?: { offset: number; length?: number }): SyncBlobChunk {
    const bytes = this.blobs.get(hash)
    if (!bytes) throw new Error(`BLOB_MISSING ${hash}`)
    const offset = range?.offset ?? 0
    const end = range?.length == null ? bytes.length : Math.min(bytes.length, offset + range.length)
    return { hash, offset, totalBytes: bytes.length, bytes: bytes.slice(offset, end), isFinal: end >= bytes.length }
  }

  private acknowledge(deviceId: string, received: SyncCoverage, applied?: SyncCoverage, retained?: SyncCoverage): void {
    const current = this.acks.get(deviceId) ?? emptySyncCoverageVector()
    const normalized = normalizeSyncCoverage(received)
    this.acks.set(deviceId, {
      ...current,
      received: mergeCoverage(current.received, normalized),
      applied: mergeCoverage(current.applied, applied ?? {}),
      retained: mergeCoverage(current.retained, retained ?? {})
    })
  }

  private member(space: string, device: string): MemoryMember | null { return this.members.get(this.memberKey(space, device)) ?? null }
}

class MemoryEndpointSession implements SyncEndpointSession {
  constructor(private readonly hub: SyncMemoryHub, private readonly syncSpaceId: string, private readonly localDeviceId: string) {}

  async negotiateProtocolAndCapabilities(): Promise<SyncSessionNegotiation> {
    return { syncSpaceId: this.syncSpaceId, localDeviceId: this.localDeviceId, remoteDeviceId: 'memory-hub', capabilities: DEFAULT_CAPABILITIES, serverCursor: null }
  }

  async getRemoteStateVector(): Promise<SyncStateVectorResponse> {
    return { coverage: this.hub['coverage'](), policyByLane: defaultPolicies(), serverCursor: null }
  }

  async requestOperations(ranges: SyncRange[]): Promise<SyncOperationsPage> { return this.hub['getOperations'](ranges) }

  async pushOperations(batch: SyncOperationEnvelope[]): Promise<SyncOperationBatchResult> { return this.hub['putOperations'](batch) }

  async getLatestSnapshot(requirement?: { class?: SyncSnapshotBundleWire['snapshotClass']; lanes?: string[] }): Promise<SyncSnapshotBundleWire | null> { return this.hub['snapshot'](requirement) }

  async pushSnapshot(snapshot: SyncSnapshotBundleWire): Promise<void> { this.hub['putSnapshot'](snapshot) }

  async acceptRecoverySnapshot(_snapshotBundleId: string, _acceptance: SyncAuthProtocolObject): Promise<void> {
    return undefined
  }

  async getBlobStatus(hash: string): Promise<SyncBlobStatus | null> {
    return this.hub['blobStatus'](hash)
  }

  async fetchBlob(hash: string, range?: { offset: number; length?: number }): Promise<SyncBlobChunk> { return this.hub['getBlob'](hash, range) }

  async pushBlob(chunk: SyncBlobChunk): Promise<SyncBlobPersistedAck | null> {
    return this.hub['putBlob'](this.syncSpaceId, chunk)
  }

  async acknowledgeReceived(received: SyncCoverage, rejectedDigests?: string[]): Promise<void> {
    void rejectedDigests
    this.hub['acknowledge'](this.localDeviceId, received)
  }

  async reportAppliedCoverage(applied: SyncCoverage): Promise<void> { this.hub['acknowledge'](this.localDeviceId, {}, applied) }

  async reportRetainedCoverage(retained: SyncCoverage): Promise<void> { this.hub['acknowledge'](this.localDeviceId, {}, undefined, retained) }

  async close(): Promise<void> { return undefined }
}

function defaultPolicies(): Record<string, SyncReplicationPolicy> {
  return Object.fromEntries(DEFAULT_CAPABILITIES.replicationLanes.map((lane) => [lane, 'ENABLED']))
}

function mergeCoverage(left: SyncCoverage, right: SyncCoverage): SyncCoverage {
  const result: SyncCoverage = Object.fromEntries(Object.entries(left).map(([lane, actors]) => [lane, { ...actors }]))
  for (const [lane, actors] of Object.entries(right)) {
    result[lane] ??= {}
    for (const [actor, prefix] of Object.entries(actors)) result[lane]![actor] = Math.max(result[lane]![actor] ?? 0, prefix)
  }
  return result
}

function compareOperation(left: SyncOperationEnvelope, right: SyncOperationEnvelope): number {
  return left.replicationLaneId.localeCompare(right.replicationLaneId) || left.actorIncarnationId.localeCompare(right.actorIncarnationId) || left.sequence - right.sequence
}
