import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { sourceUrlComparisonKey } from '../../../shared/source-url-normalizer'
import { RssDiscoveryService } from './rss-discovery-service'
import { RssSubscriptionService, toArticleRecord } from './rss-subscription-service'
import { withLibrary, rssXml, atomXml, rssPayload, rssDiscovery } from '../subscription-regression-support'

describe('Android 审查问题在桌面 RSS 链路的回归', () => {
  it('区分非根路径末尾斜杠，仍合并根路径和跟踪参数', () => {
    expect(sourceUrlComparisonKey('https://example.com/feed')).not.toBe(sourceUrlComparisonKey('https://example.com/feed/'))
    expect(sourceUrlComparisonKey('https://EXAMPLE.com/?utm_source=x')).toBe(sourceUrlComparisonKey('https://example.com'))
  })

  it('重定向页面中的相对 alternate 按最终页面 URL 解析', async () => {
    const requested: string[] = []
    const service = new RssDiscoveryService(async (url) => {
      requested.push(url)
      if (url === 'https://old.example.com/start') return rssPayload('https://new.example.com/news/',
        '<html><head><link rel="alternate" type="application/atom+xml" href="feed.xml"></head></html>')
      if (url === 'https://new.example.com/news/feed.xml') return rssPayload(url, rssXml([{ title: 'New article', link: 'https://new.example.com/1' }]))
      throw new Error(`Unexpected request: ${url}`)
    }, { findBestIcon: async () => null })
    const discovered = await service.discover('https://old.example.com/start')
    expect(requested).toEqual(['https://old.example.com/start', 'https://new.example.com/news/feed.xml'])
    expect(discovered.sourcePageUrl).toBe('https://new.example.com/news/')
  })

  it('有 GUID 的文章更新链接时维持同一条记录和阅读收藏状态', async () => withLibrary(async (library) => {
    let content = rssXml([{ guid: 'permanent', title: 'Original', link: 'https://example.com/old' }])
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/rss')
    const article = library.listArticlesByFeed(added.feedId)[0]!
    library.setArticleUnread(article.id, false)
    library.setArticleStarred(article.id, true)
    content = rssXml([{ guid: 'permanent', title: 'Edited', link: 'https://example.com/new' }])
    await service.refresh(added.feedId)
    expect(library.listArticlesByFeed(added.feedId)).toEqual([expect.objectContaining({
      id: article.id, title: 'Edited', url: 'https://example.com/new', isUnread: false, isStarred: true
    })])
  }))

  it.each([true, false])('Atom ID 保留文章身份，即使链接或无链接文章的内容发生变化：%s', async (hasLink) => withLibrary(async (library) => {
    let content = atomXml({ id: 'urn:origread:entry', title: 'Original', link: hasLink ? 'https://example.com/old' : undefined })
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/atom')
    const article = library.listArticlesByFeed(added.feedId)[0]!
    library.setArticleUnread(article.id, false)
    library.setArticleStarred(article.id, true)
    content = atomXml({ id: 'urn:origread:entry', title: 'Edited', link: hasLink ? 'https://example.com/new' : undefined })
    expect((await service.refresh(added.feedId)).insertedArticles).toBe(0)
    expect(library.listArticlesByFeed(added.feedId)).toEqual([expect.objectContaining({
      id: article.id, title: 'Edited', isUnread: false, isStarred: true
    })])
  }))

  it.each([true, false])('不同 GUID 共用链接仍分别保存，不套用其他文章的本地状态：%s', async (includeOriginal) => withLibrary(async (library) => {
    const original = { guid: 'A', title: 'Original', link: 'https://example.com/shared' }
    const next = { guid: 'B', title: 'Next', link: original.link }
    let content = rssXml([original])
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/rss')
    const originalId = library.listArticlesByFeed(added.feedId)[0]!.id
    library.setArticleUnread(originalId, false)
    library.setArticleStarred(originalId, true)
    content = rssXml(includeOriginal ? [original, next] : [next])
    expect((await service.refresh(added.feedId)).insertedArticles).toBe(1)
    const articles = library.listArticlesByFeed(added.feedId)
    expect(articles).toHaveLength(2)
    expect(articles.find((article) => article.id === originalId)).toMatchObject({ title: 'Original', isUnread: false, isStarred: true })
    expect(articles.find((article) => article.title === 'Next')).toMatchObject({ isUnread: true, isStarred: false })
  }))

  it('无 GUID 或链接的条目以 content:encoded 区分正文', async () => withLibrary(async (library) => {
    const content = rssXml([{ title: 'Same title' }, { title: 'Same title' }])
      .replace('<rss version="2.0">', '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">')
      .replace('<description>Article body</description>', '<content:encoded><![CDATA[<p>First body</p>]]></content:encoded>')
      .replace('<description>Article body</description>', '<content:encoded><![CDATA[<p>Second body</p>]]></content:encoded>')
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/rss')
    expect(library.listArticlesByFeed(added.feedId).map((article) => article.contentHtml).sort())
      .toEqual(['<p>First body</p>', '<p>Second body</p>'])
  }))

  it('无链接且无 GUID 的文章顺序改变时仍使用稳定身份', async () => withLibrary(async (library) => {
    const items = [{ title: 'Article one' }, { title: 'Article two' }]
    let content = rssXml(items)
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/rss')
    content = rssXml([...items].reverse())
    expect((await service.refresh(added.feedId)).insertedArticles).toBe(0)
    expect(library.listArticlesByFeed(added.feedId)).toHaveLength(2)
  }))

  it('无链接文章的未来发布日期不使身份随刷新时钟变化', async () => withLibrary(async (library) => {
    const referenceTime = Date.UTC(2026, 9, 4, 8)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(referenceTime)
    try {
      const content = rssXml([{ title: 'Scheduled article' }])
        .replace('Mon, 03 Aug 2026 08:00:00 GMT', 'Sat, 10 Oct 2026 08:00:00 GMT')
      const service = new RssSubscriptionService(library, rssDiscovery(() => content))
      const added = await service.add('https://example.com/rss')
      const originalId = library.listArticlesByFeed(added.feedId)[0]!.id
      clock.mockReturnValue(referenceTime + 1)
      expect((await service.refresh(added.feedId)).insertedArticles).toBe(0)
      expect(library.listArticlesByFeed(added.feedId).map((article) => article.id)).toEqual([originalId])
    } finally {
      clock.mockRestore()
    }
  }))

  it('归档无链接文章后，下一轮 RSS 刷新不会重新插入', async () => withLibrary(async (library) => {
    const content = rssXml([{ guid: 'linkless', title: 'Linkless article' }])
    const service = new RssSubscriptionService(library, rssDiscovery(() => content))
    const added = await service.add('https://example.com/rss')
    const article = library.listArticlesByFeed(added.feedId)[0]!
    library.setArticleUnread(article.id, false)
    const now = Date.now() + 10_000
    expect(library.archiveExpiredArticlesForAccount(1, 1_000, now)).toBe(1)
    await service.refresh(added.feedId, now)
    expect(library.listArticlesByFeed(added.feedId)).toEqual([])
  }))

  it('刷新普通 RSS 时不再查询图标网站', async () => withLibrary(async (library) => {
    const icon = vi.fn(async () => null)
    const xml = rssXml([{ guid: '1', title: 'One', link: 'https://example.com/1' }])
    const discovery = new RssDiscoveryService(async (url) => rssPayload(url, xml), { findBestIcon: icon })
    const service = new RssSubscriptionService(library, discovery)
    const added = await service.add('https://example.com/rss')
    icon.mockClear()
    await service.refresh(added.feedId)
    expect(icon).not.toHaveBeenCalled()
  }))

  it('首轮升级刷新复用旧版链接哈希 ID，不重置已读收藏', async () => withLibrary(async (library, database) => {
    const xml = rssXml([{ guid: 'stable-guid', title: 'One', link: 'https://example.com/1' }])
    const discovery = rssDiscovery(() => xml)
    const service = new RssSubscriptionService(library, discovery)
    const added = await service.add('https://example.com/rss')
    const item = (await discovery.parseDirect('https://example.com/rss')).items[0]!
    const legacyId = `rss-${createHash('sha256').update(added.feedId).update('\u0000').update(item.link).digest('hex')}`
    library.deleteArticlesByFeed(added.feedId, true)
    // v13 只有旧链接哈希记录，没有 v14 的来源身份映射。
    database.connection.prepare('DELETE FROM rss_article_identities WHERE feed_id = ?').run(added.feedId)
    library.upsertArticle({ ...toArticleRecord(added.feedId, item, { now: Date.now(), accountId: 1 }), id: legacyId, isUnread: false, isStarred: true })
    await service.refresh(added.feedId)
    expect(library.listArticlesByFeed(added.feedId)).toEqual([expect.objectContaining({ id: legacyId, isUnread: false, isStarred: true })])
  }))
})
