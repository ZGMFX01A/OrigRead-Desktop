import type { RecoveryIndex } from './sync-paged-recovery-entities'
import { SyncBufferedSnapshotCapture } from './sync-buffered-snapshot-capture'
import { syncPayloadBlobRefs } from './sync-blob-payload'
import { canonicalJson } from './sync-operation-canonicalizer'
import { snapshotRecordKey } from './sync-snapshot-records'

/** 只保留当前 winner 的正文拥有者引用，淘汰候选值不能继续增加引用数。 */
export function mergePagedBlobs(input: RecoveryIndex): void {
  const buffered = new SyncBufferedSnapshotCapture(input.database, input.store)
  for (const lane of input.lanes) {
    for (const entity of input.store.records({ snapshotBundleId: input.workId, lane, kind: 'ENTITY' })) {
      const fields = entity.value.fields as Record<string, unknown>
      const hashes = new Set(syncPayloadBlobRefs(JSON.stringify(fields)).map(ref => ref.manifest.hash))
      if (entity.value.entityType === 'article' && typeof fields.fullContentHash === 'string') hashes.add(fields.fullContentHash)
      retainReferences(input, buffered, { lane, entity, hashes })
    }
    buffered.flushCapture()
    appendManifests(input, buffered, lane)
    buffered.flushCapture()
  }
}

/** 来源引用必须匹配当前实体代次和当前字段实际使用的 hash，不复制整个 Blob 索引数组。 */
function retainReferences(input: RecoveryIndex, buffered: SyncBufferedSnapshotCapture, owner: { lane: string;
  entity: import('../../shared/sync-paged-snapshot').SyncSnapshotRecord; hashes: Set<string> }): void {
  const filter = { lane: owner.lane, kind: 'BLOB_REFERENCE' as const, entityType: String(owner.entity.value.entityType),
    entitySyncId: String(owner.entity.value.entitySyncId), generation: Number(owner.entity.value.generation) }
  const found = new Set<string>()
  for (const id of [input.localId, input.targetId]) for (const record of input.store.records({ snapshotBundleId: id, ...filter })) {
    const hash = String(record.value.hash)
    if (!owner.hashes.has(hash)) continue
    found.add(hash)
    buffered.writeRecord({ snapshotBundleId: input.workId, lane: owner.lane, record })
  }
  if ([...owner.hashes].some(hash => !found.has(hash))) throw new Error('SNAPSHOT_CORRUPTED: recovery winner has no matching Blob reference')
}

/** manifest 的不变属性必须一致，引用数量按合并后实际当前拥有者重新计算。 */
function appendManifests(input: RecoveryIndex, buffered: SyncBufferedSnapshotCapture, lane: string): void {
  let after = ''
  for (;;) {
    const hashes = input.database.prepare(`SELECT blob_hash,COUNT(*) AS references_count FROM sync_paged_snapshot_record
      WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind='BLOB_REFERENCE' AND blob_hash>?
      GROUP BY blob_hash ORDER BY blob_hash LIMIT ${MANIFEST_ROWS}`).all(input.workId, lane, after)
    if (!hashes.length) return
    for (const row of hashes) {
    let selected: Record<string, unknown> | undefined
    for (const id of [input.localId, input.targetId]) {
      const record = input.store.records({ snapshotBundleId: id, lane, kind: 'BLOB_MANIFEST', blobHash: String(row.blob_hash) }).next().value
      if (!record) continue
      const value = { ...record.value, referenceCount: Number(row.references_count) }
      if (selected && canonicalJson(JSON.stringify(selected)) !== canonicalJson(JSON.stringify(value))) throw new Error('SNAPSHOT_CORRUPTED: recovery Blob manifest collision')
      selected = value
    }
    if (!selected) throw new Error('SNAPSHOT_CORRUPTED: recovery Blob reference has no manifest')
    buffered.writeRecord({ snapshotBundleId: input.workId, lane,
      record: { kind: 'BLOB_MANIFEST', key: snapshotRecordKey('BLOB_MANIFEST', selected), value: selected } })
    after = String(row.blob_hash)
  }
}
  }

/** 只预取当前正文 hash 的轻量身份。 */
const MANIFEST_ROWS = 256
