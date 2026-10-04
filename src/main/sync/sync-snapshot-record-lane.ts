import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { validatePagedFieldMetadata } from './sync-paged-field-metadata'

/** 各逻辑 lane 的共享业务类型；未知类型不能在已安装快照中被静默丢弃。 */
const ENTITY_TYPES: Readonly<Record<string, readonly string[]>> = {
  CORE_META: ['sync_core'], LIBRARY: ['group', 'feed'], ARTICLE_STATE: ['article'],
  CONFIG: ['filter_rule', 'website_rule', 'json_rule', 'rsshub_settings', 'website_parse_preference', 'rsshub_subscription_source'],
  AI_HISTORY: ['conversation', 'conversation_article', 'message', 'tool_call', 'context_ref', 'evidence_block',
    'citation_ref', 'citation_annotation', 'citation_annotation_ref'], AUTH: []
}

/** 完整记录进入持久索引前检查所属 lane，禁止跨 lane 覆盖暂停域的数据。 */
export function validateSnapshotRecordLane(lane: string, record: SyncSnapshotRecord): void {
  const types = ENTITY_TYPES[lane]
  if (!types) fail()
  if (['ENTITY', 'FIELD_VERSION', 'TOMBSTONE'].includes(record.kind)) {
    const type = record.value.entityType
    const aliasDelete = lane === 'CORE_META' && record.kind === 'TOMBSTONE' && type === 'alias_edge'
    if (!aliasDelete && !types.includes(String(type))) fail()
  }
  if (record.kind === 'BLOB_REFERENCE' &&
    (record.value.replicationLaneId !== lane || !types.includes(String(record.value.ownerEntityType)))) fail()
  if (record.kind === 'AUTH_OBJECT' && lane !== 'AUTH') fail()
  if (record.kind === 'ALIAS_EDGE' && (lane !== 'CORE_META' ||
    !Object.values(ENTITY_TYPES).some(allowed => allowed.includes(String(record.value.targetEntityType))))) fail()
  if (record.kind === 'FIELD_VERSION') validatePagedFieldMetadata(lane, record)
}

/** 错误必须在安装清理业务表之前暴露，不能把遗漏实体当成成功。 */
function fail(): never { throw new Error('SNAPSHOT_CORRUPTED: Snapshot record type does not belong to its lane') }
