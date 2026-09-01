import { describe, expect, it } from 'vitest'
import { buildAiSummarySystemPrompt, buildAiSummaryUserPrompt } from './ai-summary-prompts'

describe('AI summary prompts', () => {
  it('uses the canonical English v2 system protocol and never delegates summary eligibility to the model', () => {
    const prompt = buildAiSummarySystemPrompt('zh-CN')
    expect(prompt).toContain("You are OrigRead's article summarization editor")
    expect(prompt).toContain('Use only information contained in the article')
    expect(prompt).toContain('verifiable facts')
    expect(prompt).toContain("the author's judgments")
    expect(prompt).toContain('research/report: research question, method/sample, key data, conclusions, and limitations')
    expect(prompt).toContain('The summary should be materially shorter than the source')
    expect(prompt).toContain('origread-summary-v2')
    expect(prompt).toContain('"v":2')
    expect(prompt).toContain('Output language: zh-CN')
    expect(prompt).not.toContain('shouldSummarize')
    expect(prompt).not.toContain('是否值得摘要')
  })

  it('uses article-type-aware Standard structure without forcing a thesis chain', () => {
    const prompt = buildAiSummaryUserPrompt('Title', '## Part one\nBody', 'STANDARD')
    expect(prompt).toContain('Start with one overview paragraph')
    expect(prompt).toContain('localized level-2 Markdown heading meaning "Key Points"')
    expect(prompt).toContain('multiple independent findings, arguments, methods, steps, data points, or limitations')
    expect(prompt).toContain('<article>')
    expect(prompt).not.toContain('shouldSummarize')
    expect(prompt).not.toContain('48%')
    expect(prompt).not.toContain('CJK')
  })

  it('keeps bullet label, colon and explanation in the same list item', () => {
    const prompt = buildAiSummaryUserPrompt('Title', 'Body', 'STANDARD')
    expect(prompt).toContain('- **Conclusion:** explanation')
    expect(prompt).toContain('keep the label, colon, and explanation in the same item')
  })

  it('gives the three summary lengths materially different output contracts', () => {
    const brief = buildAiSummaryUserPrompt('Title', 'Body', 'BRIEF')
    const standard = buildAiSummaryUserPrompt('Title', 'Body', 'STANDARD')
    const detailed = buildAiSummaryUserPrompt('Title', 'Body', 'DETAILED')
    expect(brief).toContain('Write one dense paragraph only')
    expect(brief).toContain('Do not add a summary heading or bullet list')
    expect(standard).toContain('Never start with a heading or list')
    expect(detailed).toContain("preserve more of the source's meaningful structure and relevant details than STANDARD mode")
    expect(detailed).toContain('Apply the article-form priorities from the system rules')
    expect(detailed).toContain('Use localized level-2 Markdown headings only when the source actually supports those sections')
  })

  it('uses an English untitled fallback while preserving the requested output language', () => {
    expect(buildAiSummaryUserPrompt('', 'Body', 'BRIEF')).toContain('<title>(untitled)</title>')
    expect(buildAiSummarySystemPrompt('')).toContain('Output language: zh-CN')
  })
})
