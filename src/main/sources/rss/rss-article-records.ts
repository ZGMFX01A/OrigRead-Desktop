import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { DiscoveredRssFeed, RssFeedItem } from '../../../shared/rss'
import type { LibraryRepository } from '../../database/library-repository'
import type { RssArticleIdentity } from '../../database/library-subscription-metadata'
import { DEFAULT_GROUP_ID } from '../../database/migrations'

// 列表预览摘要长度，完整正文保存在 contentHtml。
const RSS_SUMMARY_LENGTH = 280

interface ArticleBatchOptions {
  feed: FeedRecord
  discovered: DiscoveredRssFeed
  now: number
}

/** 优先复用已保存的来源身份；升级首轮用原链接匹配旧 ID，保留阅读、收藏和全文状态。 */
export function prepareRssArticles(repository: LibraryRepository, options: ArticleBatchOptions): {
  articles: ArticleRecord[]; identities: RssArticleIdentity[]
} {
  const { feed, discovered, now } = options
  const identities = repository.getRssArticleIdentities(feed.id)
  const boundArticleIds = new Set(identities.values())
  // 链接匹配只用于尚未升级的旧文章，已确认的 GUID 不允许被另一个 GUID 共用。
  const existingByUrl = new Map(repository.listArticlesByFeedForAccount(feed.accountId!, feed.id)
    .filter((article) => article.url && !boundArticleIds.has(article.id)).map((article) => [article.url!, article.id]))
  const byId = new Map<string, ArticleRecord>()
  const resolved: RssArticleIdentity[] = []
  for (const item of discovered.items) {
    const knownId = identities.get(item.sourceId)
    const legacyId = knownId ? undefined : existingByUrl.get(item.link)
    const id = knownId ?? legacyId ?? stableArticleId(feed.id, item)
    if (legacyId) existingByUrl.delete(item.link)
    identities.set(item.sourceId, id)
    resolved.push({ sourceId: item.sourceId, articleId: id })
    if (!byId.has(id)) byId.set(id, { ...toArticleRecord(feed.id, item, { now, accountId: feed.accountId }), id })
  }
  const archivedIds = repository.archivedArticleIds(feed.id, [...byId.keys()])
  const archivedLinks = repository.archivedLinks(feed.id, [...byId.values()].map((article) => article.url))
  return {
    articles: [...byId.values()].filter((article) => !archivedIds.has(article.id) && (!article.url || !archivedLinks.has(article.url))),
    identities: resolved
  }
}

/** 来源 ID 全局唯一；账户与默认分组在请求开始时已由调用方固定。 */
export function toFeedRecord(feedId: string, discovered: DiscoveredRssFeed, options: {
  now: number; groupId?: string; accountId?: number
}): FeedRecord {
  return {
    id: feedId, accountId: options.accountId, groupId: options.groupId ?? DEFAULT_GROUP_ID,
    name: discovered.title, url: discovered.feedUrl, sourcePageUrl: discovered.sourcePageUrl,
    sourceType: 'rss', icon: discovered.iconUrl, isNotification: false, isFullContent: false,
    isBrowser: false, dynamicRendering: false, createdAt: options.now, updatedAt: options.now
  }
}

/** 新文章初始未读，后续 UPSERT 只更新内容字段，不覆盖用户阅读与收藏状态。 */
export function toArticleRecord(feedId: string, item: RssFeedItem, options: { now: number; accountId?: number }): ArticleRecord {
  const rawHtml = item.contentHtml ?? item.descriptionHtml
  return {
    id: stableArticleId(feedId, item), accountId: options.accountId, feedId,
    title: item.title, url: item.link || null, author: item.author,
    publishedAt: item.publishedAt ?? options.now,
    description: htmlToText(item.descriptionHtml || rawHtml).slice(0, RSS_SUMMARY_LENGTH),
    contentHtml: rawHtml || null, fullContentHtml: null, imageUrl: item.imageUrl,
    isUnread: true, isStarred: false, createdAt: options.now, updatedAt: options.now
  }
}

/** GUID / Atom ID 由解析器优先提供；链接只在没有上游身份时作为来源身份。 */
export function stableArticleId(feedId: string, item: RssFeedItem): string {
  return `rss-${createHash('sha256').update(feedId).update('\u0000').update(item.sourceId).digest('hex')}`
}

/** 列表摘要只保留纯文本，正文另行存储。 */
function htmlToText(html: string): string {
  if (!html) return ''
  return cheerio.load(`<body>${html}</body>`)('body').text().replace(/\s+/g, ' ').trim()
}
