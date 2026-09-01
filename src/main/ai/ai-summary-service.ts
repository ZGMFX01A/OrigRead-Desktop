import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import type { AiSummaryDocument, AiSummaryLength, AiSummaryProgressStage, AiSummaryRequestOptions, AiSummaryStreamUpdate } from '../../shared/ai'
import type { ReaderArticleContent } from '../../shared/reader'
import type { LibraryRepository } from '../database/library-repository'
import type { ReaderContentService } from '../content/reader-content-service'
import { buildAiSummarySystemPrompt, buildAiSummaryUserPrompt } from './ai-summary-prompts'
import { resolveAiProviderCapability } from './ai-provider-capabilities'
import { localSummarySkipReason, measureAiSummaryInput, parseAiSummaryModelOutput } from './ai-summary-policy'
import type { AiSettingsRepository } from './ai-settings-repository'
import { OpenAiCompatibleProvider, type AiTransportTimingEvent, type AiTransportTimingMetric } from './openai-compatible-provider'
import { NETWORK_REQUEST_TIMEOUT_MS } from '../network/request-policy'
import type { LlmTaskPromptCustomizer } from '../llm/prompt-customization'

export class AiSummaryService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly reader: ReaderContentService,
    private readonly settings: AiSettingsRepository,
    private readonly cacheDir: string,
    private readonly provider = new OpenAiCompatibleProvider(),
    private readonly promptCustomizer?: LlmTaskPromptCustomizer
  ) {}

  async summarize(
    articleId: string,
    forceRefresh = false,
    options: AiSummaryRequestOptions = {},
    onProgress: (stage: AiSummaryProgressStage) => void = () => undefined,
    onStreamUpdate: (update: Omit<AiSummaryStreamUpdate, 'articleId'>) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<AiSummaryDocument> {
    const perfStartedAt = performance.now()
    const article = this.library.getArticleById(articleId)
    if (!article) throw new Error('文章不存在')
    const config = this.settings.current()
    if (!config.enabled) throw new Error('AI 功能尚未启用')
    const requestedProfile = options.providerId
      ? config.providers.find((item) => item.id === options.providerId && item.enabled)
      : null
    if (options.providerId && !requestedProfile) throw new Error('所选 AI Provider 不可用')
    const profile = requestedProfile ?? config.providers.find((item) => item.id === config.defaultProviderId && item.enabled)
      ?? config.providers.find((item) => item.enabled)
    if (!profile || !profile.endpoint.trim()) throw new Error('AI Provider 尚未完成配置')
    const model = options.model?.trim() || profile.defaultModel.trim() || profile.models[0]?.trim() || ''
    if (!model) throw new Error('AI Provider 尚未选择模型')
    if (options.model && profile.models.length > 0 && !profile.models.includes(model)) throw new Error('所选模型不属于当前 AI Provider')
    const length = options.length ?? config.summaryLength
    const capability = resolveAiProviderCapability(profile, model)
    const baseSystemPrompt = buildAiSummarySystemPrompt(config.outputLanguage)
    const promptCustomization = this.promptCustomizer?.customize('SUMMARY', baseSystemPrompt)
      ?? { systemPrompt: baseSystemPrompt, skillId: null, cacheVariant: '' }
    const systemPrompt = promptCustomization.systemPrompt
    const summaryBudget = planAiSummaryBudget(capability.contextWindowTokens, systemPrompt, article.title, length)
    onProgress('PREPARING')
    const source = this.reader.get(articleId)
    const content = prepareArticleForSummary(source, length, summaryBudget.articleCharacterBudget)
    if (!content) throw new Error('当前文章没有可用于摘要的正文')
    const metrics = measureAiSummaryInput(content)
    const cacheFile = this.cacheFile(articleId, article.title, content, profile.id, profile.endpoint, model, config.outputLanguage, length, promptCustomization.cacheVariant)
    if (!forceRefresh) {
      if (!options.providerId && !options.model && !options.length) {
        const latest = readLatestCache(this.latestCacheFile(articleId), article.title, content, promptCustomization.cacheVariant)
        if (latest) return latest
      }
      const cached = readCache(cacheFile)
      if (cached) return cached
    }
    // 用户显式“重新生成”属于主动请求，与 Android 保持一致：绕过本地短文预检并真正调用模型。
    const localSkip = forceRefresh ? null : localSummarySkipReason(metrics)
    if (localSkip) {
      onProgress('FINALIZING')
      const document: AiSummaryDocument = {
        articleId,
        providerId: profile.id,
        providerName: profile.name,
        model,
        outputLanguage: config.outputLanguage,
        length,
        summary: '',
        reasoning: null,
        status: 'NOT_NEEDED',
        articleForm: null,
        domain: null,
        skipReason: localSkip
      }
      this.writeCache(cacheFile, article.title, content, promptCustomization.cacheVariant, document)
      return document
    }
    const prepareMs = performance.now() - perfStartedAt
    onProgress('REQUESTING')
    const requestStartMs = performance.now() - perfStartedAt
    const transportTimings: Partial<Record<AiTransportTimingMetric, number>> = {}
    const runtimeConfig = {
      endpoint: profile.endpoint,
      model,
      apiKey: this.settings.getApiKey(profile.id),
      temperature: 0.0,
      outputTokenLimitStyle: capability.outputTokenLimitStyle,
      strictStreamTermination: capability.strictStreamTermination,
      onTiming: (event: AiTransportTimingEvent) => { transportTimings[event.metric] ??= event.elapsedMs }
    } as const
    let streamedContent = ''
    let streamedReasoning = ''
    let lastPreviewAt = 0
    const userPrompt = buildAiSummaryUserPrompt(article.title, content, length)
    try {
      const completed = capability.supportsStreaming
        ? await this.provider.streamDetailed(
            systemPrompt,
            userPrompt,
            runtimeConfig,
            (delta) => {
              streamedContent += delta.content
              streamedReasoning += delta.reasoning
              const now = Date.now()
              if (lastPreviewAt !== 0 && now - lastPreviewAt < SUMMARY_STREAM_UI_INTERVAL_MS) return
              const update = {
                summaryPreview: extractAiSummaryStreamPreview(streamedContent).slice(-SUMMARY_STREAM_CONTENT_PREVIEW_CHARS),
                reasoningPreview: streamedReasoning.slice(-SUMMARY_STREAM_REASONING_PREVIEW_CHARS)
              }
              if (!update.summaryPreview.trim() && !update.reasoningPreview.trim()) return
              onStreamUpdate(update)
              lastPreviewAt = now
            },
            signal
          )
        : await this.provider.completeDetailed(systemPrompt, userPrompt, runtimeConfig, signal)
      const decision = parseAiSummaryModelOutput(completed.content)
      const document: AiSummaryDocument = {
        articleId,
        providerId: profile.id,
        providerName: profile.name,
        model,
        outputLanguage: config.outputLanguage,
        length,
        summary: decision.summary,
        reasoning: completed.reasoning,
        status: 'GENERATED',
        articleForm: decision.articleForm,
        domain: decision.domain,
        skipReason: null
      }
      onProgress('FINALIZING')
      this.writeCache(cacheFile, article.title, content, promptCustomization.cacheVariant, document)
      logSummaryPerf({
        prepareMs,
        requestStartMs,
        transportTimings,
        totalMs: performance.now() - perfStartedAt,
        streaming: capability.supportsStreaming,
        outcome: 'generated'
      })
      return document
    } catch (error) {
      logSummaryPerf({
        prepareMs,
        requestStartMs,
        transportTimings,
        totalMs: performance.now() - perfStartedAt,
        streaming: capability.supportsStreaming,
        outcome: signal?.aborted ? 'cancelled' : 'failed'
      })
      throw error
    }
  }

  private writeCache(cacheFile: string, title: string, content: string, customizationVariant: string, document: AiSummaryDocument): void {
    mkdirSync(this.cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(document, null, 2), 'utf8')
    writeFileSync(this.latestCacheFile(document.articleId), JSON.stringify({
      version: 7,
      titleHash: hashText(title),
      contentHash: hashText(content),
      customizationVariant,
      document
    }, null, 2), 'utf8')
  }

  async testProvider(providerId: string): Promise<void> {
    const settings = this.settings.current()
    const profile = settings.providers.find((item) => item.id === providerId)
    if (!profile) throw new Error('AI Provider 不存在')
    const model = profile.defaultModel.trim() || profile.models[0]?.trim() || ''
    if (!profile.endpoint.trim() || !model) throw new Error('请先填写 Endpoint 和模型')
    const result = await this.provider.complete('You are a connection test. Follow the user instruction exactly.', 'Reply with exactly: OK', {
      endpoint: profile.endpoint,
      model,
      apiKey: this.settings.getApiKey(providerId),
      requestTimeoutMs: NETWORK_REQUEST_TIMEOUT_MS.AI_PROVIDER_HEALTH
    })
    if (result.trim().toUpperCase() !== 'OK') throw new Error(`AI 服务连接测试返回异常：${result.slice(0, 100)}`)
  }

  async refreshModels(providerId: string, draftApiKey?: string): Promise<string[]> {
    const profile = this.settings.current().providers.find((item) => item.id === providerId)
    if (!profile) throw new Error('AI Provider 不存在')
    const models = await this.provider.listModels(profile.endpoint, draftApiKey ?? this.settings.getApiKey(providerId))
    this.settings.updateProvider({ id: providerId, models })
    return models
  }

  private cacheFile(articleId: string, title: string, content: string, providerId: string, endpoint: string, model: string, language: string, length: AiSummaryLength, customizationVariant: string): string {
    const key = createHash('sha256').update(JSON.stringify({ v: 7, articleId, title, content, providerId, endpoint, model, language, length, customizationVariant })).digest('hex')
    return join(this.cacheDir, `${key}.json`)
  }

  private latestCacheFile(articleId: string): string {
    return join(this.cacheDir, `latest-${hashText(articleId)}.json`)
  }
}

