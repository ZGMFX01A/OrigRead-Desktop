import { describe, expect, it } from 'vitest'
import { evaluateContentCandidate, scoreContentCandidate } from './content-candidate-scorer'

describe('ContentCandidateScorer Android parity', () => {
  it('article content outranks navigation and advertising blocks', () => {
    const article = `<article><h1>稳定正文评分</h1>
      <p>${'这是结构清晰的正文段落，用于验证文本密度、段落数量和链接密度。'.repeat(8)}</p>
      <p>${'第二段继续提供有效信息，避免候选仅依赖单一超长文本节点。'.repeat(8)}</p>
      <img src="https://example.com/image.jpg"></article>`
    const navigation = `<nav>${Array.from({ length: 30 }, (_, index) => `<a href='/tag/${index + 1}'>分类广告推广相关推荐</a>`).join('')}</nav>`

    const articleScore = scoreContentCandidate(article, '稳定正文评分', '稳定正文评分')
    const navigationScore = scoreContentCandidate(navigation)

    expect(articleScore).toBeGreaterThan(navigationScore)
    expect(articleScore).toBeGreaterThanOrEqual(50)
  })

  it('title match provides at most 15 points', () => {
    const html = `<article><p>${'正文内容用于比较标题匹配前后的评分变化。'.repeat(20)}</p></article>`
    const withoutTitle = scoreContentCandidate(html)
    const withTitle = scoreContentCandidate(html, '测试标题', '测试标题 - 站点名')
    expect(withTitle).toBeGreaterThan(withoutTitle)
    expect(withTitle - withoutTitle).toBeLessThanOrEqual(15)
  })

  it('diagnoses duplicate paragraphs and ad keywords', () => {
    const repeated = '重复推广广告段落内容足够长，用于触发重复比例和广告关键词惩罚。'
    const html = `<article>${Array.from({ length: 5 }, () => `<p>${repeated}</p>`).join('')}</article>`
    const metrics = evaluateContentCandidate(html)
    expect(metrics.duplicateParagraphRatio).toBeGreaterThanOrEqual(0.5)
    expect(metrics.adKeywordHits).toBeGreaterThan(0)
    expect(metrics.paragraphCount).toBe(5)
  })
})
