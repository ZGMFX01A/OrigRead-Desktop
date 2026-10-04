import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountRepository } from '../accounts/account-repository'
import { MemorySecretStore } from '../security/secret-store'
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../database/migrations'
import { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import type { RssHubResolver } from './rsshub/rsshub-resolver'
import type { RssHubProbeResult } from '../../shared/rsshub'
import { JsonSubscriptionService } from './json/json-subscription-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { RssDiscoveryService } from './rss/rss-discovery-service'
import { WebsiteSourceService } from './website/website-source-service'
import { WebsiteSubscriptionService } from './website/website-subscription-service'
import { WebsiteRuleRepository } from './website/website-rule-repository'
import { WebsiteParsePreferenceRepository } from './website/website-parse-preference-repository'
import { discoveryFlow, rssDiscovery, rssXml, jsonSource, withLibrary } from './subscription-regression-support'

describe('订阅元数据与批次的原子性', () => {
  it('JSON 规则写入失败时来源和首批文章一起回滚', async () => withLibrary(async (library, database) => {
    const { source } = jsonSource(() => '[{"id":1,"link":"https://example.com/1","title":{"rendered":"One"}}]')
    const probe = (await source.probe('https://example.com/wp-json/wp/v2/posts'))!
    database.connection.exec(`CREATE TRIGGER reject_json_rule BEFORE INSERT ON json_feed_rules
      BEGIN SELECT RAISE(ABORT, 'JSON rule write failed'); END;`)
    const before = library.snapshot()
    await expect(new JsonSubscriptionService(library, source).add(probe)).rejects.toThrow('JSON rule write failed')
    expect(library.snapshot()).toEqual(before)
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM json_feed_rules').get()).toEqual({ count: 0 })
  }))

  it('网站解析偏好文件写入失败时不留下来源和首批文章', async () => withLibrary(async (library) => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-subscription-atomic-'))
    try {
      const html = readFileSync(join(process.cwd(), 'src/main/testing/fixtures/website-samples/url-clusters.html'), 'utf8')
      const source = new WebsiteSourceService(new WebsiteRuleRepository(join(directory, 'rules.json')),
        new WebsiteParsePreferenceRepository(directory), {
          fetcher: async () => ({ status: 200, finalUrl: 'https://news.example.com/', html })
        })
      const inspection = await source.inspect('https://news.example.com/')
      const before = library.snapshot()
      // 将目录作为偏好文件，触发真实文件系统写入失败，而非伪造订阅成功。
      await expect(new WebsiteSubscriptionService(library, source).add(inspection)).rejects.toThrow()
      expect(library.snapshot()).toEqual(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }))

  it('v13 增量迁移保留文章状态、HTTP 缓存和旧归档 URL', async () => withLibrary(async (library, database) => {
    const feed = library.listFeeds()[0]!
    library.upsertFeedWithArticles(feed, [{
      id: 'v13-article', feedId: feed.id, accountId: 1, title: 'Existing article',
      url: 'https://example.com/existing', author: null, publishedAt: 10, description: 'Existing description',
      contentHtml: '<p>Existing content</p>', fullContentHtml: '<article>Reader cache</article>', imageUrl: null,
      isUnread: false, isStarred: true, createdAt: 10, updatedAt: 20
    }])
    database.connection.exec(`DROP TABLE json_feed_rules; DROP TABLE rss_article_identities; DROP TABLE archived_article_ids;
      DELETE FROM schema_migrations WHERE version = 14;`)
    database.connection.prepare('INSERT INTO archived_articles(feed_id,link,archived_at) VALUES(?,?,?)').run(feed.id, 'https://example.com/archived', 10)
    library.upsertFeedWithArticles(feed, [], { rssHttpCache: { feedId: feed.id, feedUrl: feed.url, etag: 'old-etag', lastModified: null, updatedAt: 10 } })
    expect(applyMigrations(database.connection)).toBe(CURRENT_SCHEMA_VERSION)
    expect(library.getRssHttpCache(feed.id)?.etag).toBe('old-etag')
    expect(library.getArticleById('v13-article')).toMatchObject({
      isUnread: false, isStarred: true, fullContentHtml: '<article>Reader cache</article>', createdAt: 10, updatedAt: 20
    })
    expect(library.archivedLinks(feed.id, ['https://example.com/archived'])).toEqual(new Set(['https://example.com/archived']))
    expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }))

  it('第二个 RSSHub 频道写入失败撤销整批，随后可以用同一会话重试', async () => withLibrary(async (library, database) => {
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const xml = rssXml([{ guid: 'one', title: 'One', link: 'https://example.com/1' }])
    const parsed = await rssDiscovery(() => xml).parseDirect('https://hub.example.com/one')
    const results: RssHubProbeResult[] = ['First', 'Second'].map((name, i) => ({
      state: 'available', available: true, message: null, instanceBaseUrl: 'https://hub.example.com', routePath: '/route/' + i,
      feed: { ...parsed, title: name, feedUrl: 'https://hub.example.com/' + i },
      match: { route: { id: 'route-' + i, name, host: 'example.com', pathPrefix: '/', target: '/route/' + i },
        feedUrl: 'https://hub.example.com/' + i, parameters: {}, missingParameters: [], resolved: true }
    }))
    const rss = new RssDiscoveryService(async () => { throw new Error('Not an XML page') }, { findBestIcon: async () => null })
    const resolver = { knownInstanceUrls: () => [], localRouteDiagnostics: () => [], probe: async () => results } as unknown as RssHubResolver
    const { service } = discoveryFlow({ rss, subscription: new RssSubscriptionService(library, rss), current: () => accounts.current(),
      rssHubResolver: resolver, rssHubSubscription: new RssHubSubscriptionService(library) })
    const discovered = await service.discover('https://example.com/news')
    const ids = discovered.candidates.map((candidate) => candidate.id)
    expect(ids).toHaveLength(2)
    const before = library.snapshot()
    database.connection.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON feeds WHEN NEW.name = 'Second'
      BEGIN SELECT RAISE(ABORT, 'Second feed write failed'); END;`)
    await expect(service.subscribeMany(discovered.discoveryId, ids)).rejects.toThrow('Second feed write failed')
    expect(library.snapshot()).toEqual(before)
    expect(library.listRssHubDescriptors()).toEqual({})
    database.connection.exec('DROP TRIGGER reject_second')
    expect(await service.subscribeMany(discovered.discoveryId, ids)).toHaveLength(2)
    expect(library.listArticles()).toHaveLength(2)
  }))
})