interface LatestAiSummaryCache {
  version: 7
  titleHash: string
  contentHash: string
  customizationVariant: string
  document: AiSummaryDocument
}

function readLatestCache(path: string, title: string, content: string, customizationVariant: string): AiSummaryDocument | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LatestAiSummaryCache
    if (
      parsed.version !== 7
      || parsed.titleHash !== hashText(title)
      || parsed.contentHash !== hashText(content)
      || parsed.customizationVariant !== customizationVariant
    ) return null
    return parsed.document?.articleId ? normalizeCachedDocument(parsed.document) : null
  } catch {
    return null
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function prepareArticleForSummary(
  source: ReaderArticleContent,
  length: AiSummaryLength = 'STANDARD',
  maxInputCharacters: number = aiSummaryInputBudget(length)
): string {
  const $ = cheerio.load(`<body>${source.html}</body>`)
  $('script,style,noscript').remove()
  // 报告/研究中的表格往往承载关键数据；先按表格自身预算压缩，再转成文本块。
  // 小表完整保留，大表从整张表范围等距抽样，避免单张巨表挤掉正文上下文。
  $('table').each((_index, element) => {
    const rows = $(element).find('tr').map((_rowIndex, row) => {
      const cells = $(row).find('th,td')
        .map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean)
      return compactTableRow(cells)
    }).get().filter(Boolean)
    if (rows.length === 0) { $(element).remove(); return }
    const replacement = $('<pre></pre>').text(compactTableRows(rows))
    $(element).replaceWith(replacement)
  })
  const parts: string[] = []
  const appendPart = (value: string): void => {
    const normalized = value.trim()
    if (!normalized || parts.at(-1) === normalized) return
    parts.push(normalized)
  }
  $('body').find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre').each((_index, element) => {
    const node = $(element)
    const tag = element.tagName.toLowerCase()
    const text = tag === 'pre'
      ? normalizePreformattedText(node.text())
      : node.text().replace(/\s+/g, ' ').trim()
    if (!text) return
    if (/^h[1-6]$/.test(tag)) appendPart(`${'#'.repeat(Number(tag[1]))} ${text}`)
    else if (tag === 'li') appendPart(`- ${text}`)
    else if (tag === 'blockquote') appendPart(`> ${text}`)
    else if (tag === 'pre') appendPart(`\`\`\`text\n${text}\n\`\`\``)
    else appendPart(text)
  })
  const structuredParts = parts.length > 0 ? parts : [($('body').text().replace(/\s+/g, ' ').trim())].filter(Boolean)
  const content = structuredParts.join(ARTICLE_BLOCK_SEPARATOR).trim()
  if (maxInputCharacters < MIN_AI_SUMMARY_ARTICLE_CHARACTERS) {
    throw new Error(`摘要正文预算不能低于 ${MIN_AI_SUMMARY_ARTICLE_CHARACTERS} 字符`)
  }
  if (content.length <= maxInputCharacters) return content
  return selectArticleCoverage(structuredParts, maxInputCharacters)
}

