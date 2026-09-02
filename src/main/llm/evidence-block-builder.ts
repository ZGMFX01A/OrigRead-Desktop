import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import {
  LLM_EVIDENCE_SCHEMA_VERSION,
  type LlmEvidenceBlockKind,
  type LlmEvidenceLocatorV1
} from '../../shared/llm-chat'
import type { LlmContextEvidenceBlock } from '../../shared/llm-context'

export interface BuiltLlmEvidenceBlock extends LlmContextEvidenceBlock {
  kind: LlmEvidenceBlockKind
  ordinal: number
  normalizedSha256: string
  locator: LlmEvidenceLocatorV1
  schemaVersion: number
}

export interface ArticleEvidenceSource {
  articleId?: string | null
  sourceUrl?: string | null
}

export function buildSelectionEvidenceBlock(content: string, source: ArticleEvidenceSource = {}): BuiltLlmEvidenceBlock | null {
  const normalized = normalizeEvidenceText(content)
  if (!normalized) return null
  const normalizedSha256 = sha256(normalized)
  const stableLocatorKey = `SELECTION:${normalizedSha256.slice(0, 24)}:0`
  return {
    stableLocatorKey,
    content: normalized,
    kind: 'SELECTION',
    ordinal: 0,
    normalizedSha256,
    locator: {
      version: 1,
      sourceKind: 'SELECTION',
      stableLocatorKey,
      articleId: source.articleId?.trim() || null,
      sourceUrl: source.sourceUrl?.trim() || null,
      normalizedHash: normalizedSha256
    },
    schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION
  }
}

const SEMANTIC_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,tr'
const CONTAINER_SELECTOR = 'p,li,blockquote,pre,tr'

/** Build frozen, semantically-addressable blocks from the sanitized Reader HTML. */
export function buildArticleEvidenceBlocks(html: string, source: ArticleEvidenceSource = {}): BuiltLlmEvidenceBlock[] {
  const $ = cheerio.load(html || '', undefined, false)
  return collectArticleEvidenceBlocks($, source)
}

/** Add invisible Reader DOM anchors to exactly the same semantic blocks used as LLM evidence. */
export function annotateArticleEvidenceHtml(html: string, source: ArticleEvidenceSource = {}): string {
  const $ = cheerio.load(html || '', undefined, false)
  collectArticleEvidenceBlocks($, source, (element, block) => {
    const current = $(element)
    current.attr('data-origread-block-id', block.stableLocatorKey)
    current.attr('data-origread-block-index', String(block.ordinal))
    current.attr('data-origread-block-hash', block.normalizedSha256)
    if (block.locator.headingPath?.length) {
      current.attr('data-origread-heading-path', block.locator.headingPath.join('\u001f'))
    }
  })
  return $.root().html() ?? ''
}

function collectArticleEvidenceBlocks(
  $: cheerio.CheerioAPI,
  source: ArticleEvidenceSource,
  onBlock?: (element: AnyNode, block: BuiltLlmEvidenceBlock) => void
): BuiltLlmEvidenceBlock[] {
  const blocks: BuiltLlmEvidenceBlock[] = []
  const headingStack: Array<{ level: number; text: string }> = []
  const duplicateCounters = new Map<string, number>()

  $(SEMANTIC_SELECTOR).each((_index, element) => {
    const current = $(element)
    // A list item / quote / pre / table row is one semantic block. Do not duplicate nested paragraphs.
    if (current.parents(CONTAINER_SELECTOR).length > 0) return
    const tag = element.tagName?.toLowerCase() ?? ''
    const kind = blockKind(tag)
    if (!kind) return
    const content = tag === 'tr'
      ? current.find('th,td').toArray().map((cell) => normalizeEvidenceText($(cell).text())).filter(Boolean).join(' | ')
      : tag === 'pre'
        ? normalizeCodeText(current.text())
        : tag === 'li' || tag === 'blockquote'
          ? semanticContainerText(current, $)
        : normalizeEvidenceText(current.text())
    if (!content) return

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1))
      while (headingStack.length > 0 && headingStack.at(-1)!.level >= level) headingStack.pop()
      headingStack.push({ level, text: content })
    }

    const headingPath = headingStack.map((heading) => heading.text)
    const normalizedSha256 = sha256(normalizeEvidenceText(content))
    const headingFingerprint = headingPath.length > 0 ? sha256(headingPath.join('\n')).slice(0, 10) : 'root'
    const identityBase = `${kind}:${headingFingerprint}:${normalizedSha256.slice(0, 20)}`
    const occurrence = duplicateCounters.get(identityBase) ?? 0
    duplicateCounters.set(identityBase, occurrence + 1)
    const stableLocatorKey = `${identityBase}:${occurrence}`
    const ordinal = blocks.length
    const block: BuiltLlmEvidenceBlock = {
      stableLocatorKey,
      content,
      kind,
      ordinal,
      normalizedSha256,
      locator: {
        version: 1,
        sourceKind: 'ARTICLE',
        stableLocatorKey,
        blockIndex: ordinal,
        headingPath: [...headingPath],
        articleId: source.articleId?.trim() || null,
        sourceUrl: source.sourceUrl?.trim() || null,
        normalizedHash: normalizedSha256
      },
      schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION
    }
    blocks.push(block)
    onBlock?.(element, block)
  })

  if (blocks.length === 0) {
    const fallback = normalizeEvidenceText($.root().text())
    if (!fallback) return []
    const normalizedSha256 = sha256(fallback)
    const stableLocatorKey = `PARAGRAPH:root:${normalizedSha256.slice(0, 20)}:0`
    return [{
      stableLocatorKey,
      content: fallback,
      kind: 'PARAGRAPH',
      ordinal: 0,
      normalizedSha256,
      locator: {
        version: 1,
        sourceKind: 'ARTICLE',
        stableLocatorKey,
        blockIndex: 0,
        headingPath: [],
        articleId: source.articleId?.trim() || null,
        sourceUrl: source.sourceUrl?.trim() || null,
        normalizedHash: normalizedSha256
      },
      schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION
    }]
  }
  return blocks
}

export function normalizeEvidenceText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim()
}

function normalizeCodeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function semanticContainerText(
  current: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI
): string {
  const clone = current.clone()
  clone.find('p,div,section,article,br,ul,ol,li,blockquote,pre,table,tr').each((_index, element) => {
    const nested = $(element)
    nested.before(' ')
    nested.after(' ')
  })
  return normalizeEvidenceText(clone.text())
}

function blockKind(tag: string): LlmEvidenceBlockKind | null {
  if (/^h[1-6]$/.test(tag)) return 'HEADING'
  if (tag === 'p') return 'PARAGRAPH'
  if (tag === 'li') return 'LIST_ITEM'
  if (tag === 'blockquote') return 'BLOCKQUOTE'
  if (tag === 'pre') return 'CODE'
  if (tag === 'tr') return 'TABLE_ROW'
  return null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
