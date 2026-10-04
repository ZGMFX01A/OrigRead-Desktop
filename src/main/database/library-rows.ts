import type { DatabaseSync } from 'node:sqlite'
import type { ArticleRecord, FeedRecord, GroupRecord, ArticleSearchMatchField, SourceType } from '../../shared/library'

export type PreparedStatement = ReturnType<DatabaseSync['prepare']>
// 分批执行完整 ID 集合，避免 SQLite 参数数上限；不是文章数量截断。
export const ARTICLE_ID_QUERY_CHUNK_SIZE = 800

export interface RssHttpCacheRecord {
  feedId: string
  feedUrl: string
  etag: string | null
  lastModified: string | null
  updatedAt: number
}

export interface ArticleMetadataRecord {
  id: string
  feedName: string
  title: string
  url: string | null
  publishedAt: number | null
}

export interface GroupRow {
  id: string
  account_id: number
  name: string
  sort_order: number
  is_default: number
}

export interface FeedRow {
  id: string
  account_id: number
  group_id: string
  name: string
  url: string
  source_page_url: string | null
  source_type: SourceType
  icon: string | null
  is_notification: number
  is_full_content: number
  is_browser: number
  dynamic_rendering: number
  created_at: number
  updated_at: number
}

export interface ArticleRow {
  id: string
  account_id: number
  feed_id: string
  title: string
  url: string | null
  author: string | null
  published_at: number | null
  description: string
  content_html: string | null
  full_content_html: string | null
  image_url: string | null
  is_unread: number
  is_starred: number
  created_at: number
  updated_at: number
}

export interface ArticleSearchRow {
  id: string
  feed_id: string
  feed_name: string
  title: string
  author: string | null
  url: string | null
  published_at: number | null
  is_unread: number
  is_starred: number
  match_field: ArticleSearchMatchField
  matched_text: string | null
}

export function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function articleMetadataFromRow(row: {
  id: string
  feed_name: string
  title: string
  url: string | null
  published_at: number | null
}): ArticleMetadataRecord {
  return {
    id: row.id,
    feedName: row.feed_name,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at
  }
}

export function makeSearchSnippet(value: string, query: string): string {
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''

  const lowerText = text.toLocaleLowerCase()
  const lowerQuery = query.toLocaleLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index < 0) return text.slice(0, 180)

  const start = Math.max(0, index - 72)
  const end = Math.min(text.length, index + query.length + 108)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function toGroupRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    sortOrder: row.sort_order,
    isDefault: row.is_default === 1
  }
}

export function toFeedRecord(row: FeedRow): FeedRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    groupId: row.group_id,
    name: row.name,
    url: row.url,
    sourcePageUrl: row.source_page_url,
    sourceType: row.source_type,
    icon: row.icon,
    isNotification: row.is_notification === 1,
    isFullContent: row.is_full_content === 1,
    isBrowser: row.is_browser === 1,
    dynamicRendering: row.dynamic_rendering === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function toArticleRecord(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    feedId: row.feed_id,
    title: row.title,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    description: row.description,
    contentHtml: row.content_html,
    fullContentHtml: row.full_content_html,
    imageUrl: row.image_url,
    isUnread: row.is_unread === 1,
    isStarred: row.is_starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