export interface AiSummaryRequestBudget {
  articleCharacterBudget: number
  outputReserveTokens: number
  estimatedFixedPromptTokens: number
  safetyMarginTokens: number
}

/**
 * 与 Android 相同：输出额度只用于给上下文预留空间，不直接作为 max_tokens 发给模型。
 * OpenAI-compatible tokenizer 不统一，因此文章正文继续按 1 字符≈1 token 做保守兜底。
 */
export function planAiSummaryBudget(
  contextWindowTokens: number,
  systemPrompt: string,
  title: string,
  length: AiSummaryLength
): AiSummaryRequestBudget {
  const outputReserveTokens = Math.min(
    length === 'BRIEF' ? 512 : length === 'STANDARD' ? 768 : 1_024,
    Math.max(256, Math.floor(contextWindowTokens / 3))
  )
  const estimatedFixedPromptTokens = estimateAiSummaryFixedPromptTokens(systemPrompt, title, length)
  const articleTokens = contextWindowTokens - outputReserveTokens - estimatedFixedPromptTokens - SUMMARY_TOKEN_SAFETY_MARGIN
  if (articleTokens < MIN_AI_SUMMARY_ARTICLE_CHARACTERS) {
    const fixedAndReserved = estimatedFixedPromptTokens + outputReserveTokens + SUMMARY_TOKEN_SAFETY_MARGIN
    if (fixedAndReserved > contextWindowTokens) {
      throw new Error(`固定提示词、输出预留和安全余量共约 ${fixedAndReserved} tokens，已超过 Provider 的 ${contextWindowTokens} token 上下文窗口`)
    }
    throw new Error(`扣除固定提示词、输出预留和安全余量后仅剩 ${articleTokens} tokens 正文预算，低于可产生有意义摘要的最小值 ${MIN_AI_SUMMARY_ARTICLE_CHARACTERS}`)
  }
  return {
    articleCharacterBudget: Math.min(aiSummaryInputBudget(length), articleTokens),
    outputReserveTokens,
    estimatedFixedPromptTokens,
    safetyMarginTokens: SUMMARY_TOKEN_SAFETY_MARGIN
  }
}

