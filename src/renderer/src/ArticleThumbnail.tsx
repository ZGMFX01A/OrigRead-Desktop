import { ImageOff } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { resolveArticleImageUrl } from '../../shared/article-image-url'
import { ArticleThumbnailFailureCache } from './article-thumbnail-failure-cache'
import './article-thumbnail.css'

export { ArticleThumbnailFailureCache } from './article-thumbnail-failure-cache'

export function useArticleThumbnailFailures(
  scope: string,
  articles: readonly ArticleRecord[],
  feeds: readonly FeedRecord[],
  refreshing: boolean
): ArticleThumbnailFailureCache {
  const urls = useMemo(() => {
    const feedsById = new Map(feeds.map(feed => [feed.id, feed]))
    const urls = new Set<string>()
    for (const article of articles) {
      const feed = feedsById.get(article.feedId)
      const url = resolveArticleImageUrl(article.imageUrl, {
        articleUrl: article.url, sourcePageUrl: feed?.sourcePageUrl, feedUrl: feed?.url
      })
      if (url) urls.add(url)
    }
    return urls
  }, [articles, feeds])
  // Filtering and virtual row remounts do not create a new failure scope.
  const failures = useMemo(() => new ArticleThumbnailFailureCache(urls, navigator.onLine !== false), [scope])
  useLayoutEffect(() => { failures.retainUrls(urls) }, [failures, urls])
  useEffect(() => {
    const updateOnline = (): void => { failures.setOnline(navigator.onLine !== false) }
    updateOnline()
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [failures])
  useEffect(() => { if (refreshing) failures.clear() }, [failures, refreshing])
  return failures
}

export function ArticleThumbnail({ url, failures }: { url: string; failures: ArticleThumbnailFailureCache }) {
  const subscribe = useCallback((listener: () => void) => failures.subscribe(url, listener), [failures, url])
  const snapshot = useCallback(() => failures.isBlocked(url), [failures, url])
  const blocked = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  // Going offline prevents new attempts, but keeps an already displayed image in place.
  const failed = blocked && loadedUrl !== url
  return <span className={'article-thumbnail' + (failed ? ' article-thumbnail-failed' : '')} aria-hidden="true">
    {failed ? <ImageOff size={20} /> : <img src={url} width={80} height={60} alt="" loading="lazy" decoding="async"
      referrerPolicy="no-referrer" draggable={false} onLoad={() => setLoadedUrl(url)} onError={() => {
        setLoadedUrl(null)
        if (navigator.onLine === false) failures.setOnline(false)
        else failures.remember(url)
      }} />}
  </span>
}
