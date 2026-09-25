import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { GenesisIdentityBackfillService } from './genesis-identity-backfill-service'
import { SyncIdentityRepository } from './sync-identity-repository'
import { feedCanonicalKey } from './sync-canonical-identity'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GenesisIdentityBackfillService', () => {
  it('backfills Local Library + Chat identities idempotently and keeps dangling article refs resolvable', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    applyMigrations(db)
    db.exec(`
      INSERT INTO accounts(id,name,type,created_at) VALUES(2,'Genesis','local',1);
      INSERT INTO groups(id,account_id,name,sort_order,is_default)
        VALUES('group-local',2,'G',0,0);
      INSERT INTO feeds(
        id,account_id,group_id,name,url,source_page_url,source_type,icon,
        is_notification,is_full_content,is_browser,dynamic_rendering,created_at,updated_at
      ) VALUES(
        'feed-local',2,'group-local','Feed','HTTPS://Example.COM:443/feed/?utm_source=x&b=2#frag',NULL,'rss',NULL,
        0,0,0,0,1,1
      );
      INSERT INTO articles(
        id,account_id,feed_id,title,url,author,published_at,description,content_html,full_content_html,image_url,
        is_unread,is_starred,created_at,updated_at
      ) VALUES(
        'article-local',2,'feed-local','A','https://EXAMPLE.com/post/42/?utm_medium=x#part',NULL,1,'','',NULL,NULL,
        1,0,1,1
      );
      INSERT INTO llm_conversations(id,title,article_id,article_title,article_link,created_at,updated_at)
        VALUES('11111111-1111-4111-8111-111111111111','Chat','missing-article','Missing','https://example.com/missing',1,1);
      INSERT INTO llm_conversation_articles(
        conversation_id,article_id,title,link,original_content,summary,position,created_at
      ) VALUES(
        '11111111-1111-4111-8111-111111111111','missing-article','Missing','https://example.com/missing','snapshot',NULL,0,1
      );
      INSERT INTO llm_messages(id,conversation_id,role,content,created_at,updated_at)
        VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','USER','hello',2,2);
    `)

    const dir = mkdtempSync(join(tmpdir(), 'origread-genesis-'))
    tempDirs.push(dir)
    const filters = new ArticleFilterRepository(join(dir, 'filters.json'))
    filters.add('blocked')
    const service = new GenesisIdentityBackfillService(db, filters)
    const identities = new SyncIdentityRepository(db)

    const first = service.backfill('space-1', 2, 100)
    expect(first.created).toBeGreaterThan(0)
    expect(first.conflicts).toEqual([])
    const feed = identities.findByLocalId('space-1', 'feed', 'feed-local')!
    expect(feed.canonicalKey).toBe('feed:v1:5db48e420506f52ed082918bb7489132f060cac350554a79696de83908b28309')
    const actualArticle = identities.findByLocalId('space-1', 'article', 'article-local')!
    expect(actualArticle.canonicalKey).toBe('article:v1:3fe23e061e57a17896fd9bb1e52e1b9845f0c48e38c237b088ad24a5191ca789')
    const dangling = identities.findByLocalId('space-1', 'article', 'missing-article')!
    expect(dangling.canonicalKey).toBeNull()
    expect(identities.findByLocalId('space-1', 'conversation', '11111111-1111-4111-8111-111111111111')?.syncId)
      .toBe('11111111-1111-4111-8111-111111111111')
    expect(identities.listByType('space-1', 'conversation_article')).toHaveLength(1)

    const beforeRetry = new Map(
      ['feed', 'article', 'conversation', 'message', 'conversation_article'].flatMap((type) =>
        identities.listByType('space-1', type as Parameters<SyncIdentityRepository['listByType']>[1])
          .map((mapping) => [`${mapping.entityType}:${mapping.localId}`, mapping.syncId] as const)
      )
    )
    const second = service.backfill('space-1', 2, 200)
    expect(second.created).toBe(0)
    const afterRetry = new Map(
      ['feed', 'article', 'conversation', 'message', 'conversation_article'].flatMap((type) =>
        identities.listByType('space-1', type as Parameters<SyncIdentityRepository['listByType']>[1])
          .map((mapping) => [`${mapping.entityType}:${mapping.localId}`, mapping.syncId] as const)
      )
    )
    expect(afterRetry).toEqual(beforeRetry)

    db.prepare('UPDATE feeds SET url=? WHERE id=?').run('https://example.com/other-feed', 'feed-local')
    const changed = service.backfill('space-1', 2, 300)
    expect(changed.conflicts.some((conflict) => conflict.entityType === 'feed' && conflict.localId === 'feed-local')).toBe(true)
    expect(identities.findByLocalId('space-1', 'feed', 'feed-local')?.canonicalKey).toBe(feed.canonicalKey)
    expect(identities.findByLocalId('space-1', 'feed', 'feed-local')?.canonicalKey)
      .not.toBe(feedCanonicalKey('rss', 'https://example.com/other-feed'))
    db.close()
  })

  it('rejects remote-account Library backfill in R10 phase A', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    db.exec("INSERT INTO accounts(id,name,type,created_at) VALUES(2,'Remote','fresh_rss',1)")
    const dir = mkdtempSync(join(tmpdir(), 'origread-genesis-'))
    tempDirs.push(dir)
    const service = new GenesisIdentityBackfillService(db, new ArticleFilterRepository(join(dir, 'filters.json')))
    expect(() => service.backfill('space-1', 2)).toThrow(/only supports Local Account/)
    db.close()
  })
})