export function aiSummaryInputBudget(length: AiSummaryLength): number {
  if (length === 'BRIEF') return AI_SUMMARY_BRIEF_INPUT_CHARACTERS
  if (length === 'DETAILED') return AI_SUMMARY_DETAILED_INPUT_CHARACTERS
  return AI_SUMMARY_STANDARD_INPUT_CHARACTERS
}

export function estimateAiSummaryFixedPromptTokens(systemPrompt: string, title: string, length: AiSummaryLength): number {
  const wrapperWithoutArticle = buildAiSummaryUserPrompt(title, '', length)
  return estimateAiSummaryTokens(systemPrompt) + estimateAiSummaryTokens(wrapperWithoutArticle) + SUMMARY_MESSAGE_OVERHEAD_TOKENS
}

function estimateAiSummaryTokens(text: string): number {
  let quarterTokens = 0
  for (const char of text) {
    if (/\s/u.test(char)) continue
    if (/[A-Za-z0-9]/u.test(char)) quarterTokens += 1
    else quarterTokens += 4
  }
  return Math.ceil(quarterTokens / 4)
}

function buildArticleCoverageUnits(blocks: string[]): string[] {
  if (!blocks.some(isHeadingBlock)) return blocks
  const sections: string[][] = []
  for (const block of blocks) {
    if (isHeadingBlock(block) || sections.length === 0) sections.push([])
    sections.at(-1)!.push(block)
  }
  return sections.map((section) => section.join(ARTICLE_BLOCK_SEPARATOR))
}

function isHeadingBlock(block: string): boolean {
  return /^#{1,6}\s/u.test(block)
}

