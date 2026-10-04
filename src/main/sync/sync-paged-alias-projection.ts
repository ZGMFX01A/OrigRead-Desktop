import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { resolveIndexedPagedField } from './sync-paged-field-resolver'

/** 多个别名属于同一业务行时，完整因果候选决定物化值，不能让实体排序决定收藏/已读。 */
export function pagedAliasProjection(input: { store: SyncPagedSnapshotStore; bundleId: string; lane: string;
  entity: SyncSnapshotRecord; members: ReadonlySet<string> }): Record<string, unknown> {
  const filter = { snapshotBundleId: input.bundleId, lane: input.lane,
    entityType: String(input.entity.value.entityType), generation: Number(input.entity.value.generation) }
  const fields: Record<string, unknown> = {}
  for (const id of [...input.members].sort()) {
    const entity = input.store.records({ ...filter, entitySyncId: id, kind: 'ENTITY' }).next().value
    if (entity) Object.assign(fields, entity.value.fields)
  }
  for (const name of Object.keys(fields)) {
    const fieldId = filter.entityType === 'article' && name === 'fullContentHash' ? 'fullContentHtml' : name
    const candidates = function* () {
      for (const entitySyncId of input.members) yield* input.store.derived.fields({ ...filter, entitySyncId, fieldId })
    }
    if (name === 'fullContentHash' && candidates().next().done) continue
    fields[name] = JSON.parse(String(resolveIndexedPagedField({ candidates, fieldId,
      readWinner: field => input.store.fieldRecord(field) }).value.valueJson))
  }
  return { ...input.entity.value, fields }
}
