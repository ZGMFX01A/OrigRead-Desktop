import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'

/** 在任何跨库业务写入之前，验证全部强依赖及复合外键的共享上下文。 */
export function requirePagedEntityGraph(store: SyncPagedSnapshotStore, bundleId: string): void {
  for (const entity of store.derived.entities({ snapshotBundleId: bundleId })) {
    for (const dependency of entity.parents) {
      const filter = { snapshotBundleId: bundleId, entityType: dependency.entityType, entitySyncId: dependency.entitySyncId }
      const parent = store.derived.entities(filter).next().value
      if (!parent || (dependency.generation != null && parent.generation !== dependency.generation)) {
        throw new Error('SNAPSHOT_CORRUPTED: entity has no current parent generation')
      }
      const deleted = store.records({ ...filter, kind: 'TOMBSTONE', generation: parent.generation }).next().value
      if (deleted) throw new Error('SNAPSHOT_CORRUPTED: live entity depends on deleted parent')
      requireSharedContext(entity.context, parent.context)
    }
  }
}

/** Citation 的复合外键要求 message、context、conversation 一致，不能各自存在却相互不属于。 */
function requireSharedContext(child: Readonly<Record<string, unknown>>, parent: Readonly<Record<string, unknown>>): void {
  for (const field of ['conversationSyncId', 'assistantMessageSyncId', 'contextRefSyncId']) {
    if (child[field] != null && parent[field] != null && child[field] !== parent[field]) {
      throw new Error('SNAPSHOT_CORRUPTED: entity parent context differs at ' + field)
    }
  }
}
