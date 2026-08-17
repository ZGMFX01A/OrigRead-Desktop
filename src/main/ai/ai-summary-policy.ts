import type { AiArticleForm, AiSummaryLength, AiSummarySkipReason } from '../../shared/ai'

export interface AiSummaryInputMetrics {
  /**
   * 跨语言等效长度单位：CJK 字符约 1 单位，非 CJK 的字母/数字词约 2 单位。
   * 这不是精确 token 数，只用于跨语言一致的短文判断和摘要长度预算。
   */
  effectiveLength: number
  blockCount: number
  sentenceCount: number
  headingCount: number
  listItemCount: number
  quoteCount: number
  codeFenceCount: number
}

export interface AiSummaryModelDecision {
  shouldSummarize: boolean
  articleForm: AiArticleForm | null
  domain: string | null
  reason: AiSummarySkipReason | null
  summary: string
}

const ARTICLE_FORMS = new Set<AiArticleForm>(['flash', 'release', 'news', 'review', 'guide', 'research', 'report', 'analysis', 'opinion', 'interview', 'other'])
const SKIP_REASONS = new Set<AiSummarySkipReason>(['source_already_concise', 'low_compression_value', 'insufficient_content'])
const META_V1_PATTERN = /^\s*<!--\s*origread-summary-v1:\s*(\{[^\r\n]*\})\s*-->\s*/i
const LEGACY_META_PATTERN = /^\s*<!--\s*origread-summary:\s*(\{[^\r\n]*\})\s*-->\s*/i

export function measureAiSummaryInput(content: string): AiSummaryInputMetrics {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean)
  const headingCount = nonEmpty.filter((line) => /^#{1,6}\s+/.test(line)).length
  const listItemCount = nonEmpty.filter((line) => /^[-*+]\s+/.test(line)).length
  const quoteCount = nonEmpty.filter((line) => /^>\s+/.test(line)).length
  const codeFenceCount = Math.floor(nonEmpty.filter((line) => /^```/.test(line)).length / 2)
  const plain = nonEmpty
    .filter((line) => !/^```/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^>\s+/, ''))
    .join(' ')
  const effectiveLength = measureEffectiveLength(plain)
  const sentenceCount = plain.split(/[。！？!?]+|(?<=[.!?])\s+/).map((value) => value.trim()).filter(Boolean).length
  const blockCount = content.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean).length
  return { effectiveLength, blockCount, sentenceCount, headingCount, listItemCount, quoteCount, codeFenceCount }
}

/**
 * 用稳定、跨端可复现的启发式估算信息长度。
 * - 汉字 / 日文假名 / 韩文音节：每个字符 1 单位。
 * - 其余 Unicode 字母或数字组成的词：每词 2 单位。
 * - 标点与空白不计。
 *
 * 这样约 70 个英文单词和约 140 个 CJK 字符会落在相近的短文判断区间，
 * 避免简单使用 String.length 时英文因为平均词长较长而被系统性高估。
 */
export function measureEffectiveLength(text: string): number {
  let cjkCharacters = 0
  let nonCjk = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (isCjkLike(codePoint)) {
      cjkCharacters += 1
      nonCjk += ' '
    } else {
      nonCjk += char
    }
  }
  const wordCount = nonCjk.match(/[\p{L}\p{N}]+(?:[._'’/-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return cjkCharacters + wordCount * 2
}

function isCjkLike(codePoint: number): boolean {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x31f0 && codePoint <= 0x31ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
}

/** 只拦截“确定几乎没有压缩空间”的短正文；结构化短文一律放给 AI 判断，避免误杀短教程/短报告。 */
export function localSummarySkipReason(metrics: AiSummaryInputMetrics): AiSummarySkipReason | null {
  const structured = metrics.headingCount >= 2 || metrics.listItemCount >= 3 || metrics.quoteCount >= 2 || metrics.codeFenceCount >= 1
  if (structured) return null
  if (metrics.effectiveLength <= 140) return 'local_source_already_concise'
  if (metrics.effectiveLength <= 280 && metrics.sentenceCount <= 3 && metrics.blockCount <= 3) return 'local_source_already_concise'
  if (metrics.effectiveLength <= 420 && metrics.sentenceCount <= 2 && metrics.blockCount <= 2) return 'local_source_already_concise'
  return null
}

/**
 * 这里返回的是硬上限而不是目标长度。
 * “软可读下限”只能抬高模式比例结果，但最终仍受原文 48% 压缩上限约束，因此短文不会被强行写长。
 */
export function summaryOutputCeiling(effectiveLength: number, length: AiSummaryLength): number {
  const source = Math.max(1, effectiveLength)
  const mode = length === 'BRIEF'
    ? { ratio: 0.25, softFloor: 80, max: 220 }
    : length === 'STANDARD'
      ? { ratio: 0.30, softFloor: 140, max: 650 }
      : { ratio: 0.45, softFloor: 220, max: 1_000 }
  const proportional = Math.floor(source * mode.ratio)
  const compressionCap = Math.max(1, Math.floor(source * 0.48))
  return Math.max(1, Math.min(mode.max, Math.max(mode.softFloor, proportional), compressionCap))
}

export function parseAiSummaryModelOutput(content: string): AiSummaryModelDecision {
  const match = META_V1_PATTERN.exec(content) ?? LEGACY_META_PATTERN.exec(content)
  if (!match) return { shouldSummarize: true, articleForm: null, domain: null, reason: null, summary: content.trim() }
  try {
    const meta = JSON.parse(match[1]!) as Record<string, unknown>
    const shouldSummarize = meta.shouldSummarize !== false
    const form = typeof meta.form === 'string' && ARTICLE_FORMS.has(meta.form as AiArticleForm) ? meta.form as AiArticleForm : null
    const domain = typeof meta.domain === 'string' ? meta.domain.trim().slice(0, 48) || null : null
    const reason = typeof meta.reason === 'string' && SKIP_REASONS.has(meta.reason as AiSummarySkipReason) ? meta.reason as AiSummarySkipReason : null
    const summary = content.slice(match[0].length).trim()
    if (shouldSummarize && !summary) throw new Error('AI 摘要元数据声明需要摘要，但没有返回摘要正文')
    return { shouldSummarize, articleForm: form, domain, reason: shouldSummarize ? null : (reason ?? 'low_compression_value'), summary: shouldSummarize ? summary : '' }
  } catch {
    // 兼容不完全遵循协议的 OpenAI Compatible 模型：元数据坏掉时 fail-open，仍显示模型正文。
    return {
      shouldSummarize: true,
      articleForm: null,
      domain: null,
      reason: null,
      summary: content.replace(META_V1_PATTERN, '').replace(LEGACY_META_PATTERN, '').trim() || content.trim()
    }
  }
}

export function articleFormCaps(length: AiSummaryLength): string {
  if (length === 'BRIEF') return '快讯 100；产品/版本发布 160；普通新闻 180；评测/教程/科研/报告/深度分析/观点/访谈 220'
  if (length === 'STANDARD') return '快讯 160；产品/版本发布 280；普通新闻 360；评测 520；教程 560；科研/行业报告/深度分析 650；观点/访谈 520'
  return '快讯 200；产品/版本发布 420；普通新闻 500；评测 700；教程 850；科研/行业报告/深度分析 1000；观点/访谈 800'
}
