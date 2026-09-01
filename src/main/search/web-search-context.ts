import { createHash, randomUUID } from 'node:crypto'
import { LLM_EVIDENCE_SCHEMA_VERSION, type LlmContextRefRecord } from '../../shared/llm-chat'
import type { LlmContextItem } from '../../shared/llm-context'
import type { WebSearchResponse, WebSearchResult } from '../../shared/web-search'
import type { BuiltLlmEvidenceBlock } from '../llm/evidence-block-builder'

export interface WebSearchEvidenceGroup {
  contextId: string
  blocks: readonly BuiltLlmEvidenceBlock[]
}

export interface BuiltWebSearchContext {
  contextItems: LlmContextItem[]
  evidenceGroups: WebSearchEvidenceGroup[]
}

/** Convert provider output into untrusted reference-data Context; never into system instructions. */
export function buildWebSearchContext(response: WebSearchResponse): BuiltWebSearchContext {
  const contextItems: LlmContextItem[] = []
  const evidenceGroups: WebSearchEvidenceGroup[] = []
  for (const [index, result] of response.results.entries()) {
    const content = webSearchResultSnapshot(result)
    if (!content) continue
    const normalizedSha256 = sha256(content)
    const contextId = `web-search:${response.providerId}:${index + 1}:${sha256(result.url).slice(0, 12)}`
    const stableLocatorKey = `SEARCH_RESULT:${sha256(`${result.url}\n${content}`).slice(0, 24)}:0`
    const block: BuiltLlmEvidenceBlock = {
      stableLocatorKey,
      content,
      kind: 'SEARCH_RESULT',
      ordinal: 0,
      normalizedSha256,
      locator: {
        version: 1,
        sourceKind: 'WEB_SEARCH',
        blockIndex: index,
        sourceUrl: result.url,
        normalizedHash: normalizedSha256
      },
      schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION
    }
    contextItems.push({
      id: contextId,
      type: 'WEB_SEARCH_RESULT',
      title: result.title,
      sourceId: result.url,
      content,
      evidenceBlocks: [block],
      priority: 80 - index
    })
    evidenceGroups.push({ contextId, blocks: [block] })
  }
  return { contextItems, evidenceGroups }
}

/**
 * Pre-runtime snapshot: result exists, but whether it will enter the final prompt is not known yet.
 * Runtime's ordinary ContextRef persistence later replaces these rows with final usage flags.
 */
export function buildUnconsumedWebSearchContextRefs(
  conversationId: string,
  assistantMessageId: string,
  items: readonly LlmContextItem[],
  createdAt = Date.now()
): LlmContextRefRecord[] {
  return items.filter((item) => item.type === 'WEB_SEARCH_RESULT').map((item) => ({
    id: randomUUID(),
    conversationId,
    assistantMessageId,
    contextId: item.id,
    type: 'WEB_SEARCH_RESULT',
    title: item.title?.trim() || null,
    sourceId: item.sourceId?.trim() || null,
    articleId: null,
    sourceUrl: httpUrl(item.sourceId),
    contentSnapshot: item.content,
    promptContentSnapshot: null,
    contentSha256: sha256(item.content),
    priority: item.priority ?? 0,
    includedInPrompt: false,
    truncatedInPrompt: false,
    createdAt
  }))
}

export function webSearchResultSnapshot(result: WebSearchResult): string {
  return [
    result.publishedAt?.trim() ? `Published: ${result.publishedAt.trim()}` : '',
    result.source?.trim() ? `Source: ${result.source.trim()}` : '',
    result.snippet.trim(),
    result.content?.trim() || ''
  ].filter(Boolean).join('\n\n').trim() || result.url.trim()
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
