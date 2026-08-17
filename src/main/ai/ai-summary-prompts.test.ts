import { describe, expect, it } from 'vitest'
import { buildAiSummarySystemPrompt, buildAiSummaryUserPrompt } from './ai-summary-prompts'

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

  it('uses article-type-specific compression guidance instead of a fixed long-form template', () => {
    const prompt = buildAiSummaryUserPrompt('New GPU launched', '这是用于摘要预算测试的正文内容。'.repeat(180), 'STANDARD')
    expect(prompt).toContain('release/news')
    expect(prompt).toContain('research/report/analysis')
    expect(prompt).toContain('跨语言等效长度')
    expect(prompt).toContain('等效长度单位')
    expect(prompt).toContain('文章形态上限')
  })

  it('adds summary-value and form-domain decisions while preserving complex article summarization', () => {
    const system = buildAiSummarySystemPrompt('zh-CN')
    const detailed = buildAiSummaryUserPrompt(
      '研究报告',
      '## 方法\n\n样本与方法。\n\n## 数据\n\n关键数据。\n\n## 限制\n\n存在限制。'.repeat(20),
      'DETAILED'
    )
    expect(system).toContain('是否值得摘要')
    expect(system).toContain('文章形态 × 内容领域')
    expect(system).toContain('不得仅因为篇幅中等或偏短就判定无需摘要')
    expect(system).toContain('shouldSummarize=false 是高置信度动作')
    expect(system).toContain('只要存在疑问，一律返回 true')
    expect(system).toContain('禁止使用原文之外的知识')
    expect(system).toContain('origread-summary-v1')
    expect(system).toContain('"v":1')
    expect(detailed).toContain('研究问题 / 方法或样本 / 关键数据 / 结论 / 限制')
    expect(detailed).toContain('复杂文章原有的多层摘要能力必须保留')
    expect(detailed).toContain('48%')
  })
})
