import type { SyncCoverage } from './sync-protocol'
import type { SyncSnapshotClass } from './sync-runtime'

/** 分页快照只签清单与页面摘要，业务记录通过独立页面传输。 */
export const PAGED_SNAPSHOT_FORMAT = 3
/** 单页原始字节目标；记录可以跨页，快照总量不受此值限制。 */
export const SNAPSHOT_PAGE_BYTES = 512 * 1024

export interface SyncSnapshotLanePages {
  replicationLaneId: string
  frontierJson: string
  pageHashes: string[]
  recordCount: number
}

export interface SyncPagedSnapshotManifest {
  formatVersion: number
  snapshotBundleId: string
  sourceSnapshotBundleId: string
  syncSpaceId: string
  snapshotClass: SyncSnapshotClass
  genesisBaselineId: string
  crossDbCutId: string
  policyHash: string
  capturedAt: number
  lanes: SyncSnapshotLanePages[]
  coverage: SyncCoverage
  requiredCoreShardIds: string[]
  authStabilityCheckpoint: string | null
  coverageCommitment: string | null
  authorDeviceId: string
  rootHash: string
  authorSignature: string
}

export interface SyncSnapshotBytePage {
  replicationLaneId: string
  pageIndex: number
  bytesBase64: string
}

/** 续传状态只报告已验证落盘的页，root 绑定客户端当前的不可变清单。 */
export interface SyncSnapshotPageStatus {
  rootHash: string
  receivedPages: Record<string, number[]>
}

/** 记录的唯一键由所属实体、代次和字段/候选标识共同确定，不能用页面序号代替。 */
export interface SyncSnapshotRecord {
  kind: 'ENTITY' | 'FIELD_VERSION' | 'TOMBSTONE' | 'ALIAS_EDGE' | 'BLOB_MANIFEST' | 'BLOB_REFERENCE' | 'AUTH_OBJECT' | 'GENESIS'
  key: string
  value: Record<string, unknown>
}
