import { describe, expect, it } from 'vitest'
import type { WebsiteParsedArticle } from '../../../shared/website'
import { rankingScore, scoreWebsiteCandidate } from './website-candidate-scorer'

describe('scoreWebsiteCandidate', () => {
  it('uses the Android health thresholds and deterministic ranking additions', () => {
    const fetchedAt = 1_786_000_000_000
    const articles = Array.from({ length: 10 }, (_, index) => article(
      `真实新闻文章标题 ${index + 1}`,
      `https://news.example.com/article/${100 + index}`,
      fetchedAt - index * 60_000
    ))
    const diagnostics = scoreWebsiteCandidate(articles, fetchedAt)
    expect(diagnostics.state).toBe('AVAILABLE')
    expect(diagnostics.score).toBeGreaterThan(80)
    diagnostics.linkQualityScore = -8
    diagnostics.regionScore = 22
    diagnostics.historyScore = 4
    expect(rankingScore(diagnostics)).toBe(diagnostics.score + 18)
  })

  it('rejects a candidate dominated by duplicate links', () => {
    const fetchedAt = 1_786_000_000_000
    const diagnostics = scoreWebsiteCandidate([
      article('第一篇真实文章', 'https://news.example.com/1', fetchedAt),
      article('第二篇真实文章', 'https://news.example.com/1', fetchedAt),
      article('第三篇真实文章', 'https://news.example.com/1', fetchedAt)
    ], fetchedAt)
    expect(diagnostics.state).toBe('INVALID_CONTENT')
    expect(diagnostics.reasons).toContain('重复链接比例过高')
  })
})

function article(title: string, link: string, publishedAt: number): WebsiteParsedArticle {
  return { stableId: link, title, link, author: null, publishedAt, descriptionHtml: '', imageUrl: null }
}

