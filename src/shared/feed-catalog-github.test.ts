import { describe, expect, it } from 'vitest'
import { FeedCatalogIndex, preferredCatalogProbeUrl } from './feed-catalog-index'
import type { FeedCatalogEntry } from './source-catalog'

function entry(repository: string, suffix = 'releases.atom'): FeedCatalogEntry {
  return { id: repository, name: repository, feedUrl: `https://github.com/${repository}/${suffix}`,
    siteUrl: `https://github.com/${repository}`, categories: [], origins: [] }
}

const readYou = entry('ReadYouApp/ReadYou', 'commits/main.atom')
const index = new FeedCatalogIndex([entry('oven-sh/bun'), entry('biomejs/biome'), entry('ReadYouApp/ReadYou-Other'), readYou])

describe('GitHub repository-scoped catalog suggestions', () => {
  it('never suggests other repositories or replaces the input with a different feed', () => {
    const input = 'https://github.com/ReadYouApp/ReadYou/releases.atom'
    const match = index.matchUrl(input)
    expect(match).toEqual({ preferred: null, suggestions: [readYou], totalSuggestions: 1 })
    expect(preferredCatalogProbeUrl(match, input)).toBeNull()
    expect(index.matchUrl('https://www.github.com/READYOUAPP/READYOU/releases.atom?x=1#latest').suggestions).toEqual([readYou])
  })

  it('keeps exact feed/site matches and unrestricted catalog text search', () => {
    expect(index.matchUrl(readYou.feedUrl).preferred).toEqual(readYou)
    expect(preferredCatalogProbeUrl(index.matchUrl(readYou.siteUrl!), readYou.siteUrl!)).toBe(readYou.feedUrl)
    expect(index.search('github.com')).toHaveLength(4)
  })

  it.each(['https://github.com', 'https://github.com/ReadYouApp/', 'https://github.com/unknown/repository'])(
    'does not recommend the entire shared host for %s', (input) => {
      expect(index.matchUrl(input)).toEqual({ preferred: null, suggestions: [], totalSuggestions: 0 })
    })
})
