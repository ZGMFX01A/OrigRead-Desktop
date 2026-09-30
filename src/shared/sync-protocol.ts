import type { SyncOperationRecord, SyncReplicationLane, SyncSnapshotClass } from './sync-runtime'

/** Wire contract shared by LAN peers, the Durable Sync Peer and both client platforms. */
export const SYNC_PROTOCOL_VERSION = 1 as const
export const SYNC_PROTOCOL_ID = 'origread-sync-v1'

export type SyncProtocolVersion = typeof SYNC_PROTOCOL_VERSION

export interface SyncDot {
  actorIncarnationId: string
  replicationLaneId: string
  sequence: number
}

export interface SyncRange {
  actorIncarnationId: string
  replicationLaneId: string
  fromSequence: number
  toSequence: number
}

/** Coverage is a continuous prefix for every actor/lane, never a high-water guess. */
export type SyncCoverage = Record<string, Record<string, number>>

export interface SyncCoverageVector {
  received: SyncCoverage
  applied: SyncCoverage
  retained: SyncCoverage
  snapshot: SyncCoverage
  stableGc: SyncCoverage
}

export interface SyncOperationEnvelope {
  protocolVersion: SyncProtocolVersion
  operationId: string
  syncSpaceId: string
  authorDeviceId: string
  actorIncarnationId: string
  replicationLaneId: SyncReplicationLane | string
  sequence: number
  logicalClock: number
  causalContextJson: string
  dependencyDotsJson: string
  entityType: string
  entitySyncId: string
  entityGeneration: number
  operationType: string
  payloadSchemaVersion: number
  payloadJson: string
  schemaVersion: number
  authGrantId: string | null
  authEpoch: number | null
  createdWallClock: number
  payloadHash: string
  signingDigest: string
  authorSignature: string
  authorPublicKeySpkiBase64?: string
}

export interface SyncPeerCapabilities {
  protocolVersions: number[]
  replicationLanes: string[]
  snapshotClasses: SyncSnapshotClass[]
  blobTransfer: boolean
  maxOperationBatch: number
  maxBlobChunkBytes: number
  supportsRangeResume: boolean
  streamingSnapshots?: boolean
  blobRangeRequests?: boolean
  authStabilityCheckpoints?: boolean
}

export interface SyncDiscoveredPeer {
  endpointId: string
  deviceId: string
  displayName: string
  host: string
  port: number
  protocol: 'http' | 'https'
  interfaceName?: string
  localBindAddress?: string
  syncSpaceIds: string[]
  fingerprint: string | null
  capabilities: SyncPeerCapabilities | null
}

export interface SyncSessionNegotiation {
  syncSpaceId: string
  localDeviceId: string
  remoteDeviceId: string
  capabilities: SyncPeerCapabilities
  serverCursor?: SyncCursor | null
}

export interface SyncOperationsPage {
  operations: SyncOperationEnvelope[]
  nextCursor: string | null
  coverage: SyncCoverageVector
  serverCursor?: SyncCursor | null
}

export interface SyncOperationBatchResult {
  acceptedOperationIds: string[]
  duplicateOperationIds: string[]
  rejected: Array<{ operationId: string | null; code: string; message: string; rejectionDigest?: string }>
  coverage: SyncCoverageVector
  serverCursor?: SyncCursor | null
}

export interface SyncSnapshotShardWire {
  replicationLaneId: string
  frontierJson: string
  entityStateJson: string
  fieldVersionStateJson: string
  causalMetadataJson: string
  genesisCoverageJson: string
  deletionGenerationSummaryJson: string
  contentHash: string
  deletionSummaryJson?: string | null
  generationSummaryJson?: string | null
  blobManifestIndexJson?: string | null
  blobReferenceIndexJson?: string | null
}