/** 保留首尾，并优先填补当前最大未覆盖区间，避免长报告中段长期被头尾裁剪丢弃。 */
function selectArticleCoverage(blocks: string[], budget: number): string {
  const units = buildArticleCoverageUnits(blocks)
  if (units.length === 0) return ''
  if (units.length === 1) return clipSingleCoverageUnit(units[0]!, budget)

  const selected = new Set<number>([0, units.length - 1])
  const rendered = new Map<number, string>([[0, units[0]!], [units.length - 1, units.at(-1)!]])
  let selectedLength = units[0]!.length + units.at(-1)!.length + coverageGapLength(0, units.length - 1)
  if (selectedLength > budget) return clipArticleEdges(units[0]!, units.at(-1)!, budget)

  for (const candidate of coveragePriority(units)) {
    const indices = [...selected].sort((left, right) => left - right)
    const previous = [...indices].reverse().find((index) => index < candidate)
    const next = indices.find((index) => index > candidate)
    if (previous === undefined || next === undefined) continue
    const addedLength = units[candidate]!.length
      + coverageGapLength(previous, candidate)
      + coverageGapLength(candidate, next)
      - coverageGapLength(previous, next)
    if (selectedLength + addedLength <= budget) {
      selected.add(candidate)
      rendered.set(candidate, units[candidate]!)
      selectedLength += addedLength
      continue
    }

    const clippedBudget = budget - selectedLength
      - coverageGapLength(previous, candidate)
      - coverageGapLength(candidate, next)
      + coverageGapLength(previous, next)
    if (clippedBudget >= MIN_COVERAGE_SAMPLE_CHARACTERS) {
      const clipped = clipSingleCoverageUnit(units[candidate]!, clippedBudget)
      selected.add(candidate)
      rendered.set(candidate, clipped)
      selectedLength += clipped.length
        + coverageGapLength(previous, candidate)
        + coverageGapLength(candidate, next)
        - coverageGapLength(previous, next)
    }
  }

  const indices = [...selected].sort((left, right) => left - right)
  return indices.map((index, position) => {
    const prefix = position === 0 ? '' : coverageGap(indices[position - 1]!, index)
    return prefix + rendered.get(index)!
  }).join('')
}

function coveragePriority(units: string[]): number[] {
  const centers: number[] = []
  let sourceOffset = 0
  for (const unit of units) {
    centers.push(sourceOffset + unit.length / 2)
    sourceOffset += unit.length + ARTICLE_BLOCK_SEPARATOR.length
  }
  const intervals: Array<{ start: number; end: number }> = [{ start: 0, end: units.length - 1 }]
  const result: number[] = []
  while (intervals.length > 0) {
    intervals.sort((left, right) => {
      const rightSpan = centers[right.end]! - centers[right.start]!
      const leftSpan = centers[left.end]! - centers[left.start]!
      return rightSpan - leftSpan || left.start - right.start
    })
    const interval = intervals.shift()!
    if (interval.end - interval.start <= 1) continue
    const target = (centers[interval.start]! + centers[interval.end]!) / 2
    let middle = interval.start + 1
    let distance = Number.POSITIVE_INFINITY
    for (let candidate = interval.start + 1; candidate < interval.end; candidate += 1) {
      const current = Math.abs(centers[candidate]! - target)
      if (current < distance) { middle = candidate; distance = current }
    }
    result.push(middle)
    intervals.push({ start: interval.start, end: middle }, { start: middle, end: interval.end })
  }
  return [...new Set(result)]
}

function coverageGap(previous: number, next: number): string {
  return next === previous + 1 ? ARTICLE_BLOCK_SEPARATOR : ARTICLE_OMISSION_SEPARATOR
}

function coverageGapLength(previous: number, next: number): number {
  return coverageGap(previous, next).length
}

