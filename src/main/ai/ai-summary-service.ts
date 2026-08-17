import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import type { AiSummaryDocument, AiSummaryLength, AiSummaryProgressStage, AiSummaryRequestOptions } from '../../shared/ai'
import type { ReaderArticleContent } from '../../shared/reader'
import type { LibraryRepository } from '../database/library-repository'
import type { ReaderContentService } from '../content/reader-content-service'
import { buildAiSummarySystemPrompt, buildAiSummaryUserPrompt } from './ai-summary-prompts'
import { localSummarySkipReason, measureAiSummaryInput, parseAiSummaryModelOutput } from './ai-summary-policy'
import type { AiSettingsRepository } from './ai-settings-repository'
import { OpenAiCompatibleProvider } from './openai-compatible-provider'

export class AiSummaryService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly reader: ReaderContentService,
    private readonly settings: AiSettingsRepository,
    private readonly cacheDir: string,
    private readonly provider = new OpenAiCompatibleProvider()
  ) {}

  async summarize(
    articleId: string,
    forceRefresh = false,
    options: AiSummaryRequestOptions = {},
    onProgress: (stage: AiSummaryProgressStage) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<AiSummaryDocument> {
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
    onProgress('PREPARING')
    const source = this.reader.get(articleId)
    const content = prepareArticleForSummary(source)
    if (!content) throw new Error('当前文章没有可用于摘要的正文')
    const metrics = measureAiSummaryInput(content)
    const cacheFile = this.cacheFile(articleId, article.title, content, profile.id, profile.endpoint, model, config.outputLanguage, length)
    if (!forceRefresh) {
      if (!options.providerId && !options.model && !options.length) {
        const latest = readLatestCache(this.latestCacheFile(articleId), article.title, content)
        if (latest) return latest
      }
      const cached = readCache(cacheFile)
      if (cached) return cached
    }
    const localSkip = localSummarySkipReason(metrics)
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
      this.writeCache(cacheFile, article.title, content, document)
      return document
    }
    onProgress('REQUESTING')
    const completed = await this.provider.completeDetailed(
      buildAiSummarySystemPrompt(config.outputLanguage),
      buildAiSummaryUserPrompt(article.title, content, length),
      { endpoint: profile.endpoint, model, apiKey: this.settings.getApiKey(profile.id) },
      signal
    )
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
      status: decision.shouldSummarize ? 'GENERATED' : 'NOT_NEEDED',
      articleForm: decision.articleForm,
      domain: decision.domain,
      skipReason: decision.reason
    }
    onProgress('FINALIZING')
    this.writeCache(cacheFile, article.title, content, document)
    return document
  }

  private writeCache(cacheFile: string, title: string, content: string, document: AiSummaryDocument): void {
    mkdirSync(this.cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(document, null, 2), 'utf8')
    writeFileSync(this.latestCacheFile(document.articleId), JSON.stringify({
      version: 4,
      titleHash: hashText(title),
      contentHash: hashText(content),
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
      endpoint: profile.endpoint, model, apiKey: this.settings.getApiKey(providerId)
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

  private cacheFile(articleId: string, title: string, content: string, providerId: string, endpoint: string, model: string, language: string, length: AiSummaryLength): string {
    const key = createHash('sha256').update(JSON.stringify({ v: 4, articleId, title, content, providerId, endpoint, model, language, length })).digest('hex')
    return join(this.cacheDir, `${key}.json`)
  }

  private latestCacheFile(articleId: string): string {
    return join(this.cacheDir, `latest-${hashText(articleId)}.json`)
  }
}

interface LatestAiSummaryCache {
  version: 4
  titleHash: string
  contentHash: string
  document: AiSummaryDocument
}

function readLatestCache(path: string, title: string, content: string): AiSummaryDocument | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LatestAiSummaryCache
    if (parsed.version !== 4 || parsed.titleHash !== hashText(title) || parsed.contentHash !== hashText(content)) return null
    return parsed.document?.articleId ? normalizeCachedDocument(parsed.document) : null
  } catch {
    return null
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function prepareArticleForSummary(source: ReaderArticleContent): string {
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
  $('body').find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre').each((_index, element) => {
    const node = $(element)
    const tag = element.tagName.toLowerCase()
    const text = tag === 'pre'
      ? normalizePreformattedText(node.text())
      : node.text().replace(/\s+/g, ' ').trim()
    if (!text) return
    if (/^h[1-6]$/.test(tag)) parts.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
    else if (tag === 'li') parts.push(`- ${text}`)
    else if (tag === 'blockquote') parts.push(`> ${text}`)
    else if (tag === 'pre') parts.push(`\`\`\`text\n${text}\n\`\`\``)
    else parts.push(text)
  })
  let content = parts.join('\n\n').trim()
  if (content.length > 24_000) content = `${content.slice(0, 18_000)}\n\n[...中间内容已截断...]\n\n${content.slice(-6_000)}`
  return content
}

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

const MAX_TABLE_INPUT_CHARACTERS = 6_000
const MAX_TABLE_COLUMNS = 16
const TABLE_LEADING_COLUMNS = 8
const TABLE_TRAILING_COLUMNS = 7
const MAX_TABLE_CELL_CHARACTERS = 320
const MAX_TABLE_ROW_CHARACTERS = 1_600

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

