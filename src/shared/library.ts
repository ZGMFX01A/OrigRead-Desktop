export type SourceType = 'rss' | 'website' | 'json'

export interface GroupRecord {
  id: string
  accountId?: number
  name: string
  sortOrder: number
  isDefault: boolean
}

export interface FeedRecord {
  id: string
  accountId?: number
  groupId: string
  name: string
  url: string
  sourcePageUrl: string | null
  sourceType: SourceType
  icon: string | null
  isNotification: boolean
  isFullContent: boolean
  isBrowser: boolean
  dynamicRendering: boolean
  createdAt: number
  updatedAt: number
}

export interface FeedArticleStats {
  feedId: string
  total: number
  unread: number
  starred: number
}

export interface ArticleRecord {
  id: string
  accountId?: number
  feedId: string
  title: string
  url: string | null
  author: string | null
  publishedAt: number | null
  description: string
  contentHtml: string | null
  fullContentHtml: string | null
  imageUrl: string | null
  isUnread: boolean
  isStarred: boolean
  createdAt: number
  updatedAt: number
}

export type ArticleSearchMatchField = 'title' | 'description' | 'content'

export interface ArticleSearchResult {
  id: string
  feedId: string
  feedName: string
  title: string
  author: string | null
  url: string | null
  publishedAt: number | null
  isUnread: boolean
  isStarred: boolean
  matchField: ArticleSearchMatchField
  snippet: string
}

export interface LibrarySnapshot {
  groups: number
  feeds: number
  articles: number
  unread: number
  starred: number
}

