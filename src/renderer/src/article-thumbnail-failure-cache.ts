/**
 * Exact failures for the URLs in the current loaded source scope, not a scrolling LRU.
 * Both URL sets are bounded by that dataset; removed URLs and old scopes are discarded.
 */
export class ArticleThumbnailFailureCache {
  private urls: Set<string>
  private readonly failed = new Set<string>()
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(urls: Iterable<string>, private online = true) {
    this.urls = new Set(urls)
  }

  get size(): number { return this.failed.size }
  has(url: string): boolean { return this.failed.has(url) }
  isBlocked(url: string): boolean { return !this.online || this.has(url) }

  subscribe(url: string, listener: () => void): () => void {
    let listeners = this.listeners.get(url)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(url, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(url)
    }
  }

  /** Use the unfiltered loaded scope so search/unread filters cannot forget failed images. */
  retainUrls(urls: Iterable<string>): void {
    this.urls = new Set(urls)
    for (const url of this.failed) {
      if (!this.urls.has(url)) {
        this.failed.delete(url)
        this.notify(url)
      }
    }
  }

  remember(url: string): void {
    // Ignore late errors from removed data and failures caused by a known offline state.
    if (!this.online || !this.urls.has(url) || this.failed.has(url)) return
    this.failed.add(url)
    this.notify(url)
  }

  /** A source refresh explicitly allows one new attempt for each failed URL. */
  clear(): void {
    const failed = [...this.failed]
    this.failed.clear()
    for (const url of failed) this.notify(url)
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    // Connectivity changes affect every mounted image, without forgetting prior HTTP failures.
    for (const url of this.listeners.keys()) this.notify(url)
  }

  private notify(url: string): void {
    for (const listener of this.listeners.get(url) ?? []) listener()
  }
}
