export interface RssFeedItem {
  sourceId: string
  title: string
  link: string
  author: string | null
  publishedAt: number | null
  descriptionHtml: string
  contentHtml: string | null
  imageUrl: string | null
}

export interface DiscoveredRssFeed {
  feedUrl: string
  sourcePageUrl: string
  discoveredFromPage: boolean
  etag?: string | null
  lastModified?: string | null
  title: string
  siteUrl: string | null
  iconUrl: string | null
  items: RssFeedItem[]
}

export interface RssSubscriptionResult {
  feedId: string
  feed: DiscoveredRssFeed
  insertedArticles: number
}