export interface SyncSnapshotBundleWire {
  snapshotBundleId: string
  syncSpaceId: string
  snapshotClass: SyncSnapshotClass
  genesisBaselineId: string | null
  rootHash: string
  policyHash: string
  capturedAt: number
  shards: SyncSnapshotShardWire[]
  coverage: SyncCoverage
  /** v1 is the legacy join-hash; v2 is the R10 canonical manifest/shard hash. */
  hashSchemaVersion?: number
  schemaVersion?: number
  snapshotEpoch?: number
  crossDbCutId?: string | null
  requiredCoreShardIds?: string[]
  /** Bootstrap recovery snapshots must carry an explicit proof commitment. */
  coverageCommitment?: string | null
  authStabilityCheckpoint?: string | null
  authorDeviceId?: string | null
  authorSignature?: string | null
}

export interface SyncSnapshotShardDescriptorWire {
  replicationLaneId: string
  contentHash: string
  frontierJson: string
}

/** R11 transport-only descriptor; shardDescriptors preserve the signed shard array order. */
export interface SyncSnapshotStreamManifestWire {
  /** Transport lookup id only; deliberately excluded from the signed full Snapshot wire. */
  sourceSnapshotBundleId: string
  snapshotBundleId: string
  syncSpaceId: string
  snapshotClass: SyncSnapshotClass
  genesisBaselineId: string | null
  rootHash: string
  policyHash: string
  capturedAt: number
  shardDescriptors: SyncSnapshotShardDescriptorWire[]
  coverage: SyncCoverage
  hashSchemaVersion: number
  schemaVersion: number
  snapshotEpoch: number
  crossDbCutId: string | null
  requiredCoreShardIds: string[]
  coverageCommitment: string | null
  authStabilityCheckpoint: string | null
  authorDeviceId: string | null
  authorSignature: string | null
}

/** Signed AUTH-lane control objects. Registry rows are only a cache of these objects. */
export type SyncAuthObjectType =
  | 'SPACE_ROOT'
  | 'OWNER_TRANSFER'
  | 'OWNER_RECOVERY'
  | 'MEMBER_GRANT'
  | 'MEMBER_REVOKE'
  | 'AUTH_STABILITY_CHECKPOINT'

export interface SyncAuthProtocolObject {
  protocolVersion: SyncProtocolVersion
  authObjectId: string
  syncSpaceId: string
  authEpoch: number
  /** 全局严格连续单调自增序列号 (1, 2, 3...)，严禁空隙与乱序 */
  authSequence?: number
  objectType: SyncAuthObjectType
  authorDeviceId: string
  ownerDeviceId: string
  targetDeviceId?: string | null
  previousEpochFinalAcceptedPrefixByActorLane: SyncCoverage
  revokeCutoffByActorLane?: SyncCoverage | null
  payloadJson: string
  payloadHash: string
  signingDigest: string
  authorSignature: string
}

export interface SyncAuthLedgerPage {
  objects: SyncAuthProtocolObject[]
  authEpoch: number
  ownerDeviceId: string | null
  authStabilityCheckpointId: string | null
}

export type SyncReplicationPolicy = 'ENABLED' | 'PAUSED' | 'UNSUPPORTED' | 'LOCAL_PURGE'

export type SyncPolicyByLane = Record<string, SyncReplicationPolicy>

export interface SyncStateVectorResponse {
  coverage: SyncCoverageVector
  policyByLane: SyncPolicyByLane
  serverCursor?: SyncCursor | null
}

export interface SyncBlobChunk {
  hash: string
  offset: number
  totalBytes: number
  bytes: Uint8Array
  isFinal: boolean
  restart?: boolean
}

export interface SyncBlobStatus {
  hash: string
  totalBytes: number
  receivedBytes: number
  receivedPrefixSha256: string
  complete: boolean
  replicaId?: string | null
  persistedAt?: number | null
}

export interface SyncBlobManifest {
  hash: string
  totalBytes: number
  mediaType: string | null
  compression?: string | null
  encryptionInfoJson?: string | null
  availabilityPolicy?: string
  durability: 'CACHE' | 'REHYDRATABLE' | 'SYNC_DURABLE'
  referenceCount: number
}

export interface SyncPayloadBlobRef {
  field: string
  referenceKind: string
  manifest: SyncBlobManifest
}

