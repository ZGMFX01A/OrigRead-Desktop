import { ImageOff } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import './article-thumbnail.css'

const MAX_FAILED_THUMBNAILS = 200

/** Keep failed URLs across virtual row remounts, only for the current source scope. */
export class ArticleThumbnailFailureCache {
  private readonly failed = new Map<string, true>()
  private readonly listeners = new Set<() => void>()

  has(url: string): boolean { return this.failed.has(url) }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  remember(url: string): void {
    const existed = this.failed.delete(url)
    this.failed.set(url, true)
    if (this.failed.size > MAX_FAILED_THUMBNAILS) {
      const oldest = this.failed.keys().next().value
      if (oldest !== undefined) this.failed.delete(oldest)
    }
    if (!existed) this.notify()
  }

  clear(): void {
    if (this.failed.size === 0) return
    this.failed.clear()
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export function ArticleThumbnail({ url, failures }: { url: string; failures: ArticleThumbnailFailureCache }) {
  const failed = useSyncExternalStore(failures.subscribe, () => failures.has(url), () => failures.has(url))
  return <span className={'article-thumbnail' + (failed ? ' article-thumbnail-failed' : '')} aria-hidden="true">
    {failed ? <ImageOff size={20} /> : <img src={url} width={80} height={60} alt="" loading="lazy" decoding="async"
      draggable={false} onError={() => failures.remember(url)} />}
  </span>
}
