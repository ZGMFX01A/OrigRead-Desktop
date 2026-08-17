import { describe, expect, it } from 'vitest'
import { localSummarySkipReason, measureAiSummaryInput, measureEffectiveLength, parseAiSummaryModelOutput, summaryOutputCeiling } from './ai-summary-policy'

describe('AI summary policy', () => {
  it('skips obviously concise prose without sending it to AI', () => {
    const metrics = measureAiSummaryInput('英伟达盘中涨超 10%，受财报超预期影响。')
    expect(localSummarySkipReason(metrics)).toBe('local_source_already_concise')
  })

  it('keeps short but structured content eligible for the existing complex summary logic', () => {
    const metrics = measureAiSummaryInput('## 方法\n\n- 样本 120 例\n\n- 对照组 60 例\n\n- 实验组 60 例\n\n## 结论\n\n主要终点改善，但样本量有限。')
    expect(metrics.effectiveLength).toBeLessThan(280)
    expect(localSummarySkipReason(metrics)).toBeNull()
  })

  it('uses comparable effective length for CJK characters and Latin words', () => {
    const chinese = '这是用于验证跨语言摘要长度估算的一段中文内容，包含若干事实和说明。'.repeat(4)
    const english = Array.from({ length: 55 }, (_value, index) => `word${index}`).join(' ')
    expect(measureEffectiveLength(chinese)).toBeGreaterThan(100)
    expect(measureEffectiveLength(english)).toBe(110)
    expect(measureEffectiveLength('hello world 2026')).toBe(6)
  })

  it('never lets the readable floor break the 48 percent compression cap', () => {
    expect(summaryOutputCeiling(200, 'STANDARD')).toBe(96)
    expect(summaryOutputCeiling(300, 'DETAILED')).toBe(144)
    expect(summaryOutputCeiling(3_000, 'DETAILED')).toBe(1_000)
  })

  it('parses invisible model metadata and a no-summary decision', () => {
    expect(parseAiSummaryModelOutput('<!-- origread-summary-v1: {"v":1,"shouldSummarize":false,"form":"flash","domain":"finance","reason":"source_already_concise"} -->')).toEqual({
      shouldSummarize: false,
      articleForm: 'flash',
      domain: 'finance',
      reason: 'source_already_concise',
      summary: ''
    })
  })

  it('keeps parsing the legacy metadata marker for compatible providers and old responses', () => {
    expect(parseAiSummaryModelOutput('<!-- origread-summary: {"shouldSummarize":true,"form":"news","domain":"technology","reason":null} -->\n正文摘要').summary).toBe('正文摘要')
  })

  it('fails open when a compatible model ignores the metadata protocol', () => {
    expect(parseAiSummaryModelOutput('普通 Markdown 摘要').summary).toBe('普通 Markdown 摘要')
    expect(parseAiSummaryModelOutput('普通 Markdown 摘要').shouldSummarize).toBe(true)
  })
})