export type SyncBlobAvailabilityState =
  | 'METADATA_READY'
  | 'BLOB_MISSING'
  | 'BLOB_FETCHING'
  | 'READY'
  | 'BLOB_FAILED'

export interface SyncBlobPersistedAck {
  protocolVersion: SyncProtocolVersion
  syncSpaceId: string
  hash: string
  replicaId: string
  totalBytes: number
  persistedAt: number
}

export interface SyncCursor {
  serverEpoch: string
  logOffset: number
  checkpointHash: string
}

export type SyncDiagnosticCode =
  | 'DISCOVERY_EMPTY'
  | 'PEER_UNREACHABLE'
  | 'TLS_PEER_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'AUTH_FAILED'
  | 'ROUTE_CONFLICT'
  | 'CURSOR_REWIND'
  | 'DOT_COLLISION'
  | 'INVALID_OPERATION'
  | 'AUTH_REVOKED'
  | 'SNAPSHOT_INCOMPATIBLE'
  | 'BASELINE_REQUIRED'
  | 'BLOB_MISSING'

export interface SyncDiagnostic {
  code: SyncDiagnosticCode
  message: string
  endpointId?: string
  retryable: boolean
  at: number
}

export interface SyncEndpointSession {
  negotiateProtocolAndCapabilities(): Promise<SyncSessionNegotiation>
  getAuthLedger?(): Promise<SyncAuthLedgerPage>
  pushAuthObjects?(objects: SyncAuthProtocolObject[]): Promise<SyncAuthLedgerPage>
  getRemoteStateVector(): Promise<SyncStateVectorResponse>
  requestOperations(ranges: SyncRange[], cursor?: SyncCursor | null): Promise<SyncOperationsPage>
  pushOperations(batch: SyncOperationEnvelope[]): Promise<SyncOperationBatchResult>
  getLatestSnapshot(requirement?: { class?: SyncSnapshotClass; lanes?: string[] }): Promise<SyncSnapshotBundleWire | null>
  pushSnapshot?(snapshot: SyncSnapshotBundleWire): Promise<void>
  getLatestSnapshotStreamManifest?(requirement?: { class?: SyncSnapshotClass; lanes?: string[] }): Promise<SyncSnapshotStreamManifestWire | null>
  fetchSnapshotStreamShard?(sourceSnapshotBundleId: string, lane: string): Promise<SyncSnapshotShardWire>
  pushSnapshotStreamManifest?(manifest: SyncSnapshotStreamManifestWire): Promise<void>
  pushSnapshotStreamShard?(snapshotBundleId: string, shard: SyncSnapshotShardWire): Promise<void>
  commitSnapshotStream?(snapshotBundleId: string): Promise<void>
  acceptRecoverySnapshot?(snapshotBundleId: string, acceptance: SyncAuthProtocolObject): Promise<void>
  getBlobStatus?(hash: string): Promise<SyncBlobStatus | null>
  fetchBlob(hash: string, range?: { offset: number; length?: number }): Promise<SyncBlobChunk>
  pushBlob?(chunk: SyncBlobChunk): Promise<SyncBlobPersistedAck | null>
  acknowledgeReceived(received: SyncCoverage, rejectedDigests?: string[]): Promise<void>
  reportAppliedCoverage?(applied: SyncCoverage): Promise<void>
  reportRetainedCoverage?(retained: SyncCoverage): Promise<void>
  close(): Promise<void>
}

export function emptySyncCoverage(): SyncCoverage {
  return {}
}

export function emptySyncCoverageVector(): SyncCoverageVector {
  return { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} }
}

export function cloneSyncCoverage(value: SyncCoverage): SyncCoverage {
  return Object.fromEntries(
    Object.entries(value).map(([lane, actors]) => [lane, Object.fromEntries(Object.entries(actors))])
  )
}

