import { describe, expect, it } from 'vitest'
import { buildLlmTaskBaseSystemPrompt } from './task-system-prompt'

describe('LLM task hard prompts', () => {
  it('keeps ordinary chat concise and article analysis structurally distinct', () => {
    expect(buildLlmTaskBaseSystemPrompt('CHAT')).toContain('reading assistant')
    expect(buildLlmTaskBaseSystemPrompt('CHAT')).not.toContain('central thesis')

    const analysis = buildLlmTaskBaseSystemPrompt('ARTICLE_ANALYSIS')
    expect(analysis).toContain('dedicated article-analysis task')
    expect(analysis).toContain("article's central thesis and major claims")
    expect(analysis).toContain('evidence or reasoning')
    expect(analysis).toContain('assumptions, omissions, uncertainty, limitations')
    expect(analysis).toContain('distinguish external evidence from what the article itself says')
    expect(analysis).toContain("language of the user's request")
  })
})
