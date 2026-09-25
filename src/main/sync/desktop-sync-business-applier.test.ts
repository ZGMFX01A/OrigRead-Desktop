import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { DesktopSyncBusinessApplier } from './desktop-sync-business-applier'
import { SyncStateRepository } from './sync-state-repository'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncApplyCoordinator, SyncApplyDeferredError } from './sync-apply-coordinator'
import { operationId } from './sync-operation-canonicalizer'

it('retains concurrent losers so three-peer delivery permutations converge', () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    try {
      const account = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id
      db.prepare('INSERT INTO sync_local_space_binding(local_account_id,sync_space_id,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(account, 'space', 'ACTIVE', 1, 1)
      const state = new SyncStateRepository(db)
      const runtime = new SyncRuntimeRepository(db)
      const applier = new DesktopSyncBusinessApplier(db, state)
      const base: SyncOperationRecord = {
        operationId: 'a', syncSpaceId: 'space', authorDeviceId: 'device', actorIncarnationId: 'actor-z',
        replicationLaneId: 'LIBRARY', sequence: 1, logicalClock: 3, causalContextJson: '{}', dependencyDotsJson: '[]',
        entityType: 'group', entitySyncId: 'remote', entityGeneration: 0, operationType: 'UPSERT',
        payloadSchemaVersion: 1, payloadJson: '{"name":"A"}', schemaVersion: 1, authGrantId: null, authEpoch: null,
        createdWallClock: 1, payloadHash: '', signingDigest: '', authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1
      }
      const operations = [base,
        { ...base, operationId: 'b', actorIncarnationId: 'actor-m', logicalClock: 2, payloadJson: '{"name":"B"}' },
        { ...base, operationId: 'c', actorIncarnationId: 'actor-a', logicalClock: 1, payloadJson: '{"name":"C"}',
          causalContextJson: '{"schemaVersion":1,"lanes":[{"replicationLaneId":"LIBRARY","actors":[{"actorIncarnationId":"actor-z","prefix":1}]}]}' }]
      for (const index of order) {
        runtime.insertOperationIgnore(operations[index]!)
        applier.apply(operations[index]!)
      }
      expect(state.findFieldVersion('space', 'group', 'remote', 'name')?.valueJson).toBe('"B"')
    } finally { db.close() }
  }
})