export function normalizeSyncCoverage(value: unknown): SyncCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Sync coverage')
  const result: SyncCoverage = {}
  for (const [lane, rawActors] of Object.entries(value as Record<string, unknown>)) {
    if (!lane.trim() || !rawActors || typeof rawActors !== 'object' || Array.isArray(rawActors)) {
      throw new Error(`Invalid Sync coverage lane: ${lane}`)
    }
    const actors: Record<string, number> = {}
    for (const [actor, prefix] of Object.entries(rawActors as Record<string, unknown>)) {
      if (!actor.trim() || typeof prefix !== 'number' || !Number.isSafeInteger(prefix) || prefix < 0) {
        throw new Error(`Invalid Sync coverage prefix for ${lane}/${actor}`)
      }
      if (prefix > 0) actors[actor] = prefix
    }
    if (Object.keys(actors).length > 0) result[lane] = actors
  }
  return result
}

export function coveragePrefix(coverage: SyncCoverage, lane: string, actor: string): number {
  return coverage[lane]?.[actor] ?? 0
}

export function mergeSyncCoverage(...coverages: SyncCoverage[]): SyncCoverage {
  const result: SyncCoverage = {}
  for (const coverage of coverages) {
    for (const [lane, actors] of Object.entries(coverage)) {
      for (const [actor, prefix] of Object.entries(actors)) {
        const current = coveragePrefix(result, lane, actor)
        if (prefix > current) {
          result[lane] ??= {}
          result[lane]![actor] = prefix
        }
      }
    }
  }
  return result
}

export function coverageDominates(left: SyncCoverage, right: SyncCoverage): boolean {
  for (const [lane, actors] of Object.entries(right)) {
    for (const [actor, prefix] of Object.entries(actors)) {
      if (coveragePrefix(left, lane, actor) < prefix) return false
    }
  }
  return true
}

export function missingSyncRanges(
  available: SyncCoverage,
  received: SyncCoverage,
  maxRangeLength = 1_000
): SyncRange[] {
  if (!Number.isSafeInteger(maxRangeLength) || maxRangeLength <= 0) throw new Error('maxRangeLength must be positive')
  const result: SyncRange[] = []
  for (const [lane, actors] of Object.entries(available).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [actor, maxPrefix] of Object.entries(actors).sort(([a], [b]) => a.localeCompare(b))) {
      const from = coveragePrefix(received, lane, actor) + 1
      if (from > maxPrefix) continue
      for (let start = from; start <= maxPrefix; start += maxRangeLength) {
        result.push({
          actorIncarnationId: actor,
          replicationLaneId: lane,
          fromSequence: start,
          toSequence: Math.min(maxPrefix, start + maxRangeLength - 1)
        })
      }
    }
  }
  return result
}

export function toSyncOperationEnvelope(operation: SyncOperationRecord, authorSignature?: string): SyncOperationEnvelope {
  if (!authorSignature && !operation.authorSignature) throw new Error(`Operation ${operation.operationId} is unsigned`)
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: operation.operationId,
    syncSpaceId: operation.syncSpaceId,
    authorDeviceId: operation.authorDeviceId,
    actorIncarnationId: operation.actorIncarnationId,
    replicationLaneId: operation.replicationLaneId,
    sequence: operation.sequence,
    logicalClock: operation.logicalClock,
    causalContextJson: operation.causalContextJson,
    dependencyDotsJson: operation.dependencyDotsJson,
    entityType: operation.entityType,
    entitySyncId: operation.entitySyncId,
    entityGeneration: operation.entityGeneration,
    operationType: operation.operationType,
    payloadSchemaVersion: operation.payloadSchemaVersion,
    payloadJson: operation.payloadJson,
    schemaVersion: operation.schemaVersion,
    authGrantId: operation.authGrantId,
    authEpoch: operation.authEpoch,
    createdWallClock: operation.createdWallClock,
    payloadHash: operation.payloadHash,
    signingDigest: operation.signingDigest,
    authorSignature: authorSignature ?? operation.authorSignature!
  }
}

export function operationDot(operation: Pick<SyncOperationEnvelope, 'actorIncarnationId' | 'replicationLaneId' | 'sequence'>): SyncDot {
  return {
    actorIncarnationId: operation.actorIncarnationId,
    replicationLaneId: operation.replicationLaneId,
    sequence: operation.sequence
  }
}
