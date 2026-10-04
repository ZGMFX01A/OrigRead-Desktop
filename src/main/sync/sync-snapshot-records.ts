import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { canonicalJson } from './sync-operation-canonicalizer'
import { validateSnapshotRecord } from './sync-snapshot-record-validation'

/** 业务记录类别白名单，网络输入必须具有可检查的身份与关联键。 */
const RECORD_KINDS = new Set(['ENTITY', 'FIELD_VERSION', 'TOMBSTONE', 'ALIAS_EDGE', 'BLOB_MANIFEST', 'BLOB_REFERENCE', 'AUTH_OBJECT', 'GENESIS'])

/** 统一记录身份，跨页面切分和重复传输都不能改变业务唯一键。 */
export function snapshotRecordKey(kind: SyncSnapshotRecord['kind'], value: Record<string, unknown>): string {
  const entity = [value.entityType, value.entitySyncId, value.entityGeneration ?? value.generation]
  switch (kind) {
    case 'ENTITY': case 'TOMBSTONE': return canonicalJson(JSON.stringify(entity))
    case 'FIELD_VERSION': return canonicalJson(JSON.stringify([...entity, value.fieldId, value.versionToken]))
    case 'BLOB_MANIFEST': return canonicalJson(JSON.stringify([value.hash]))
    case 'BLOB_REFERENCE': return canonicalJson(JSON.stringify([value.ownerEntityType, value.ownerEntitySyncId, value.ownerEntityGeneration, value.referenceKind, value.hash]))
    case 'ALIAS_EDGE': return canonicalJson(JSON.stringify([value.targetEntityType,
      ...[JSON.stringify([value.leftSyncId, value.leftGeneration]), JSON.stringify([value.rightSyncId, value.rightGeneration])].sort()]))
    case 'AUTH_OBJECT': return canonicalJson(JSON.stringify([value.authObjectId]))
    case 'GENESIS': return canonicalJson(JSON.stringify([value.genesisBaselineId]))
  }
}

/** 解码分批记录时核验类别与唯一键，悬空关联由完整索引校验处理。 */
export function decodeSnapshotRecord(line: string): SyncSnapshotRecord {
  const raw = JSON.parse(line) as Partial<SyncSnapshotRecord>
  if (!raw || !RECORD_KINDS.has(raw.kind ?? '') || !raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) {
    throw new Error('SNAPSHOT_CORRUPTED: invalid paged Snapshot record')
  }
  const record = raw as SyncSnapshotRecord
  validateSnapshotRecord(record)
  if (record.key !== snapshotRecordKey(record.kind, record.value)) throw new Error('SNAPSHOT_CORRUPTED: Snapshot record key mismatch')
  return record
}

/** NDJSON 记录可以跨任意字节页；UTF-8 多字节字符的续页由流式 decoder 保留。 */
export function* snapshotRecordLines(pages: Iterable<Uint8Array>): Generator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  for (const page of pages) {
    const text = decoder.decode(page, { stream: true })
    let start = 0
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', start)) {
      yield pending + text.slice(start, index)
      pending = ''
      start = index + 1
    }
    pending += text.slice(start)
  }
  pending += decoder.decode()
  if (pending) throw new Error('SNAPSHOT_CORRUPTED: Snapshot record was truncated at end of lane')
}
