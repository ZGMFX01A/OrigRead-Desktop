import {
  LLM_CONTEXT_TYPES,
  type ComposedLlmContext,
  type LlmContextDecision,
  type LlmContextItem,
  type LlmContextPolicy,
  type LlmContextType,
  type LlmRenderedContextItem
} from '../../shared/llm-context'

const MIN_EVIDENCE_RESERVE_TOKENS = 256
const MAX_EVIDENCE_RESERVE_TOKENS = 2_048

interface RenderedBlock {
  text: string
  content: string
  estimatedTokens: number
  truncated: boolean
  evidenceBlockKeys?: string[]
}

/**
 * Composes all model context through one deterministic budget boundary.
 * Provider tokenizers differ, so this uses a deliberately conservative cross-language estimate.
 */
export class LlmContextComposer {
  compose(items: readonly LlmContextItem[], policy: LlmContextPolicy): ComposedLlmContext {
    if (!Number.isFinite(policy.maxTokens) || policy.maxTokens <= 0) throw new Error('上下文预算必须大于 0')
    const maxTokens = Math.trunc(policy.maxTokens)
    const allowedTypes = policy.allowedTypes ?? LLM_CONTEXT_TYPES
    assertUniqueContextIds(items)

    const indexed = items.map((item, index) => ({ item: normalizeContextItem(item), index }))
    const accepted = indexed
      .filter(({ item }) => allowedTypes.has(item.type) && hasContextContent(item))
      .sort((left, right) => (right.item.priority ?? 0) - (left.item.priority ?? 0) || left.index - right.index)

    const includedIds: string[] = []
    const omittedIds: string[] = []
    const renderedItems: LlmRenderedContextItem[] = []
    const decisionById = new Map<string, LlmContextDecision['status']>()
    const blocks: string[] = []
    let usedTokens = 0
    let truncated = false

    for (let acceptedIndex = 0; acceptedIndex < accepted.length; acceptedIndex += 1) {
      const item = accepted[acceptedIndex]!.item
      const separator = blocks.length === 0 ? '' : '\n\n'
      const separatorTokens = estimateLlmTokens(separator)
      const remaining = maxTokens - usedTokens - separatorTokens
      if (remaining <= 0) {
        omitBudget(item.id, omittedIds, decisionById)
        truncated = true
        continue
      }

      const futureEvidenceReserve = accepted
        .slice(acceptedIndex + 1)
        .reduce((total, candidate) => total + (candidate.item.reserveEvidenceBudget ? evidenceReserveTokens(maxTokens) : 0), 0)
      const availableForItem = Math.max(0, remaining - Math.min(remaining, futureEvidenceReserve))
      const block = renderBlock(item, availableForItem)
      if (!block) {
        omitBudget(item.id, omittedIds, decisionById)
        truncated = true
        continue
      }

      blocks.push(block.text)
      usedTokens += separatorTokens + block.estimatedTokens
      includedIds.push(item.id)
      renderedItems.push({
        id: item.id,
        content: block.content,
        truncated: block.truncated,
        ...(block.evidenceBlockKeys ? { evidenceBlockKeys: block.evidenceBlockKeys } : {})
      })
      decisionById.set(item.id, block.truncated ? 'INCLUDED_TRUNCATED' : 'INCLUDED')
      truncated ||= block.truncated

      if (usedTokens >= maxTokens) {
        for (const remainingItem of accepted.slice(acceptedIndex + 1)) {
          omitBudget(remainingItem.item.id, omittedIds, decisionById)
          truncated = true
        }
        break
      }
    }

    for (const { item } of indexed) {
      if (allowedTypes.has(item.type) && hasContextContent(item)) continue
      omittedIds.push(item.id)
      decisionById.set(item.id, 'OMITTED_FILTERED')
    }

    const distinctIncluded = distinct(includedIds)
    const distinctOmitted = distinct(omittedIds).filter((id) => !distinctIncluded.includes(id))
    return {
      text: blocks.join('\n\n'),
      includedIds: distinctIncluded,
      omittedIds: distinctOmitted,
      truncated,
      renderedItems,
      decisions: items.map((item) => ({
        id: item.id,
        status: decisionById.get(item.id) ?? 'OMITTED_FILTERED'
      }))
    }
  }
}

function normalizeContextItem(item: LlmContextItem): LlmContextItem {
  const id = item.id.trim()
  if (!id) throw new Error('上下文 id 不能为空')
  return {
    ...item,
    id,
    title: item.title?.trim() || null,
    sourceId: item.sourceId?.trim() || null,
    internalArticleId: item.internalArticleId?.trim() || null,
    priority: item.priority ?? 0,
    reserveEvidenceBudget: item.reserveEvidenceBudget === true,
    evidenceBlocks: item.evidenceBlocks?.map((block) => ({
      stableLocatorKey: block.stableLocatorKey.trim(),
      content: block.content.trim()
    }))
  }
}

