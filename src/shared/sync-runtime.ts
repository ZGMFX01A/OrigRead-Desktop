import type { SourceSyncBatchResult } from './source-sync'

export type SyncTrigger = 'startup' | 'periodic' | 'manual'

export interface SyncRuntimeState {
  running: boolean
  lastStartedAt: number | null
  lastFinishedAt: number | null
  nextRunAt: number | null
  lastTrigger: SyncTrigger | null
  lastResult: SourceSyncBatchResult | null
}

export const SYNC_REPLICATION_LANES = [
  'CORE_META',
  'LIBRARY',
  'ARTICLE_STATE',
  'CONFIG',
  'AI_HISTORY',
  'AUTH'
] as const

export type SyncReplicationLane = (typeof SYNC_REPLICATION_LANES)[number]
export type SyncSpaceLifecycleState = 'PREPARING' | 'STAGING' | 'REBASE_PREPARE' | 'GENESIS_CAPTURING' | 'ACTIVE' | 'PAUSED'
export type SyncGenesisStage = 'CAPTURING' | 'CUT_CAPTURED' | 'SNAPSHOT_BUILT' | 'TAIL_REPLAY' | 'ACTIVE' | 'FAILED'
export type SyncSnapshotClass = 'WORKING' | 'GC_BASELINE' | 'BOOTSTRAP_RECOVERY'
export type SyncActorStatus = 'ACTIVE' | 'RETIRED'
export type SyncOutboxStatus = 'PENDING_BUILD' | 'BUILT' | 'FAILED'
export type SyncMutationType = 'UPSERT' | 'FIELD_SET' | 'RELATION_SET' | 'GLOBAL_DELETE'

export interface SyncWritableActorContext {
  localAccountId: number
  syncSpaceId: string
  deviceId: string
  actorIncarnationId: string
  lifecycleState: SyncSpaceLifecycleState
  observedGenesisBaselinesByLane?: Record<string, string[]>
}

export interface SyncGenesisSessionRecord {
  genesisSessionId: string
  syncSpaceId: string
  genesisBaselineId: string
  crossDbCutId: string
  stage: SyncGenesisStage
  capturedAt: number | null
  laneFrontiersJson: string
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface SyncSnapshotBundleRecord {
  snapshotBundleId: string
  syncSpaceId: string
  genesisSessionId: string
  genesisBaselineId: string
  snapshotClass: SyncSnapshotClass
  authStabilityCheckpointId?: string | null
  rootHash: string
  policyHash: string
  capturedAt: number
  createdAt: number
}

export interface SyncSnapshotShardRecord {
  snapshotBundleId: string
  syncSpaceId: string
  replicationLaneId: SyncReplicationLane
  frontierJson: string
  entityStateJson: string
  fieldVersionStateJson: string
  causalMetadataJson: string
  genesisCoverageJson: string
  deletionGenerationSummaryJson: string
  blobManifestIndexJson: string
  blobReferenceIndexJson: string
  contentHash: string
  createdAt: number
}

export interface SyncOutboxDraft {
  entityType: string
  entitySyncId: string
  entityGeneration?: number
  mutationType: SyncMutationType
  payloadSchemaVersion?: number
  payloadJson: string
  observedEntityVersionJson?: string | null
}

export interface SyncOutboxRecord {
  outboxId: string
  syncSpaceId: string
  actorIncarnationId: string
  replicationLaneId: SyncReplicationLane
  sequence: number
  entityType: string
  entitySyncId: string
  entityGeneration: number
  mutationType: SyncMutationType
  payloadSchemaVersion: number
  payloadJson: string
  causalContextJson: string
  observedEntityVersionJson: string | null
  status: SyncOutboxStatus
  createdAt: number
  updatedAt: number
  genesisIncludedAt: number | null
}

export type SyncOperationBuildStatus = 'AWAITING_SIGNATURE' | 'SIGNED' | 'REJECTED'

export interface SyncOperationRecord {
  operationId: string
  syncSpaceId: string
  authorDeviceId: string
  actorIncarnationId: string
  replicationLaneId: SyncReplicationLane
  sequence: number
  logicalClock: number
  causalContextJson: string
  dependencyDotsJson: string
  entityType: string
  entitySyncId: string
  entityGeneration: number
  operationType: SyncMutationType
  payloadSchemaVersion: number
  payloadJson: string
  schemaVersion: number
  authGrantId: string | null
  authEpoch: number | null
  createdWallClock: number
  payloadHash: string
  signingDigest: string
  authorSignature: string | null
  buildStatus: SyncOperationBuildStatus
  createdAt: number
  updatedAt: number
}
