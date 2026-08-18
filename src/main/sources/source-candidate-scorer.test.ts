import { describe, expect, it } from 'vitest'
import { rankSourceCandidates, scoreSourceCandidate, type SourceCandidateEntry, type UnscoredSourceCandidate } from './source-candidate-scorer'

describe('SourceCandidateScorer parity', () => {
  const entries = createEntries(20)

  it('direct RSS wins when content quality is equal', () => {
    const direct = scoreSourceCandidate(entries, 'RSS_DIRECT')
    const website = scoreSourceCandidate(entries, 'WEBSITE')
    expect(direct.accepted).toBe(true)
    expect(direct.score).toBeGreaterThan(website.score)
  })

  it('invalid candidates cannot pass merely because their kind has a higher bonus', () => {
    const invalid = Array.from({ length: 20 }, () => ({ title: '首页', link: '', publishedAt: null }))
    const diagnostics = scoreSourceCandidate(invalid, 'RSS_DIRECT')
    expect(diagnostics.accepted).toBe(false)
    expect(diagnostics.score).toBe(0)
  })

  it('sorts valid RSS > JSON > Website with equal content and deduplicates same save target', () => {
    const ranked = rankSourceCandidates([
      probe('WEBSITE', 'website', 'https://example.com/', entries),
      probe('JSON', 'json', 'https://example.com/api/news', entries),
      probe('RSS_DISCOVERED', 'rss', 'https://example.com/feed.xml', entries),
      probe('RSS_DIRECT', 'rss', 'https://example.com/feed.xml', entries)
    ])
    expect(ranked.map((item) => item.kind)).toEqual(['RSS_DIRECT', 'JSON', 'WEBSITE'])
  })

  it('accepts safe low-title-quality lists only for dynamic website fallback', () => {
    const fallbackEntries: SourceCandidateEntry[] = [
      { title: 'A', link: 'https://example.com/article/1', publishedAt: null },
      { title: 'B', link: 'https://example.com/article/2', publishedAt: null },
      { title: 'Long article title 1', link: 'https://example.com/article/3', publishedAt: null },
      { title: 'Long article title 2', link: 'https://example.com/article/4', publishedAt: null }
    ]

    expect(scoreSourceCandidate(fallbackEntries, 'WEBSITE').accepted).toBe(false)
    expect(scoreSourceCandidate(fallbackEntries, 'WEBSITE_DYNAMIC').accepted).toBe(true)
  })

  it('dynamic fallback only requires a real unique article link after static candidates fail', () => {
    const oneUsableLink: SourceCandidateEntry[] = [
      { title: '', link: 'https://example.com/article/1', publishedAt: null }
    ]
    expect(scoreSourceCandidate(oneUsableLink, 'WEBSITE').accepted).toBe(false)
    expect(scoreSourceCandidate(oneUsableLink, 'WEBSITE_DYNAMIC').accepted).toBe(true)
    expect(scoreSourceCandidate([], 'WEBSITE_DYNAMIC').accepted).toBe(false)
  })
})

function probe(kind: UnscoredSourceCandidate['kind'], sourceType: UnscoredSourceCandidate['sourceType'], feedLink: string, entries: SourceCandidateEntry[]): UnscoredSourceCandidate {
  return { title: kind, kind, sourceType, feedLink, entries }
}

function createEntries(count: number): SourceCandidateEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Article ${index + 1}`,
    link: `https://example.com/article/${index + 1}`,
    publishedAt: 1_786_000_000_000 - index * 60_000
  }))
}

