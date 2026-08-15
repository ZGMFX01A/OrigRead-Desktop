import { describe, expect, it } from 'vitest'
import { buildAiSummaryUserPrompt } from './ai-summary-prompts'

describe('AI summary prompts', () => {
  it.each(['BRIEF', 'STANDARD', 'DETAILED'] as const)('does not request a duplicated summary heading for %s', (length) => {
    const prompt = buildAiSummaryUserPrompt('Title', 'Body', length)
    expect(prompt).not.toMatch(/^## 摘要$/m)
    expect(prompt).toContain('不要输出“摘要”标题')
  })

  it('keeps useful section headings for structured modes', () => {
    expect(buildAiSummaryUserPrompt('Title', 'Body', 'STANDARD')).toContain('## 主要内容')
    const detailed = buildAiSummaryUserPrompt('Title', 'Body', 'DETAILED')
    expect(detailed).toContain('## 论证结构')
    expect(detailed).toContain('## 主要内容')
  })
})
