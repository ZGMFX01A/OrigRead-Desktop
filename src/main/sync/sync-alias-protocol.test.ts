import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { MemorySecretStore } from '../security/secret-store'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import {
  DesktopSyncAliasMutationCapture,
  DesktopSyncAliasResolver,
  DesktopSyncLocalEvictionService,
  type SyncAliasEdgePayloadV1
} from './sync-alias-protocol'
import { DesktopSyncBusinessApplier } from './desktop-sync-business-applier'
import type { SyncOperationRecord } from '../../shared/sync-runtime'

function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database)
  const runtime = new SyncRuntimeRepository(database)
  const identities = new SyncIdentityRepository(database)
  const state = new SyncStateRepository(database)
  const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'alias-test')
  const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identities, witness)
  coordinator.prepareSpace(1, 'space-alias', 1)
  coordinator.markActive(1, 2)
  return { database, runtime, identities, state, witness, coordinator }
}

const edge = (leftSyncId: string, rightSyncId: string, generation = 0): SyncAliasEdgePayloadV1 => ({
  targetEntityType: 'group',
  leftSyncId,
  leftGeneration: generation,
  rightSyncId,
  rightGeneration: generation
})

describe('DesktopSyncAliasResolver', () => {
  it('converges undirected edges to the same representative and isolates generations', () => {
    const { database, state } = fixture()
    try {
      const resolver = new DesktopSyncAliasResolver(database, state)
      resolver.applyEdge('space-alias', edge('b', 'c'), 'op-bc', 10)
      resolver.applyEdge('space-alias', edge('a', 'b'), 'op-ab', 11)

      const generation0 = database.prepare(`
        SELECT alias_sync_id,canonical_sync_id,generation FROM sync_entity_alias
        WHERE sync_space_id=? AND entity_type='group' AND generation=0 ORDER BY alias_sync_id
      `).all('space-alias')
      expect(generation0).toEqual([
        { alias_sync_id: 'a', canonical_sync_id: 'a', generation: 0 },
        { alias_sync_id: 'b', canonical_sync_id: 'a', generation: 0 },
        { alias_sync_id: 'c', canonical_sync_id: 'a', generation: 0 }
      ])

      resolver.applyEdge('space-alias', edge('b', 'z', 1), 'op-bz-g1', 12)
      const generation1 = database.prepare(`
        SELECT alias_sync_id,canonical_sync_id,generation FROM sync_entity_alias
        WHERE sync_space_id=? AND entity_type='group' AND generation=1 ORDER BY alias_sync_id
      `).all('space-alias')
      expect(generation1).toEqual([
        { alias_sync_id: 'b', canonical_sync_id: 'b', generation: 1 },
        { alias_sync_id: 'z', canonical_sync_id: 'b', generation: 1 }
      ])
      expect(resolver.edgeSyncId(edge('a', 'b'))).toBe(resolver.edgeSyncId(edge('b', 'a')))
    } finally {
      database.close()
    }
  })

  it('resolves an aliased Sync ID to the existing local row and propagates delete-wins', () => {
    const { database, identities, state } = fixture()
    try {
      database.prepare("INSERT INTO groups(id,account_id,name,sort_order,is_default) VALUES('local-a',1,'Old',0,0)").run()
      identities.insertMapping({
        syncSpaceId: 'space-alias', entityType: 'group', localId: 'local-a', syncId: 'a', canonicalKey: null,
        generation: 0, createdAt: 1, updatedAt: 1
      })
      const resolver = new DesktopSyncAliasResolver(database, state)
      resolver.applyEdge('space-alias', edge('a', 'b'), 'edge-op', 10)

      const applier = new DesktopSyncBusinessApplier(database, state)
      const base: SyncOperationRecord = {
        operationId: 'op-set', syncSpaceId: 'space-alias', authorDeviceId: 'peer', actorIncarnationId: 'peer-actor',
        replicationLaneId: 'LIBRARY', sequence: 1, logicalClock: 1, causalContextJson: '{}', dependencyDotsJson: '[]',
        entityType: 'group', entitySyncId: 'b', entityGeneration: 0, operationType: 'FIELD_SET', payloadSchemaVersion: 1,
        payloadJson: JSON.stringify({ field: 'name', value: 'Aliased' }), schemaVersion: 1, authGrantId: null, authEpoch: 0,
        createdWallClock: 1, payloadHash: 'hash', signingDigest: 'digest', authorSignature: 'sig', buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1
      }
      applier.apply(base)
      expect(database.prepare('SELECT name FROM groups WHERE id=?').get('local-a')).toEqual({ name: 'Aliased' })

      applier.apply({ ...base, operationId: 'op-delete', sequence: 2, logicalClock: 2, operationType: 'GLOBAL_DELETE', payloadJson: '{}' })
      expect(database.prepare('SELECT id FROM groups WHERE id=?').get('local-a')).toBeUndefined()
      expect(database.prepare(`
        SELECT entity_sync_id,generation FROM sync_entity_tombstone
        WHERE sync_space_id=? AND entity_type='group' ORDER BY entity_sync_id
      `).all('space-alias')).toEqual([
        { entity_sync_id: 'a', generation: 0 },
        { entity_sync_id: 'b', generation: 0 }
      ])

      state.recordTombstone('space-alias', 'group', 'a', 1, 'newer-generation', 20)
      state.recordTombstone('space-alias', 'group', 'a', 0, 'stale-generation', 21)
      expect(database.prepare(`
        SELECT generation,version_token FROM sync_entity_tombstone
        WHERE sync_space_id=? AND entity_type='group' AND entity_sync_id='a'
      `).get('space-alias')).toEqual({ generation: 1, version_token: 'newer-generation' })
    } finally {
      database.close()
    }
  })

  it('captures Alias Edge through CORE_META outbox while LOCAL_EVICT stays local-only', () => {
    const { database, runtime, state, witness, coordinator } = fixture()
    try {
      const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
      const capture = new DesktopSyncAliasMutationCapture(database, runtime, coordinator, allocator)
      const payload = edge('a', 'b')
      const outbox = capture.capture(1, payload, 30)
      expect(outbox?.replicationLaneId).toBe('CORE_META')
      expect(outbox?.entityType).toBe('alias_edge')
      expect(database.prepare('SELECT COUNT(*) AS count FROM sync_alias_edge').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get()).toEqual({ count: 1 })

      const evictions = new DesktopSyncLocalEvictionService(database)
      evictions.markEvicted('space-alias', 'article', 'article-a', 0, 'full_content', 40)
      expect(evictions.isEvicted('space-alias', 'article', 'article-a', 0, 'full_content')).toBe(true)
      expect(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM sync_entity_tombstone').get()).toEqual({ count: 0 })
      expect(state.getCoverage('space-alias').received).toEqual({})
    } finally {
      database.close()
    }
  })
})
