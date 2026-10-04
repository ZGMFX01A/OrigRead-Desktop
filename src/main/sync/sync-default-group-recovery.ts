import type { DatabaseSync } from 'node:sqlite'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type { SyncIdentityMappingRecord } from '../../shared/sync-identity'
import type { SyncIdentityRepository } from './sync-identity-repository'

/** 默认分组不能被本地删除；存活的默认行与同代 tombstone 并存说明旧捕获曾误删它。 */
export function hasDeletedDefaultGroup(database: DatabaseSync, input: {
  readonly accountId: number
  readonly syncSpaceId: string
}): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM groups g
    JOIN sync_identity_mapping m ON m.local_id=g.id AND m.entity_type='group'
    JOIN sync_entity_tombstone t ON t.sync_space_id=m.sync_space_id
      AND t.entity_type=m.entity_type AND t.entity_sync_id=m.sync_id
    WHERE g.account_id=? AND m.sync_space_id=? AND g.is_default=1
      AND t.generation>=m.generation LIMIT 1`).get(input.accountId, input.syncSpaceId))
}

/** 只依据当前账户的本地默认标志恢复，不凭名称恢复普通用户分组。 */
export function isAccountDefaultGroup(database: DatabaseSync, input: {
  readonly accountId: number
  readonly groupId: string
}): boolean {
  return Boolean(database.prepare('SELECT 1 FROM groups WHERE account_id=? AND id=? AND is_default=1')
    .get(input.accountId, input.groupId))
}

/** 稳定授权的复活 UPSERT 提升既有本地映射代次，保留默认标志与历史删除证据。 */
export function restoreGroupMappingGeneration(database: DatabaseSync,
  identities: Pick<SyncIdentityRepository, 'findBySyncId' | 'updateMappings'>,
  input: { readonly operation: SyncOperationRecord; readonly accountId: number }
): SyncIdentityMappingRecord | null {
  const operation = input.operation
  if (operation.operationType !== 'UPSERT') return null
  const existing = identities.findBySyncId(operation.syncSpaceId, 'group', operation.entitySyncId)
  if (!existing || existing.generation >= operation.entityGeneration) return null
  const group = database.prepare('SELECT account_id FROM groups WHERE id=?').get(existing.localId) as
    { account_id: number } | undefined
  if (group && group.account_id !== input.accountId) throw new Error('Group belongs to another account')
  const restored = { ...existing, generation: operation.entityGeneration, updatedAt: Date.now() }
  identities.updateMappings([restored])
  return restored
}