function assertUniqueContextIds(items: readonly LlmContextItem[]): void {
  const counts = new Map<string, number>()
  for (const item of items) {
    const id = item.id.trim()
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort()
  if (duplicates.length > 0) throw new Error(`上下文 id 必须唯一：${duplicates.join(', ')}`)
}

function renderBlock(item: LlmContextItem, maxTokens: number): RenderedBlock | null {
  const header = `[ORIGREAD_CONTEXT type=${item.type} id=${quoteAttribute(item.id)}${item.sourceId ? ` source=${quoteAttribute(item.sourceId)}` : ''}]`
  const title = item.title ? `\nTitle: ${item.title}` : ''
  const footer = '\n[/ORIGREAD_CONTEXT]'
  const prefix = `${header}${title}\n`
  const fixedTokens = estimateLlmTokens(prefix) + estimateLlmTokens(footer)
  if (fixedTokens > maxTokens) return null

  if (item.evidenceBlocks && item.evidenceBlocks.length > 0) {
    return renderAtomicEvidenceBlocks(item, prefix, footer, maxTokens, fixedTokens)
  }

  const content = item.content.trim()
  const renderedContent = takeWithinEstimatedTokenBudget(content, maxTokens - fixedTokens)
  const text = `${prefix}${renderedContent}${footer}`
  return {
    text,
    content: renderedContent,
    estimatedTokens: estimateLlmTokens(text),
    truncated: renderedContent.length < content.length
  }
}

function renderAtomicEvidenceBlocks(
  item: LlmContextItem,
  prefix: string,
  footer: string,
  maxTokens: number,
  fixedTokens: number
): RenderedBlock | null {
  const blocks = item.evidenceBlocks ?? []
  const seen = new Set<string>()
  const rendered: string[] = []
  const plainContent: string[] = []
  const evidenceBlockKeys: string[] = []
  let usedTokens = fixedTokens
  let eligibleBlockCount = 0

  for (const block of blocks) {
    const key = block.stableLocatorKey.trim()
    const content = block.content.trim()
    if (!key || !content) continue
    eligibleBlockCount += 1
    if (seen.has(key)) throw new Error(`Evidence block key 必须唯一：${key}`)
    seen.add(key)
    const separator = rendered.length > 0 ? '\n' : ''
    const text = `[ORIGREAD_EVIDENCE id=${quoteAttribute(key)}]\n${content}\n[/ORIGREAD_EVIDENCE]`
    const blockTokens = estimateLlmTokens(separator) + estimateLlmTokens(text)
    if (usedTokens + blockTokens > maxTokens) continue
    rendered.push(`${separator}${text}`)
    plainContent.push(content)
    evidenceBlockKeys.push(key)
    usedTokens += blockTokens
  }

  if (rendered.length === 0) return null
  const text = `${prefix}${rendered.join('')}${footer}`
  return {
    text,
    content: plainContent.join('\n\n'),
    estimatedTokens: estimateLlmTokens(text),
    truncated: evidenceBlockKeys.length < eligibleBlockCount,
    evidenceBlockKeys
  }
}

function hasContextContent(item: LlmContextItem): boolean {
  return item.content.trim().length > 0 || Boolean(item.evidenceBlocks?.some((block) => block.content.trim().length > 0))
}

function quoteAttribute(value: string): string {
  return JSON.stringify(value)
}

function evidenceReserveTokens(maxTokens: number): number {
  return Math.max(MIN_EVIDENCE_RESERVE_TOKENS, Math.min(MAX_EVIDENCE_RESERVE_TOKENS, Math.floor(maxTokens / 8)))
}

function omitBudget(id: string, omittedIds: string[], decisionById: Map<string, LlmContextDecision['status']>): void {
  omittedIds.push(id)
  decisionById.set(id, 'OMITTED_BUDGET')
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Approximate OpenAI-compatible tokens:
 * Latin letters/digits ~4 chars/token; whitespace free; ASCII punctuation, CJK, emoji and
 * other non-ASCII code points ~1 token. This is a stable budget estimate, not provider usage.
 */
export function estimateLlmTokens(text: string): number {
  if (!text) return 0
  let quarterTokens = 0
  for (const char of text) quarterTokens += quarterTokenCost(char)
  return Math.ceil(quarterTokens / 4)
}

/** Truncates only at Unicode code-point boundaries, never through a UTF-16 surrogate pair. */
export function takeWithinEstimatedTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return ''
  if (estimateLlmTokens(text) <= maxTokens) return text

  const maxQuarterTokens = Math.trunc(maxTokens) * 4
  let quarterTokens = 0
  let end = 0
  for (const char of text) {
    const cost = quarterTokenCost(char)
    if (quarterTokens + cost > maxQuarterTokens) break
    quarterTokens += cost
    end += char.length
  }
  return text.slice(0, end)
}

function quarterTokenCost(char: string): number {
  if (/\s/u.test(char)) return 0
  if (/^[A-Za-z0-9]$/u.test(char)) return 1
  return 4
}

export function isLlmContextType(value: string): value is LlmContextType {
  return LLM_CONTEXT_TYPES.has(value as LlmContextType)
}