function clipSingleCoverageUnit(unit: string, budget: number): string {
  const sanitized = omitFencedBlocksWhenClipping(unit)
  if (sanitized.length <= budget) return sanitized
  const remaining = Math.max(0, budget - ARTICLE_OMISSION_SEPARATOR.length * 2)
  const headBudget = Math.floor(remaining / 3)
  const middleBudget = Math.floor(remaining / 3)
  const tailBudget = remaining - headBudget - middleBudget
  const middleStart = Math.max(0, Math.floor((sanitized.length - middleBudget) / 2))
  return safeTake(sanitized, headBudget)
    + ARTICLE_OMISSION_SEPARATOR
    + safeSlice(sanitized, middleStart, middleBudget)
    + ARTICLE_OMISSION_SEPARATOR
    + safeTakeLast(sanitized, tailBudget)
}

function clipArticleEdges(first: string, last: string, budget: number): string {
  const remaining = Math.max(0, budget - ARTICLE_OMISSION_SEPARATOR.length)
  const firstBudget = Math.floor(remaining / 2)
  const lastBudget = remaining - firstBudget
  return clipSingleCoverageUnit(first, firstBudget)
    + ARTICLE_OMISSION_SEPARATOR
    + clipSingleCoverageUnit(last, lastBudget)
}

function omitFencedBlocksWhenClipping(value: string): string {
  if (!value.includes('```')) return value
  const result: string[] = []
  let inFence = false
  let omittedFence = false
  for (const line of value.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      if (!inFence && omittedFence) {
        result.push('[structured code/table block omitted due to input limit]')
        omittedFence = false
      }
    } else if (inFence) {
      omittedFence = true
    } else {
      result.push(line)
    }
  }
  if (omittedFence) result.push('[structured code/table block omitted due to input limit]')
  return result.join('\n').trim()
}

function safeSlice(value: string, start: number, maxCharacters: number): string {
  if (maxCharacters <= 0 || !value) return ''
  let safeStart = Math.max(0, Math.min(value.length, start))
  if (safeStart < value.length && isLowSurrogate(value.charCodeAt(safeStart))) safeStart += 1
  return safeTake(value.slice(safeStart), maxCharacters)
}

function safeTake(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  let end = Math.max(0, Math.min(value.length, maxCharacters))
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1
  return value.slice(0, end)
}

function safeTakeLast(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  let start = Math.max(0, value.length - maxCharacters)
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) start += 1
  return value.slice(start)
}

function isHighSurrogate(codeUnit: number): boolean { return codeUnit >= 0xD800 && codeUnit <= 0xDBFF }
function isLowSurrogate(codeUnit: number): boolean { return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF }

function normalizePreformattedText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function compactTableRow(rawCells: string[]): string {
  if (rawCells.length === 0) return ''
  const cells = rawCells.length <= MAX_TABLE_COLUMNS
    ? rawCells
    : [
        ...rawCells.slice(0, TABLE_LEADING_COLUMNS),
        `[…省略 ${rawCells.length - TABLE_LEADING_COLUMNS - TABLE_TRAILING_COLUMNS} 列…]`,
        ...rawCells.slice(-TABLE_TRAILING_COLUMNS)
      ]
  const perCellBudget = Math.max(64, Math.min(MAX_TABLE_CELL_CHARACTERS, Math.floor(MAX_TABLE_ROW_CHARACTERS / cells.length)))
  return `| ${cells.map((cell) => truncateTableCell(cell, perCellBudget)).join(' | ')} |`
}

