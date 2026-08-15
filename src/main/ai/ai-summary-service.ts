import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import type { AiSummaryDocument, AiSummaryLength, AiSummaryRequestOptions } from '../../shared/ai'
import type { ReaderArticleContent } from '../../shared/reader'
import type { LibraryRepository } from '../database/library-repository'
import type { ReaderContentService } from '../content/reader-content-service'
import { buildAiSummarySystemPrompt, buildAiSummaryUserPrompt } from './ai-summary-prompts'
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

  async summarize(articleId: string, forceRefresh = false, options: AiSummaryRequestOptions = {}): Promise<AiSummaryDocument> {
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
    const source = this.reader.get(articleId)
    const content = prepareArticleForSummary(source)
    if (!content) throw new Error('当前文章没有可用于摘要的正文')
    const cacheFile = this.cacheFile(articleId, article.title, content, profile.id, profile.endpoint, model, config.outputLanguage, length)
    if (!forceRefresh) {
      const cached = readCache(cacheFile)
      if (cached) return cached
    }
    const completed = await this.provider.completeDetailed(
      buildAiSummarySystemPrompt(config.outputLanguage),
      buildAiSummaryUserPrompt(article.title, content, length),
      { endpoint: profile.endpoint, model, apiKey: this.settings.getApiKey(profile.id) }
    )
    const document: AiSummaryDocument = {
      articleId,
      providerId: profile.id,
      providerName: profile.name,
      model,
      outputLanguage: config.outputLanguage,
      length,
      summary: completed.content,
      reasoning: completed.reasoning
    }
    mkdirSync(this.cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(document, null, 2), 'utf8')
    return document
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
    const key = createHash('sha256').update(JSON.stringify({ v: 1, articleId, title, content, providerId, endpoint, model, language, length })).digest('hex')
    return join(this.cacheDir, `${key}.json`)
  }
}

export function prepareArticleForSummary(source: ReaderArticleContent): string {
  const $ = cheerio.load(`<body>${source.html}</body>`)
  $('script,style,noscript').remove()
  const parts: string[] = []
  $('body').find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre').each((_index, element) => {
    const node = $(element)
    const text = node.text().replace(/\s+/g, ' ').trim()
    if (!text) return
    const tag = element.tagName.toLowerCase()
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

function readCache(file: string): AiSummaryDocument | null {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as AiSummaryDocument : null } catch { return null }
}

