import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { GenesisIdentityBackfillService } from './genesis-identity-backfill-service'
import { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopOperationBuilder } from './sync-operation-builder'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { MemorySecretStore } from '../security/secret-store'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('DesktopGenesisSnapshotService', () => {
  it('captures the Phase-A cut, persists lane shards, and replays no pre-cut outbox row', () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const identity = new SyncIdentityRepository(database.connection)
    const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'genesis-test')
    const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
    const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
    const signingKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const dir = mkdtempSync(join(tmpdir(), 'origread-genesis-snapshot-'))
    tempDirs.push(dir)
    const filters = new ArticleFilterRepository(join(dir, 'filters.json'))
    const service = new DesktopGenesisSnapshotService(
      database.connection,
      runtime,
      coordinator,
      filters,
      new GenesisIdentityBackfillService(database.connection, filters),
      undefined,
      signingKeys
    )

    try {
      database.connection.exec(`
        INSERT INTO feeds(
          id,account_id,group_id,name,url,source_type,is_notification,is_full_content,is_browser,
          dynamic_rendering,created_at,updated_at
        ) VALUES('feed-genesis',1,'1$origread_app_default_group','Feed','https://example.com/feed','rss',0,0,0,0,1,1);
        INSERT INTO articles(
          id,account_id,feed_id,title,description,is_unread,is_starred,created_at,updated_at
        ) VALUES('article-genesis',1,'feed-genesis','Article','Description',1,0,1,1);
      `)

      coordinator.prepareSpace(1, 'space-genesis', 100)
      const context = coordinator.beginGenesisCapture(1, 'genesis-session-1', 101)
      runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', {
        entityType: 'article',
        entitySyncId: 'article-genesis',
        mutationType: 'FIELD_SET',
        payloadJson: JSON.stringify({ field: 'isUnread', value: false })
      }, [], 102))
      expect(new DesktopOperationBuilder(runtime, { strictAuth: false }).buildPending('space-genesis', 100, 102)).toBe(1)
      coordinator.rotateActor(1, 'pre-genesis rollback-safe actor rotation', 103)

      const result = service.run(1, 'space-genesis', 'genesis-session-1', 200)
      expect(result.syncSpaceId).toBe('space-genesis')
      expect(result.genesisSessionId).toBe('genesis-session-1')
      expect(runtime.findBinding(1)).toMatchObject({ lifecycleState: 'ACTIVE', genesisSessionId: null })
      expect(runtime.findGenesisSession('genesis-session-1')).toMatchObject({ stage: 'ACTIVE' })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM sync_snapshot_shard WHERE snapshot_bundle_id=?')
        .get(result.snapshotBundleId)).toEqual({ count: 6 })
      expect(database.connection.prepare('SELECT status,genesis_included_at FROM sync_outbox WHERE outbox_id=?')
        .get(`${context.actorIncarnationId}:ARTICLE_STATE:1`)).toMatchObject({ status: 'BUILT', genesis_included_at: 200 })
      expect(runtime.listPendingOutbox('space-genesis')).toEqual([])
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM sync_operation_log').get()).toEqual({ count: 1 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM sync_genesis_operation_coverage').get()).toEqual({ count: 1 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM sync_identity_mapping WHERE sync_space_id=?')
        .get('space-genesis')).toMatchObject({ count: 4 })

      const activeContext = coordinator.currentWritableContext(1, 201)!
      const tail = runtime.transaction(() => allocator.allocate(activeContext, 'ARTICLE_STATE', {
        entityType: 'article',
        entitySyncId: 'article-genesis',
        mutationType: 'FIELD_SET',
        payloadJson: JSON.stringify({ field: 'isStarred', value: true })
      }, [], 201))
      const observed = JSON.parse(tail.causalContextJson).observedGenesisBaselinesByLane.ARTICLE_STATE
      expect(observed).toHaveLength(1)
      expect(observed[0]).toBe(result.genesisBaselineId)
      expect(new DesktopOperationBuilder(runtime, { strictAuth: false }).buildPending('space-genesis', 100, 202)).toBe(1)
      expect(runtime.listPendingOutbox('space-genesis')).toEqual([])
    } finally {
      database.close()
    }
  })
})