it('creates and renames a mapped group without resurrecting deleted generations', () => {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  const account = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id
  db.prepare('INSERT INTO sync_local_space_binding(local_account_id,sync_space_id,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(account, 'space', 'ACTIVE', 1, 1)
  const state = new SyncStateRepository(db)
  const applier = new DesktopSyncBusinessApplier(db, state)
  const operation: SyncOperationRecord = {
    operationId: 'op', syncSpaceId: 'space', authorDeviceId: 'device', actorIncarnationId: 'actor',
    replicationLaneId: 'LIBRARY', sequence: 1, logicalClock: 1, causalContextJson: '{}', dependencyDotsJson: '[]',
    entityType: 'group', entitySyncId: 'remote', entityGeneration: 0, operationType: 'UPSERT',
    payloadSchemaVersion: 1, payloadJson: '{"name":"old"}', schemaVersion: 1, authGrantId: null, authEpoch: null,
    createdWallClock: 1, payloadHash: '', signingDigest: '', authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1,
  }
  try {
    applier.apply(operation)
    const mapping = db.prepare('SELECT local_id FROM sync_identity_mapping WHERE sync_id=?').get('remote') as { local_id: string }
    expect(mapping.local_id).not.toBe('remote')
    applier.apply({ ...operation, operationId: 'op2', sequence: 2, operationType: 'FIELD_SET', payloadJson: '{"field":"name","value":"new"}' })
    expect(db.prepare('SELECT name FROM groups WHERE id=?').get(mapping.local_id)).toEqual({ name: 'new' })
    db.prepare('INSERT INTO accounts(id,name,type,sync_interval_minutes,sync_on_start,created_at) VALUES(?,?,?,?,?,?)')
      .run(account + 100, 'Other account', 'local', 30, 0, 1)
    db.prepare('UPDATE groups SET account_id=? WHERE id=?').run(account + 100, mapping.local_id)
    expect(() => applier.apply({ ...operation, sequence: 3 })).toThrow('Group belongs to another account')
    expect(db.prepare('SELECT name FROM groups WHERE id=?').get(mapping.local_id)).toEqual({ name: 'new' })
    db.prepare('UPDATE groups SET account_id=? WHERE id=?').run(account, mapping.local_id)
    state.recordTombstone('space', 'group', 'remote', 0, 'deleted')
    db.prepare('DELETE FROM groups WHERE id=?').run(mapping.local_id)
    applier.apply(operation)
    expect(db.prepare('SELECT id FROM groups WHERE id=?').get(mapping.local_id)).toBeUndefined()
  } finally { db.close() }
})

it('defers feed when dependent group is missing and creates feed when group arrives', () => {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  const account = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id
  db.prepare('INSERT INTO sync_local_space_binding(local_account_id,sync_space_id,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(account, 'space', 'ACTIVE', 1, 1)
  const state = new SyncStateRepository(db)
  const applier = new DesktopSyncBusinessApplier(db, state)

  const feedOp: SyncOperationRecord = {
    operationId: 'feed-op-1', syncSpaceId: 'space', authorDeviceId: 'device', actorIncarnationId: 'actor',
    replicationLaneId: 'LIBRARY', sequence: 10, logicalClock: 10, causalContextJson: '{}', dependencyDotsJson: '[]',
    entityType: 'feed', entitySyncId: 'remote-feed-1', entityGeneration: 0, operationType: 'UPSERT',
    payloadSchemaVersion: 1,
    payloadJson: JSON.stringify({ name: 'Tech News', url: 'https://example.com/feed.xml', groupSyncId: 'remote-group-99' }),
    schemaVersion: 1, authGrantId: null, authEpoch: null, createdWallClock: 1, payloadHash: '', signingDigest: '',
    authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1
  }

  try {
    // 依赖的 Group 尚未映射时必须抛出 SyncApplyDeferredError
    expect(() => applier.apply(feedOp)).toThrow(SyncApplyDeferredError)

    // 创建依赖的 Group
    applier.apply({
      ...feedOp, operationId: 'group-op-1', entityType: 'group', entitySyncId: 'remote-group-99',
      payloadJson: '{"name":"Tech"}'
    })

    // 再次应用 Feed 操作，此时应成功创建
    applier.apply(feedOp)
    const feedMapping = db.prepare('SELECT local_id FROM sync_identity_mapping WHERE sync_id=?').get('remote-feed-1') as { local_id: string }
    expect(feedMapping).toBeDefined()
    const feedRow = db.prepare('SELECT name, url FROM feeds WHERE id=?').get(feedMapping.local_id) as { name: string; url: string }
    expect(feedRow.name).toBe('Tech News')
    expect(feedRow.url).toBe('https://example.com/feed.xml')

    // 测试 RELATION_SET 变更分组
    applier.apply({
      ...feedOp, operationId: 'group-op-2', entityType: 'group', entitySyncId: 'remote-group-100',
      payloadJson: '{"name":"News"}'
    })
    const group2Mapping = db.prepare('SELECT local_id FROM sync_identity_mapping WHERE sync_id=?').get('remote-group-100') as { local_id: string }

    applier.apply({
      ...feedOp, operationId: 'rel-op-1', operationType: 'RELATION_SET',
      payloadJson: JSON.stringify({ feedSyncId: 'remote-feed-1', groupSyncId: 'remote-group-100' })
    })
    const updatedFeed = db.prepare('SELECT group_id FROM feeds WHERE id=?').get(feedMapping.local_id) as { group_id: string }
    expect(updatedFeed.group_id).toBe(group2Mapping.local_id)

    // 测试 Feed GLOBAL_DELETE
    applier.apply({
      ...feedOp, operationId: 'feed-del-1', operationType: 'GLOBAL_DELETE', payloadJson: '{}'
    })
    expect(db.prepare('SELECT id FROM feeds WHERE id=?').get(feedMapping.local_id)).toBeUndefined()
  } finally { db.close() }
})

it.each([0, 1])('restores actual pre-sync local value %s when an operation is revoked', (original) => {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  const account = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id
  db.prepare('INSERT INTO sync_local_space_binding(local_account_id,sync_space_id,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(account, 'space', 'ACTIVE', 1, 1)
  const state = new SyncStateRepository(db)
  const applier = new DesktopSyncBusinessApplier(db, state)

  // 1. 本地建立 article 映射与行
  const localArticleId = 'local-art-1'
  db.prepare('INSERT INTO groups(id,account_id,name) VALUES(?,?,?)').run('g1', account, 'Default')
  db.prepare('INSERT INTO feeds(id,account_id,group_id,name,url,source_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('f1', account, 'g1', 'Feed', 'https://ex.com/f', 'rss', 1, 1)
  db.prepare('INSERT INTO articles(id,account_id,feed_id,title,is_unread,is_starred,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(localArticleId, account, 'f1', 'Article', 1, original, 1, 1)
  db.prepare('INSERT INTO sync_identity_mapping(sync_space_id,entity_type,local_id,sync_id,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('space', 'article', localArticleId, 'remote-art-1', 0, 1, 1)

  // 2. Device-Bad 发出将 isStarred 设为 true 的操作，并已被 applied
  const badOp: SyncOperationRecord = {
    operationId: operationId('space', 'actor-bad', 'ARTICLE_STATE', 5), syncSpaceId: 'space', authorDeviceId: 'device-bad', actorIncarnationId: 'actor-bad',
    replicationLaneId: 'ARTICLE_STATE', sequence: 5, logicalClock: 5, causalContextJson: '{}', dependencyDotsJson: '[]',
    entityType: 'article', entitySyncId: 'remote-art-1', entityGeneration: 0, operationType: 'FIELD_SET',
    payloadSchemaVersion: 1, payloadJson: JSON.stringify({ field: 'isStarred', value: original === 0 }), schemaVersion: 1,
    authGrantId: 'grant-bad', authEpoch: 0, createdWallClock: 1, payloadHash: '', signingDigest: '',
    authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1
  }

  try {
    const runtime = new SyncRuntimeRepository(db)
    runtime.insertOperationIgnore(badOp)
    state.insertInbox(badOp, JSON.stringify(badOp), 1)
    applier.apply(badOp)
    state.markApplied(badOp.operationId, 2)
    const coordinator = new SyncApplyCoordinator(runtime, state, applier)
    expect((db.prepare('SELECT is_starred FROM articles WHERE id=?').get(localArticleId) as { is_starred: number }).is_starred).toBe(original === 0 ? 1 : 0)
    expect(state.findFieldVersion('space', 'article', 'remote-art-1', 'isStarred')?.sourceOperationId).toBe(badOp.operationId)

    // 3. 执行回滚：该 canonical operation 被撤销
    // A failed restoration must leave inbox and field metadata unchanged.
    const baseline = db.prepare('SELECT value_json FROM sync_field_rollback_baseline').get() as { value_json: string }
    db.prepare('DELETE FROM sync_field_rollback_baseline').run()
    expect(() => coordinator.applyRevocationRollback('space', 'device-bad', {})).toThrow('baseline is unavailable')
    expect(state.findInbox(badOp.operationId)?.state).toBe('APPLIED')
    expect(state.findFieldVersion('space', 'article', 'remote-art-1', 'isStarred')?.sourceOperationId).toBe(badOp.operationId)
    db.prepare('INSERT INTO sync_field_rollback_baseline VALUES(?,?,?,?,?,?)').run('space', 'article', 'remote-art-1', 0, 'isStarred', baseline.value_json)
    const result = coordinator.applyRevocationRollback('space', 'device-bad', {})
    expect(result.revokedOperationIds).toEqual([badOp.operationId])
    expect(state.findInbox(badOp.operationId)?.state).toBe('REJECTED')

    // 4. 验证文章 is_starred 被成功回滚恢复为 0，且污染记录被清理
    expect((db.prepare('SELECT is_starred FROM articles WHERE id=?').get(localArticleId) as { is_starred: number }).is_starred).toBe(original)
    expect(state.findFieldVersion('space', 'article', 'remote-art-1', 'isStarred')).toBeNull()
  } finally {
    db.close()
  }
})
