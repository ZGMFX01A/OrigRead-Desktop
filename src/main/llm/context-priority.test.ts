import { describe, expect, it } from 'vitest'
import {
  CURRENT_ARTICLE_CONTEXT_PRIORITY,
  LLM_CONTEXT_PRIORITY_BASE,
  MANUAL_TOOL_CONTEXT_PRIORITY,
  SELECTED_TEXT_CONTEXT_PRIORITY,
  additionalArticleContextPriority,
  llmContextPriority,
  webSearchContextPriority
} from './context-priority'

describe('D7.8 Context priority policy', () => {
  it('keeps the Android-aligned business tiers in strict order', () => {
    expect(SELECTED_TEXT_CONTEXT_PRIORITY).toBeGreaterThan(
      llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.ARTICLE_SUMMARY)
    )
    expect(llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.ARTICLE_SUMMARY)).toBeGreaterThan(
      llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.ARTICLE_TRANSLATION)
    )
    expect(llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.ARTICLE_TRANSLATION)).toBeGreaterThan(
      MANUAL_TOOL_CONTEXT_PRIORITY
    )
    expect(MANUAL_TOOL_CONTEXT_PRIORITY).toBeGreaterThan(webSearchContextPriority(0))
    expect(webSearchContextPriority(19)).toBeGreaterThan(CURRENT_ARTICLE_CONTEXT_PRIORITY)
    expect(CURRENT_ARTICLE_CONTEXT_PRIORITY).toBeGreaterThan(additionalArticleContextPriority(0))
  })

  it('preserves stable rank inside a tier without crossing the next tier', () => {
    expect(webSearchContextPriority(0)).toBeGreaterThan(webSearchContextPriority(1))
    expect(additionalArticleContextPriority(0)).toBeGreaterThan(additionalArticleContextPriority(4))
    expect(llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.WEB_SEARCH_RESULT, 500)).toBeGreaterThan(
      CURRENT_ARTICLE_CONTEXT_PRIORITY
    )
  })
})