function truncateTableCell(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(1, limit - 1))}…`
}

function compactTableRows(rows: string[]): string {
  const complete = rows.join('\n')
  if (complete.length <= MAX_TABLE_INPUT_CHARACTERS) return complete

  const averageRowLength = Math.max(1, Math.ceil(complete.length / rows.length))
  let targetRows = Math.max(3, Math.min(rows.length, Math.floor((MAX_TABLE_INPUT_CHARACTERS - 180) / (averageRowLength + 1))))
  while (targetRows >= 3) {
    const indices = evenlySpacedIndices(rows.length, targetRows)
    const selected = indices.map((index) => rows[index]!).join('\n')
    const marker = `[表格过大：共 ${rows.length} 行，以下按整表范围抽取 ${indices.length} 行；未展示行不代表无关]\n`
    if (marker.length + selected.length <= MAX_TABLE_INPUT_CHARACTERS) return marker + selected
    targetRows -= 1
  }

  const indices = evenlySpacedIndices(rows.length, Math.min(3, rows.length))
  const marker = `[表格过大：共 ${rows.length} 行，以下仅保留代表行；未展示行不代表无关]\n`
  return (marker + indices.map((index) => rows[index]!).join('\n')).slice(0, MAX_TABLE_INPUT_CHARACTERS)
}

function evenlySpacedIndices(length: number, count: number): number[] {
  if (count >= length) return Array.from({ length }, (_value, index) => index)
  if (count <= 1) return [0]
  const indices = new Set<number>()
  for (let index = 0; index < count; index += 1) {
    indices.add(Math.round(index * (length - 1) / (count - 1)))
  }
  return [...indices].sort((left, right) => left - right)
}

/**
 * 摘要协议首行是不可见 metadata；注释未闭合前不能把半截协议文本闪给用户。
 * 兼容模型若完全忽略 metadata 而直接返回正文，则正常显示实时正文。
 */
export function extractAiSummaryStreamPreview(rawContent: string): string {
  const trimmed = rawContent.trimStart()
  if (!trimmed) return ''
  if (trimmed.startsWith('<!--')) {
    const commentEnd = trimmed.indexOf('-->')
    if (commentEnd < 0) return ''
    return trimmed.slice(commentEnd + 3).trimStart()
  }
  if (trimmed.length <= 4 && '<!--'.startsWith(trimmed)) return ''
  return trimmed
}

const MAX_TABLE_INPUT_CHARACTERS = 6_000
const MAX_TABLE_COLUMNS = 16
const TABLE_LEADING_COLUMNS = 8
const TABLE_TRAILING_COLUMNS = 7
const MAX_TABLE_CELL_CHARACTERS = 320
const MAX_TABLE_ROW_CHARACTERS = 1_600
const AI_SUMMARY_BRIEF_INPUT_CHARACTERS = 12_000
const AI_SUMMARY_STANDARD_INPUT_CHARACTERS = 24_000
const AI_SUMMARY_DETAILED_INPUT_CHARACTERS = 36_000
const ARTICLE_BLOCK_SEPARATOR = '\n\n'
const ARTICLE_OMISSION_SEPARATOR = '\n\n> [content omitted due to input limit]\n\n'
const MIN_AI_SUMMARY_ARTICLE_CHARACTERS = 512
const MIN_COVERAGE_SAMPLE_CHARACTERS = 256
const SUMMARY_MESSAGE_OVERHEAD_TOKENS = 16
const SUMMARY_TOKEN_SAFETY_MARGIN = 192
const SUMMARY_STREAM_UI_INTERVAL_MS = 80
const SUMMARY_STREAM_REASONING_PREVIEW_CHARS = 1_600
const SUMMARY_STREAM_CONTENT_PREVIEW_CHARS = 2_200

interface SummaryPerfLogInput {
  prepareMs: number
  requestStartMs: number
  transportTimings: Partial<Record<AiTransportTimingMetric, number>>
  totalMs: number
  streaming: boolean
  outcome: 'generated' | 'failed' | 'cancelled'
}

function logSummaryPerf(input: SummaryPerfLogInput): void {
  const round = (value: number): number => Math.max(0, Math.round(value * 10) / 10)
  console.info('[OrigRead][AI Perf]', JSON.stringify({
    task: 'summary',
    prepare_ms: round(input.prepareMs),
    request_start_ms: round(input.requestStartMs),
    TTFB_ms: input.transportTimings.TTFB ?? null,
    first_sse_ms: input.transportTimings.first_sse ?? null,
    TTFR_ms: input.transportTimings.TTFR ?? null,
    TTFC_ms: input.transportTimings.TTFC ?? null,
    total_ms: round(input.totalMs),
    streaming: input.streaming,
    outcome: input.outcome
  }))
}

function readCache(file: string): AiSummaryDocument | null {
  try { return existsSync(file) ? normalizeCachedDocument(JSON.parse(readFileSync(file, 'utf8')) as AiSummaryDocument) : null } catch { return null }
}

function normalizeCachedDocument(document: AiSummaryDocument): AiSummaryDocument {
  return {
    ...document,
    status: document.status === 'NOT_NEEDED' ? 'NOT_NEEDED' : 'GENERATED',
    articleForm: document.articleForm ?? null,
    domain: document.domain ?? null,
    skipReason: document.skipReason ?? null
  }
}

