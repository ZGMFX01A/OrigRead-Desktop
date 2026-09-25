import { readSnapshotInstallReady } from './sync-snapshot-install-journal'
import type {
  SyncBlobManifest,
  SyncCoverage,
  SyncCursor,
  SyncDiagnostic,
  SyncEndpointSession,
  SyncOperationEnvelope,
  SyncPeerCapabilities,
  SyncPolicyByLane,
  SyncSnapshotBundleWire
} from '../../shared/sync-protocol'
import {
  coverageDominates,
  mergeSyncCoverage,
  missingSyncRanges,
  toSyncOperationEnvelope
} from '../../shared/sync-protocol'
import { DesktopOperationBuilder } from './sync-operation-builder'
import { DesktopSyncOperationSigner } from './sync-operation-signer'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { SyncApplyCoordinator, type SyncIngestOptions } from './sync-apply-coordinator'
import {
  SyncLocalRecoverySnapshotRequiredError,
  type DesktopSnapshotInstallService
} from './desktop-snapshot-install-service'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import type { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import type { DesktopSyncStableGcCoordinator } from './sync-stable-gc-coordinator'
import {
  syncPayloadBlobRefs,
  SYNC_ARTICLE_FULL_CONTENT_FIELD,
  SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
} from './sync-blob-payload'
import { DesktopSyncBlobTransferCoordinator } from './sync-blob-transfer-coordinator'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import type { DesktopSyncBusinessApplier } from './desktop-sync-business-applier'
import {
  SYNC_REPLICATION_LANES,
  type SyncReplicationLane
} from '../../shared/sync-runtime'

import { SyncLocalLanePolicy } from './sync-local-lane-policy'

const KNOWN_REPLICATION_LANES = new Set<string>(SYNC_REPLICATION_LANES)

function knownReplicationLanes(values: readonly string[]): SyncReplicationLane[] {
  return values.filter((lane): lane is SyncReplicationLane => KNOWN_REPLICATION_LANES.has(lane))
}

export interface SyncSessionRunOptions extends Omit<SyncIngestOptions, 'now'> {
  localPolicyByLane?: SyncPolicyByLane
  endpointId?: string
  localAccountId?: number
  allowStableGc?: boolean
  maxOperations?: number
  maxBatches?: number
  now?: number
}

export interface SyncSessionRunResult {
  pushedOperationIds: string[]
  pulledOperationIds: string[]
  appliedOperationIds: string[]
  deferredOperationIds: string[]
  rejectedOperationIds: string[]
  diagnostics: SyncDiagnostic[]
  remotePolicyByLane: SyncPolicyByLane
  remoteCapabilities: SyncPeerCapabilities | null
}

/** Anti-entropy coordinator shared by LAN and Server sessions. */
export class SyncSessionCoordinator {
  private activeRun: Promise<void> = Promise.resolve()
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly operationBuilder: DesktopOperationBuilder,
    private readonly signer: DesktopSyncOperationSigner,
    private readonly apply: SyncApplyCoordinator,
    private readonly snapshotInstaller?: DesktopSnapshotInstallService,
    private readonly blobTransfer?: DesktopSyncBlobTransferCoordinator,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
    private readonly businessApplier?: DesktopSyncBusinessApplier,
    private readonly genesisSnapshotService?: DesktopGenesisSnapshotService,
    private readonly stableGcCoordinator?: DesktopSyncStableGcCoordinator,
    private readonly reconcileExternalConfig?: (syncSpaceId: string) => void
  ) {}

  run(syncSpaceId: string, session: SyncEndpointSession, options: SyncSessionRunOptions): Promise<SyncSessionRunResult> {
    const result = this.activeRun.then(() => this.runInternal(syncSpaceId, session, options))
    this.activeRun = result.then(() => undefined, () => undefined)
    return result
  }

  private async runInternal(syncSpaceId: string, session: SyncEndpointSession, options: SyncSessionRunOptions): Promise<SyncSessionRunResult> {
    const now = options.now ?? Date.now()
    const blobState = new DesktopSyncBlobStateService(this.runtime.databaseHandle())
    const localPolicy = { ...new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId), ...options.localPolicyByLane }
    for (const lane of ['CORE_META', 'AUTH'] as const) {
      if (localPolicy[lane] != null && localPolicy[lane] !== 'ENABLED') {
        throw new Error('Required Sync core lane cannot be disabled by local policy: ' + lane)
      }
    }
    let maxOperations = options.maxOperations ?? 500
    const maxBatches = options.maxBatches ?? 20
    if (!Number.isSafeInteger(maxOperations) || maxOperations <= 0 || !Number.isSafeInteger(maxBatches) || maxBatches <= 0) throw new Error('Invalid sync batch limit')

    const negotiation = await session.negotiateProtocolAndCapabilities()
    if (negotiation.syncSpaceId !== syncSpaceId) {
      throw new Error('Sync session negotiated a different Sync Space')
    }

    if (!negotiation.capabilities.protocolVersions.includes(1)) throw new Error('Unsupported sync protocol')
    for (const lane of ['CORE_META', 'AUTH'] as const) {
      if (!negotiation.capabilities.replicationLanes.includes(lane)) {
        throw new Error('Remote endpoint does not support required Sync core lane: ' + lane)
      }
    }
    if (!Number.isSafeInteger(negotiation.capabilities.maxOperationBatch) || negotiation.capabilities.maxOperationBatch <= 0) throw new Error('Invalid remote operation batch limit')
    maxOperations = Math.min(maxOperations, negotiation.capabilities.maxOperationBatch)

    const exchangeAuth = async (): Promise<void> => {
      if (Boolean(session.getAuthLedger) !== Boolean(session.pushAuthObjects)) throw new Error('Incomplete AUTH endpoint')
      if (session.getAuthLedger && session.pushAuthObjects) {
        const auth = new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
        auth.append(syncSpaceId, (await session.getAuthLedger()).objects, now)
        const local = this.runtime.listAuthObjects(syncSpaceId)
        if (!local.length) throw new Error('AUTH_FAILED: confirmed Space root and device grant are required')
        auth.append(syncSpaceId, (await session.pushAuthObjects(local)).objects, now)
      }
    }
    await exchangeAuth()

    const preflightAppliedOperationIds: string[] = []
    const preflightDeferredOperationIds: string[] = []
    while (true) {
      const applied = this.apply.applyPending(syncSpaceId, maxOperations, now, localPolicy)
      preflightAppliedOperationIds.push(...applied.appliedOperationIds)
      preflightDeferredOperationIds.push(...applied.deferredOperationIds)
      if (applied.failedOperationIds.length > 0) {
        throw new Error('Sync preflight business application failed')
      }
      if (applied.appliedOperationIds.length === 0) break
    }
    this.reconcileExternalConfig?.(syncSpaceId)

    const readRemoteState = async () => {
      const state = await session.getRemoteStateVector()
      const policyByLane = { ...state.policyByLane }
      for (const lane of ['CORE_META', 'AUTH'] as const) {
        if (policyByLane[lane] != null && policyByLane[lane] !== 'ENABLED') {
          throw new Error('Remote endpoint disabled required Sync core lane: ' + lane)
        }
      }
      for (const [lane, policy] of Object.entries(localPolicy)) {
        if (policy !== 'ENABLED') policyByLane[lane] = policy
      }
      for (const lane of ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH']) {
        if (!negotiation.capabilities.replicationLanes.includes(lane)) policyByLane[lane] = 'PAUSED'
      }
      return { ...state, policyByLane }
    }
    let remoteState = await readRemoteState()

    const pushedOperationIds: string[] = []
    const pulledOperationIds: string[] = []
    const appliedOperationIds: string[] = [...preflightAppliedOperationIds]
    const deferredOperationIds: string[] = [...preflightDeferredOperationIds]
    const rejectedOperationIds: string[] = []
    const diagnostics: SyncDiagnostic[] = []

    const uploadReferencedBlobs = async (operations: readonly SyncOperationEnvelope[]): Promise<void> => {
      const transferred = new Set<string>()
      for (const operation of operations) {
        if (!laneIsEnabled(remoteState.policyByLane, operation.replicationLaneId)) continue
        for (const reference of syncPayloadBlobRefs(operation.payloadJson)) {
          if (transferred.has(reference.manifest.hash)) continue
          transferred.add(reference.manifest.hash)
          if (!negotiation.capabilities.blobTransfer || !this.blobTransfer || !this.localBlobStore) {
            throw new Error('Remote endpoint or local runtime does not support required Blob transfer')
          }
          const bytes = this.localBlobStore.readVerified(reference.manifest.hash)
          if (!bytes || bytes.byteLength !== reference.manifest.totalBytes) {
            throw new Error('Local operation references an unavailable Blob')
          }
          await this.blobTransfer.upload(
            syncSpaceId,
            reference.manifest,
            bytes,
            session,
            remoteState.policyByLane,
            Math.max(1, negotiation.capabilities.maxBlobChunkBytes),
            now
          )
        }
      }
    }

    const fetchReferencedBlobs = async (operations: readonly SyncOperationEnvelope[]): Promise<void> => {
      const transferred = new Set<string>()
      for (const operation of operations) {
        if (!laneIsEnabled(remoteState.policyByLane, operation.replicationLaneId)) continue
        if (operation.schemaVersion !== 1 || operation.payloadSchemaVersion !== 1 ||
          !['UPSERT', 'FIELD_SET', 'RELATION_SET', 'GLOBAL_DELETE'].includes(operation.operationType)) continue
        for (const reference of syncPayloadBlobRefs(operation.payloadJson)) {
          if (
            this.businessApplier &&
            !this.businessApplier.shouldFetchBlob(
              operation.syncSpaceId,
              operation.entityType,
              operation.entitySyncId,
              operation.entityGeneration,
              reference
            )
          ) continue
          if (transferred.has(reference.manifest.hash)) continue
          transferred.add(reference.manifest.hash)
          if (this.localBlobStore?.readVerified(reference.manifest.hash)) continue
          const canApplyWithoutBlob =
            this.businessApplier?.canApplyWithoutBlob(operation.entityType, reference.referenceKind) ?? false
          if (!negotiation.capabilities.blobTransfer || !this.blobTransfer || !this.localBlobStore) {
            if (canApplyWithoutBlob) continue
            throw new Error('Remote endpoint or local runtime does not support required Blob transfer')
          }
          try {
            await this.blobTransfer.fetch(
              syncSpaceId,
              reference.manifest,
              session,
              remoteState.policyByLane,
              (bytes) => {
                if (this.businessApplier) {
                  this.businessApplier.persistFetchedBlob(
                    operation.syncSpaceId,
                    operation.entityType,
                    operation.entitySyncId,
                    operation.entityGeneration,
                    reference.referenceKind,
                    reference.manifest,
                    bytes
                  )
                } else {
                  this.localBlobStore!.putVerified(reference.manifest.hash, bytes)
                }
              },
              Math.max(1, negotiation.capabilities.maxBlobChunkBytes),
              now
            )
          } catch (error) {
            transferred.delete(reference.manifest.hash)
            if (!canApplyWithoutBlob) throw error
          }
        }
      }
    }

    const fetchPendingReferencedBlobs = async (): Promise<void> => {
      const pending = this.state.listPendingInbox(syncSpaceId, maxOperations,
        Object.keys(remoteState.policyByLane).filter((lane) => !laneIsEnabled(remoteState.policyByLane, lane)))
      if (pending.length === 0) return
      const operations = pending.map((inbox) => {
        try {
          return JSON.parse(inbox.operationJson) as SyncOperationEnvelope
        } catch (error) {
          throw new Error(
            'Stored pending operation is not valid JSON: ' +
            (error instanceof Error ? error.message : String(error))
          )
        }
      })
      await fetchReferencedBlobs(operations)
    }

    const fetchSnapshotBlobs = async (
      snapshot: SyncSnapshotBundleWire,
      selectedLanes: ReadonlySet<string>
    ): Promise<void> => {
      const transferred = new Set<string>()
      for (const shard of snapshot.shards) {
        if (!selectedLanes.has(shard.replicationLaneId)) continue
        let manifests: SyncBlobManifest[]
        let references: Array<{
          replicationLaneId: string
          ownerEntityType: string
          ownerEntitySyncId: string
          ownerEntityGeneration: number
          referenceKind: string
          hash: string
        }>
        try {
          const rawManifests = JSON.parse(shard.blobManifestIndexJson ?? '[]') as unknown
          const rawReferences = JSON.parse(shard.blobReferenceIndexJson ?? '[]') as unknown
          if (!Array.isArray(rawManifests) || !Array.isArray(rawReferences)) {
            throw new Error('Snapshot Blob indexes must be arrays')
          }
          manifests = rawManifests as SyncBlobManifest[]
          references = rawReferences as Array<{
            replicationLaneId: string
            ownerEntityType: string
            ownerEntitySyncId: string
            ownerEntityGeneration: number
            referenceKind: string
            hash: string
          }>
        } catch (error) {
          throw new Error(
            'REBASE_UNSAFE: invalid Snapshot Blob indexes in lane ' + shard.replicationLaneId + ': ' +
            (error instanceof Error ? error.message : String(error))
          )
        }
        const hashes = new Set(manifests.map((manifest) => manifest.hash))
        for (const reference of references) {
          if (reference.replicationLaneId !== shard.replicationLaneId || !hashes.has(reference.hash)) {
            throw new Error('REBASE_UNSAFE: Snapshot Blob reference is not covered by its shard manifest')
          }
        }
        for (const manifest of manifests) {
          if (transferred.has(manifest.hash)) continue
          const owners = references.filter((reference) => reference.hash === manifest.hash)
          const fetchOwners = this.businessApplier
            ? owners.filter((reference) => this.businessApplier!.shouldFetchBlob(
                syncSpaceId,
                reference.ownerEntityType,
                reference.ownerEntitySyncId,
                reference.ownerEntityGeneration,
                {
                  field: reference.referenceKind === SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
                    ? SYNC_ARTICLE_FULL_CONTENT_FIELD
                    : reference.referenceKind,
                  referenceKind: reference.referenceKind,
                  manifest
                }
              ))
            : owners
          if (owners.length > 0 && fetchOwners.length === 0) continue
          const canApplyWithoutBlob = fetchOwners.length > 0 &&
            fetchOwners.every((reference) =>
              this.businessApplier?.canApplyWithoutBlob(reference.ownerEntityType, reference.referenceKind) === true
            )
          transferred.add(manifest.hash)
          if (this.localBlobStore?.readVerified(manifest.hash)) continue
          if (!negotiation.capabilities.blobTransfer || !this.blobTransfer || !this.localBlobStore) {
            if (canApplyWithoutBlob) continue
            throw new Error('REBASE_UNSAFE: required Snapshot Blob transfer is unavailable')
          }
          try {
            await this.blobTransfer.fetch(
              syncSpaceId,
              manifest,
              session,
              remoteState.policyByLane,
              (bytes) => {
                if (this.businessApplier && fetchOwners.length > 0) {
                  for (const reference of fetchOwners) {
                    this.businessApplier.persistFetchedBlob(
                      syncSpaceId,
                      reference.ownerEntityType,
                      reference.ownerEntitySyncId,
                      reference.ownerEntityGeneration,
                      reference.referenceKind,
                      manifest,
                      bytes
                    )
                  }
                } else {
                  this.localBlobStore!.putVerified(manifest.hash, bytes)
                }
              },
              Math.max(1, negotiation.capabilities.maxBlobChunkBytes),
              now
            )
          } catch (error) {
            transferred.delete(manifest.hash)
            if (!canApplyWithoutBlob) throw error
          }
        }
      }
    }

    const uploadSnapshotBlobs = async (
      snapshot: SyncSnapshotBundleWire,
      selectedLanes: ReadonlySet<string>
    ): Promise<void> => {
      const transferred = new Set<string>()
      for (const shard of snapshot.shards) {
        if (!selectedLanes.has(shard.replicationLaneId)) continue
        let manifests: SyncBlobManifest[]
        let references: Array<{
          replicationLaneId: string
          ownerEntityType: string
          ownerEntitySyncId: string
          ownerEntityGeneration: number
          referenceKind: string
          hash: string
        }>
        try {
          const rawManifests = JSON.parse(shard.blobManifestIndexJson ?? '[]') as unknown
          const rawReferences = JSON.parse(shard.blobReferenceIndexJson ?? '[]') as unknown
          if (!Array.isArray(rawManifests) || !Array.isArray(rawReferences)) {
            throw new Error('Snapshot Blob indexes must be arrays')
          }
          manifests = rawManifests as SyncBlobManifest[]
          references = rawReferences as Array<{
            replicationLaneId: string
            ownerEntityType: string
            ownerEntitySyncId: string
            ownerEntityGeneration: number
            referenceKind: string
            hash: string
          }>
        } catch (error) {
          throw new Error(
            'REBASE_UNSAFE: invalid local Snapshot Blob indexes in lane ' + shard.replicationLaneId + ': ' +
            (error instanceof Error ? error.message : String(error))
          )
        }
        const manifestsByHash = new Map(manifests.map((manifest) => [manifest.hash, manifest]))
        for (const reference of references) {
          if (reference.replicationLaneId !== shard.replicationLaneId || !manifestsByHash.has(reference.hash)) {
            throw new Error('REBASE_UNSAFE: local Snapshot Blob reference is not covered by its shard manifest')
          }
        }
        for (const manifest of manifests) {
          if (transferred.has(manifest.hash)) continue
          transferred.add(manifest.hash)
          const owners = references.filter((reference) => reference.hash === manifest.hash)
          if (!owners.length) continue

          const remoteStatus = negotiation.capabilities.blobTransfer && session.getBlobStatus
            ? await session.getBlobStatus(manifest.hash)
            : null
          const alreadyDurable = remoteStatus != null &&
            remoteStatus.hash === manifest.hash &&
            remoteStatus.totalBytes === manifest.totalBytes &&
            remoteStatus.complete &&
            remoteStatus.receivedBytes === manifest.totalBytes &&
            remoteStatus.receivedPrefixSha256 === manifest.hash &&
            Boolean(remoteStatus.replicaId) &&
            remoteStatus.persistedAt != null
          if (alreadyDurable) continue

          const bytes = this.localBlobStore?.readVerified(manifest.hash) ?? null
          if (!bytes) {
            if (manifest.durability === 'SYNC_DURABLE') {
              throw new Error('REBASE_UNSAFE: durable Snapshot Blob ' + manifest.hash + ' has no recoverable replica')
            }
            continue
          }
          if (!negotiation.capabilities.blobTransfer || !this.blobTransfer || !session.pushBlob) {
            if (manifest.durability === 'SYNC_DURABLE') {
              throw new Error('REBASE_UNSAFE: endpoint cannot persist durable Snapshot Blob ' + manifest.hash)
            }
            continue
          }
          await this.blobTransfer.upload(
            syncSpaceId,
            manifest,
            bytes,
            session,
            remoteState.policyByLane,
            Math.max(1, negotiation.capabilities.maxBlobChunkBytes),
            now
          )
        }
      }
    }

    const retryMissingAppliedBlobs = async (): Promise<void> => {
      if (!this.businessApplier) return
      for (const candidate of blobState.listRetryableReferencedBlobs(syncSpaceId, maxOperations)) {
        const owners = candidate.references.filter((reference) =>
          laneIsEnabled(remoteState.policyByLane, reference.replicationLaneId) &&
          this.businessApplier!.shouldRefillReferencedBlob(
            syncSpaceId,
            reference.ownerEntityType,
            reference.ownerEntitySyncId,
            reference.ownerEntityGeneration,
            reference.referenceKind
          )
        )
        if (!owners.length) continue
        const localBytes = this.localBlobStore?.readVerified(candidate.manifest.hash) ?? null
        if (localBytes && localBytes.byteLength === candidate.manifest.totalBytes) {
          for (const owner of owners) {
            this.businessApplier.persistAndMaterializeFetchedBlob(
              syncSpaceId,
              owner.ownerEntityType,
              owner.ownerEntitySyncId,
              owner.ownerEntityGeneration,
              owner.referenceKind,
              candidate.manifest,
              localBytes
            )
          }
          blobState.markReadyVerified(candidate.manifest.hash, candidate.manifest.totalBytes, now)
          continue
        }
        if (!negotiation.capabilities.blobTransfer || !this.blobTransfer || !this.localBlobStore) continue
        try {
          await this.blobTransfer.fetch(
            syncSpaceId,
            candidate.manifest,
            session,
            remoteState.policyByLane,
            (bytes) => {
              for (const owner of owners) {
                this.businessApplier!.persistAndMaterializeFetchedBlob(
                  syncSpaceId,
                  owner.ownerEntityType,
                  owner.ownerEntitySyncId,
                  owner.ownerEntityGeneration,
                  owner.referenceKind,
                  candidate.manifest,
                  bytes
                )
              }
            },
            Math.max(1, negotiation.capabilities.maxBlobChunkBytes),
            now
          )
        } catch {
          // Metadata stays materialized; a later endpoint/session can recover the attachment.
        }
      }
    }

    // 综合覆盖度：结合本地接收库与本地自产签名操作的前缀，消除假截断
    const getLocalCoverage = (): SyncCoverage => {
      const stateCoverage = this.state.getCoverage(syncSpaceId).received
      const signedCoverage = this.runtime.getSignedCoverage(syncSpaceId)
      return mergeSyncCoverage(stateCoverage, signedCoverage)
    }

    const pushMissing = async (): Promise<void> => {
      let received = remoteState.coverage.received
      // Receipt IDs are valid only for this particular server history.
      const acknowledged = new Set<string>()
      for (let prepared = 0; ; prepared++) {
        const pendingBuild = this.runtime.listPendingOutbox(syncSpaceId, 1).length
        const pendingSign = this.runtime.listOperationsByStatus(syncSpaceId, 'AWAITING_SIGNATURE', 1).length
        if (!pendingBuild && !pendingSign) break
        if (prepared >= maxBatches) throw new Error('Sync preparation batch budget exhausted; retry to continue')
        this.operationBuilder.buildPending(syncSpaceId, maxOperations, now)
        this.signer.signPending(syncSpaceId, maxOperations, now)
      }
      if (new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
        .issueStabilityCheckpoint(syncSpaceId, this.signer, now)) await exchangeAuth()
      for (let batch = 0; ; batch++) {
        const records = this.runtime.listPushableOperations(syncSpaceId, received, maxOperations,
          (operation) => laneIsEnabled(remoteState.policyByLane, operation.replicationLaneId) && !acknowledged.has(operation.operationId))
        if (!records.length) return
        if (batch >= maxBatches) throw new Error('Sync push batch budget exhausted; retry to continue')
        const envelopes = records.map((operation) => toSyncOperationEnvelope(operation))
        await uploadReferencedBlobs(envelopes)
        const result = await session.pushOperations(envelopes)
        const expected = new Set(records.map((operation) => operation.operationId))
        const receipts = [...result.acceptedOperationIds, ...result.duplicateOperationIds]
        if (receipts.some((id) => !expected.has(id))) throw new Error('Remote acknowledged an operation outside the batch')
        if (result.rejected.length || records.some((operation) => !receipts.includes(operation.operationId))) {
          throw new Error('Remote did not durably acknowledge the complete batch')
        }
        for (const id of receipts) {
          acknowledged.add(id)
          pushedOperationIds.push(id)
        }
        if (result.coverage?.received) received = result.coverage.received
      }
    }

    const pushLocalRecoverySnapshot = async (
      localAccountId: number,
      targetSnapshot?: SyncSnapshotBundleWire
    ): Promise<void> => {
      if (!this.genesisSnapshotService || !session.pushSnapshot || !session.acceptRecoverySnapshot) {
        throw new Error('REBASE_UNSAFE: LocalRecoverySnapshot transport is not configured')
      }
      const recoveryCut = this.genesisSnapshotService.run(localAccountId, syncSpaceId, undefined, now)
      const selectedLanes = new Set<SyncReplicationLane>(
        knownReplicationLanes(negotiation.capabilities.replicationLanes)
          .filter((lane) => laneIsEnabled(remoteState.policyByLane, lane))
      )
      const selectedLaneNames = new Set<string>(selectedLanes)
      let recoveryBundleId = recoveryCut.snapshotBundleId
      let recoveryPreview = this.genesisSnapshotService.exportWire(
        recoveryCut.snapshotBundleId,
        selectedLanes
      )
      let verifiedTargetCoverage: SyncCoverage = {}
      if (targetSnapshot) {
        verifiedTargetCoverage = Object.fromEntries(
          Object.entries(filterCoverageByPolicy(targetSnapshot.coverage, remoteState.policyByLane))
            .filter(([lane]) => selectedLaneNames.has(lane))
        ) as SyncCoverage
        if (!coverageDominates(recoveryPreview.coverage, verifiedTargetCoverage)) {
          recoveryPreview = this.genesisSnapshotService.mergeRecoverySnapshot(
            recoveryBundleId,
            targetSnapshot,
            selectedLanes,
            now
          )
          recoveryBundleId = recoveryPreview.snapshotBundleId
        }
        const scopedTarget = Object.fromEntries(
          Object.entries(verifiedTargetCoverage)
            .filter(([lane]) => selectedLaneNames.has(lane))
        ) as SyncCoverage
        if (!coverageDominates(recoveryPreview.coverage, scopedTarget)) {
          throw new Error(
            'REBASE_UNSAFE: causal LocalRecoverySnapshot merge did not dominate the target Snapshot'
          )
        }
      }
      // Genesis may have built post-cut Outbox rows. Sign and push them before accepting the
      // Snapshot. If the Server still retains every covered Dot, a normal signed Snapshot is
      // sufficient; only a real history gap may enter BOOTSTRAP_RECOVERY.
      await pushMissing()
      remoteState = await readRemoteState()
      if (coverageDominates(
        filterCoverageByPolicy(remoteState.coverage.retained, remoteState.policyByLane),
        recoveryPreview.coverage
      )) {
        await uploadSnapshotBlobs(recoveryPreview, selectedLanes)
        await session.pushSnapshot(recoveryPreview)
        return
      }
      if (!negotiation.capabilities.snapshotClasses.includes('BOOTSTRAP_RECOVERY')) {
        throw new Error('REBASE_UNSAFE: endpoint cannot accept a recovery Snapshot for rewound history')
      }
      const acceptance = new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
        .issueStabilityCheckpoint(
          syncSpaceId,
          this.signer,
          now,
          recoveryPreview.snapshotBundleId,
          targetSnapshot ? verifiedTargetCoverage : undefined
        )
      if (!acceptance) {
        throw new Error('REBASE_UNSAFE: current device is not OWNER for LocalRecoverySnapshot acceptance')
      }
      await exchangeAuth()
      const recoveryWire = this.genesisSnapshotService.promoteToBootstrapRecovery(
        recoveryBundleId,
        acceptance.authObjectId,
        now,
        selectedLanes
      )
      await uploadSnapshotBlobs(recoveryWire, selectedLanes)
      await session.pushSnapshot(recoveryWire)
      await session.acceptRecoverySnapshot(recoveryWire.snapshotBundleId, acceptance)
    }

    await pushMissing()

    const drainApplied = (): void => {
      while (true) {
        const applied = this.apply.applyPending(syncSpaceId, maxOperations, now, remoteState.policyByLane)
        appliedOperationIds.push(...applied.appliedOperationIds)
        deferredOperationIds.push(...applied.deferredOperationIds)
        if (applied.failedOperationIds.length > 0) throw new Error('Sync business application failed')
        if (applied.appliedOperationIds.length === 0) break
      }
    }
    await fetchPendingReferencedBlobs()
    drainApplied()
    // 2. 拉取循环（Pull Loop）：支持分批拉取与 Cursor / History Rewind 自愈
    let pullBatchCount = 0
    let rewindCount = 0
    const previousBinding = this.runtime.findBindingBySpace(syncSpaceId)
    let stagedSnapshotBundleId: string | null = previousBinding?.lifecycleState === 'STAGING'
      ? readSnapshotInstallReady(this.runtime.databaseHandle(), syncSpaceId)?.snapshotBundleId ?? null : null
    let currentCursor: SyncCursor | null = options.endpointId ? this.state.readCursor(options.endpointId, syncSpaceId) : null

    while (pullBatchCount < maxBatches) {
      pullBatchCount++
      const localCoverage = getLocalCoverage()
      const ranges = missingSyncRanges(
        filterCoverageByPolicy(remoteState.coverage.retained, remoteState.policyByLane),
        localCoverage,
        maxOperations
      )

      const needsBaseline = ranges.length === 0 && missingSyncRanges(
        filterCoverageByPolicy(remoteState.coverage.snapshot, remoteState.policyByLane),
        localCoverage, maxOperations
      ).length > 0
      if (ranges.length === 0 && !needsBaseline) break

      let page
      try {
        if (needsBaseline) throw new Error('BASELINE_REQUIRED: remote history is only available as a snapshot')
        page = await session.requestOperations(ranges, currentCursor)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const isBaselineRequired = message.includes('BASELINE_REQUIRED')
        const isRewind = isBaselineRequired || message.includes('SERVER_HISTORY_REWIND') || message.includes('CURSOR_REWIND')
        if (isRewind) {
          diagnostics.push({
            code: isBaselineRequired ? 'BASELINE_REQUIRED' : 'CURSOR_REWIND',
            message: `Server history rewind / baseline required detected: ${message}`,
            retryable: true,
            at: now
          })
          currentCursor = null
          if (options.endpointId) {
            this.state.saveCursor(options.endpointId, syncSpaceId, null, now)
          }

          if (isBaselineRequired) {
            if (options.localAccountId == null) {
              throw new Error('REBASE_UNSAFE: baseline recovery requires a local account')
            }
            if (!session.getLatestSnapshot) {
              throw new Error('REBASE_UNSAFE: endpoint cannot provide a baseline Snapshot')
            }
            const lanes = knownReplicationLanes(negotiation.capabilities.replicationLanes)
              .filter((lane) => laneIsEnabled(remoteState.policyByLane, lane))
            const snapshot = await session.getLatestSnapshot({ class: 'GC_BASELINE', lanes })
              ?? await session.getLatestSnapshot({ class: 'WORKING', lanes })
            if (!snapshot) {
              // A restored/empty Server can lose both retained history and every Snapshot.
              // Re-publish the client's durable state through the normal/recovery trust path
              // instead of requiring the rewound Server to provide data it no longer has.
              await pushLocalRecoverySnapshot(options.localAccountId)
            } else {
              if (!this.snapshotInstaller) {
                throw new Error('REBASE_UNSAFE: authenticated Snapshot installer is not configured')
              }
              const manifestLanes = new Set(snapshot.shards.map((shard) => shard.replicationLaneId))
              const selectedLanes = new Set(lanes)
              if (snapshot.syncSpaceId !== syncSpaceId || [...selectedLanes].some((lane) => !manifestLanes.has(lane))) {
                throw new Error('REBASE_UNSAFE: Snapshot is outside the negotiated space or lane policy')
              }
              try {
                await fetchSnapshotBlobs(snapshot, selectedLanes)
                const installResult = this.snapshotInstaller.install(options.localAccountId, snapshot, now, selectedLanes)
                stagedSnapshotBundleId = installResult.snapshotBundleId
              } catch (installError) {
                if (installError instanceof SyncLocalRecoverySnapshotRequiredError) {
                  await pushLocalRecoverySnapshot(options.localAccountId, snapshot)
                } else {
                  throw new Error(
                    'REBASE_UNSAFE: baseline Snapshot installation failed: ' +
                    (installError instanceof Error ? installError.message : String(installError))
                  )
                }
              }
            }
          }

          if (++rewindCount > 2) throw new Error('Server history repeatedly rewound during sync')
          await exchangeAuth()
          remoteState = await readRemoteState()
          await pushMissing()
          if (!isBaselineRequired && options.allowStableGc === true) {
            if (options.localAccountId == null || !this.genesisSnapshotService) {
              throw new Error('REBASE_UNSAFE: Server rewind recovery requires local Snapshot context')
            }
            await pushLocalRecoverySnapshot(options.localAccountId)
          }
          continue
        }
        throw error
      }

      if (page.operations.length === 0) {
        throw new Error('Remote retained coverage contains unavailable operations')
      }
      if (!page.operations.every((op) => op.syncSpaceId === syncSpaceId && ranges.some((range) =>
        range.actorIncarnationId === op.actorIncarnationId && range.replicationLaneId === op.replicationLaneId &&
        op.sequence >= range.fromSequence && op.sequence <= range.toSequence))) throw new Error('Operation page is outside requested space or ranges')

      pulledOperationIds.push(...page.operations.map((op) => op.operationId))
      const ingest = this.apply.ingest(page.operations, { resolvePeerKey: options.resolvePeerKey, now })
      if (ingest.rejected.some((item) => !item.rejectionDigest)) throw new Error('Operation page contains unauthenticated or invalid data')
      currentCursor = page.serverCursor ?? null
      if (options.endpointId && currentCursor) {
        this.state.saveCursor(options.endpointId, syncSpaceId, currentCursor, now)
      }
      // Cursor/Received acknowledge durable metadata independently of optional Blob availability.
      await session.acknowledgeReceived(this.apply.getCoverage(syncSpaceId).received,
        ingest.rejected.map((item) => item.rejectionDigest).filter((value): value is string => Boolean(value)))
      await fetchReferencedBlobs(page.operations.filter((operation) => this.state.findInbox(operation.operationId)?.state !== 'REJECTED'))

      for (const rej of ingest.rejected) {
        if (rej.operationId) rejectedOperationIds.push(rej.operationId)
      }
      diagnostics.push(...ingest.diagnostics)

      // 循环应用所有就绪的 pending 操作，直到无更多可连续应用的条目
      if (new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
        .issueStabilityCheckpoint(syncSpaceId, this.signer, now)) await exchangeAuth()
      drainApplied()

      const localState = this.state.getCoverage(syncSpaceId)
      await session.reportAppliedCoverage?.(localState.applied)
      await session.reportRetainedCoverage?.(localState.retained)

      if (JSON.stringify(getLocalCoverage()) === JSON.stringify(localCoverage)) throw new Error('Sync pull made no coverage progress')
    }

    if (missingSyncRanges(filterCoverageByPolicy(remoteState.coverage.retained, remoteState.policyByLane), getLocalCoverage(), 1).length) throw new Error('Sync pull batch budget exhausted; retry to continue')
    drainApplied()
    if (stagedSnapshotBundleId) {
      const pausedLanes = Object.keys(remoteState.policyByLane).filter((lane) => !laneIsEnabled(remoteState.policyByLane, lane))
      if (this.state.listPendingInbox(syncSpaceId, 1, pausedLanes).length) {
        throw new Error('REBASE_UNSAFE: Snapshot Tail still contains deferred operations')
      }
      if (options.localAccountId == null || !this.snapshotInstaller) {
        throw new Error('REBASE_UNSAFE: Snapshot activation context is unavailable')
      }
      this.snapshotInstaller.activateAfterTail(options.localAccountId, stagedSnapshotBundleId, now, pausedLanes)
    }

    await retryMissingAppliedBlobs()

    if (
      options.allowStableGc === true &&
      options.localAccountId != null &&
      this.genesisSnapshotService &&
      this.stableGcCoordinator &&
      negotiation.capabilities.snapshotClasses.includes('GC_BASELINE') &&
      ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AUTH'].every(
        (lane) => negotiation.capabilities.replicationLanes.includes(lane) &&
          laneIsEnabled(remoteState.policyByLane, lane)
      )
    ) {
      const working = this.genesisSnapshotService.run(
        options.localAccountId,
        syncSpaceId,
        undefined,
        now
      )
      // Push the post-cut tail first; it stays outside this baseline.
      await pushMissing()
      const auth = new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
      const issued = auth.issueStabilityCheckpoint(syncSpaceId, this.signer, now)
      if (issued) await exchangeAuth()
      const checkpointId = issued?.authObjectId ?? [...this.runtime.listAuthObjects(syncSpaceId)]
        .reverse()
        .find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')
        ?.authObjectId
      if (checkpointId) {
        const selectedLanes = new Set<SyncReplicationLane>(
          knownReplicationLanes(negotiation.capabilities.replicationLanes)
            .filter((lane) => laneIsEnabled(remoteState.policyByLane, lane))
        )
        const coreLanes = new Set<SyncReplicationLane>(['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AUTH'])
        if (session.pushSnapshot && [...selectedLanes].some((lane) => !coreLanes.has(lane))) {
          const coreBaseline = this.genesisSnapshotService.promoteToGcBaseline(
            working.snapshotBundleId,
            checkpointId,
            now,
            coreLanes
          )
          await uploadSnapshotBlobs(coreBaseline, coreLanes)
          await session.pushSnapshot(coreBaseline)
        }
        let gcBaseline: SyncSnapshotBundleWire | null = null
        try {
          gcBaseline = this.genesisSnapshotService.promoteToGcBaseline(
            working.snapshotBundleId,
            checkpointId,
            now,
            selectedLanes
          )
        } catch {
          gcBaseline = null
        }
        if (gcBaseline) {
          if (!session.pushSnapshot) {
            throw new Error('GC_BASELINE transport is not supported by this Server endpoint')
          }
          // Server persistence is the durability fence; local compaction happens only after it.
          await uploadSnapshotBlobs(gcBaseline, selectedLanes)
          await session.pushSnapshot(gcBaseline)
          this.stableGcCoordinator.compact(gcBaseline.snapshotBundleId, now)
          const localReplicaId = this.runtime.findDeviceIdentity()?.deviceId
          if (localReplicaId) {
            this.stableGcCoordinator.sweepUnreferencedBlobs(
              syncSpaceId,
              localReplicaId,
              500,
              now
            )
          }
        }
      }
    }

    return {
      pushedOperationIds,
      pulledOperationIds,
      appliedOperationIds,
      deferredOperationIds,
      rejectedOperationIds,
      diagnostics,
      remotePolicyByLane: remoteState.policyByLane,
      remoteCapabilities: negotiation.capabilities
    }
  }
}

function laneIsEnabled(policy: SyncPolicyByLane, lane: string): boolean {
  return policy[lane] !== 'PAUSED' && policy[lane] !== 'UNSUPPORTED' && policy[lane] !== 'LOCAL_PURGE'
}

function filterCoverageByPolicy(coverage: SyncCoverage, policy: SyncPolicyByLane): SyncCoverage {
  return Object.fromEntries(
    Object.entries(coverage)
      .filter(([lane]) => laneIsEnabled(policy, lane))
      .map(([lane, actors]) => [lane, { ...actors }])
  )
}
