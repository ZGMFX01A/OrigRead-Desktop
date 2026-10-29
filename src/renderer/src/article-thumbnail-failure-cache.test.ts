import { describe, expect, it, vi } from 'vitest'
import { ArticleThumbnailFailureCache } from './article-thumbnail-failure-cache'

describe('ArticleThumbnailFailureCache', () => {
  it('retains more than 200 failures for repeated virtual scroll passes without blocking healthy URLs', () => {
    const urls = Array.from({ length: 501 }, (_, index) => 'https://images.example/' + index)
    const cache = new ArticleThumbnailFailureCache(urls)
    for (const url of urls.slice(0, 500)) cache.remember(url)
    for (let pass = 0; pass < 3; pass++) {
      for (const url of urls.slice(0, 500)) expect(cache.isBlocked(url)).toBe(true)
    }
    expect(cache.size).toBe(500)
    expect(cache.isBlocked(urls[500]!)).toBe(false)
  })

  it('prunes removed URLs and ignores late errors that no longer belong to the loaded scope', () => {
    const cache = new ArticleThumbnailFailureCache(['old', 'retained'])
    cache.remember('old')
    cache.remember('retained')
    cache.retainUrls(['retained', 'new'])
    cache.remember('old')
    cache.remember('outside-scope')
    expect(cache.size).toBe(1)
    expect(cache.has('old')).toBe(false)
    expect(cache.has('retained')).toBe(true)
    expect(cache.has('new')).toBe(false)
    cache.retainUrls(['old', 'retained', 'new'])
    expect(cache.has('old')).toBe(false)
  })

  it('notifies only subscribers of the failed URL, including rows sharing it', () => {
    const cache = new ArticleThumbnailFailureCache(['shared', 'healthy'])
    const first = vi.fn(), second = vi.fn(), unrelated = vi.fn()
    cache.subscribe('shared', first)
    cache.subscribe('shared', second)
    cache.subscribe('healthy', unrelated)
    cache.remember('shared')
    cache.remember('shared')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(unrelated).not.toHaveBeenCalled()
  })

  it('releases subscriptions on virtual unmount without forgetting the failure', () => {
    const cache = new ArticleThumbnailFailureCache(['image'])
    const listener = vi.fn()
    const unsubscribe = cache.subscribe('image', listener)
    cache.remember('image')
    unsubscribe()
    cache.clear()
    cache.remember('image')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.has('image')).toBe(true)
  })

  it('explicit refresh resets only failed URLs and does not notify healthy images', () => {
    const cache = new ArticleThumbnailFailureCache(['failed', 'healthy'])
    cache.remember('failed')
    const failed = vi.fn(), healthy = vi.fn()
    cache.subscribe('failed', failed)
    cache.subscribe('healthy', healthy)
    cache.clear()
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.isBlocked('failed')).toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(healthy).not.toHaveBeenCalled()
  })

  it('pauses while offline without poisoning new URLs or retrying prior failures on reconnect', () => {
    const cache = new ArticleThumbnailFailureCache(['permanent', 'new'])
    cache.remember('permanent')
    cache.setOnline(false)
    cache.remember('new')
    expect(cache.isBlocked('new')).toBe(true)
    expect(cache.has('new')).toBe(false)
    cache.setOnline(true)
    expect(cache.isBlocked('new')).toBe(false)
    expect(cache.isBlocked('permanent')).toBe(true)
    expect(cache.size).toBe(1)
  })
})
