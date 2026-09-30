import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { MemorySecretStore } from '../security/secret-store'
import { DesktopLibrarySyncMutationCapture } from './library-sync-mutation-capture'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('DesktopLibrarySyncMutationCapture join bootstrap', () => {
  it('force-emits complete current fields instead of an empty UPSERT diff', () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const identities = new SyncIdentityRepository(database.connection)
    const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'force-bootstrap-test')
    const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identities, witness)
    const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
    const blobDir = mkdtempSync(join(tmpdir(), 'origread-force-bootstrap-'))
    tempDirs.push(blobDir)
    const capture = new DesktopLibrarySyncMutationCapture(
      database.connection,
      runtime,
      coordinator,
      allocator,
      new DesktopSyncLocalBlobStore(blobDir)
    )

    try {
      database.connection.exec(`
        INSERT INTO feeds(
          id,account_id,group_id,name,url,source_type,is_notification,is_full_content,is_browser,
          dynamic_rendering,created_at,updated_at
        ) VALUES('feed-force',1,'1$origread_app_default_group','Feed Force','https://example.com/force','rss',0,0,0,0,1,1);
        INSERT INTO articles(
          id,account_id,feed_id,title,url,description,is_unread,is_starred,is_read_later,created_at,updated_at
        ) VALUES('article-force',1,'feed-force','Article Force','https://example.com/force/1','Description',1,0,0,1,1);
      `)

      coordinator.prepareSpace(1, 'space-force', 100)
      coordinator.markActive(1, 101)

      expect(capture.bootstrapCurrentLibraryState(1)).toBe(true)

      const group = database.connection.prepare(`
        SELECT payload_json
        FROM sync_outbox
        WHERE sync_space_id=? AND entity_type='group' AND mutation_type='UPSERT'
        ORDER BY sequence LIMIT 1
      `).get('space-force') as { payload_json: string }
      const feed = database.connection.prepare(`
        SELECT payload_json
        FROM sync_outbox
        WHERE sync_space_id=? AND entity_type='feed' AND mutation_type='UPSERT'
        ORDER BY sequence LIMIT 1
      `).get('space-force') as { payload_json: string }
      const article = database.connection.prepare(`
        SELECT payload_json
        FROM sync_outbox
        WHERE sync_space_id=? AND entity_type='article' AND mutation_type='UPSERT'
        ORDER BY sequence LIMIT 1
      `).get('space-force') as { payload_json: string }

      expect(JSON.parse(group.payload_json)).toMatchObject({ fields: { name: 'Default' } })
      expect(JSON.parse(feed.payload_json)).toMatchObject({
        fields: { name: 'Feed Force', url: 'https://example.com/force', sourceType: 'rss' }
      })
      expect(JSON.parse(article.payload_json)).toMatchObject({
        fields: {
          title: 'Article Force',
          url: 'https://example.com/force/1',
          isUnread: true,
          isStarred: false,
          isReadLater: false
        }
      })
      expect(capture.bootstrapCurrentLibraryState(1)).toBe(false)
    } finally {
      database.close()
    }
  })
})
