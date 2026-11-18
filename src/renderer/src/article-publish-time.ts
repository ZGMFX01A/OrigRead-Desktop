import { resolveDesktopLanguage, type DesktopLanguage } from '../../shared/locale'

export interface ArticlePublishTimeInfo {
  /** ISO 8601 string for HTML time element dateTime attribute */
  iso: string
  /** Relative time for list row, or formatted date if far future */
  relative: string
  /** Full date and time for title/tooltip */
  full: string
  /** Detail line display text, e.g. "2026/8/6 15:06:40 (10分钟前)" or "2026/8/6 15:06:40" */
  detail: string
  /** Whether the timestamp is in the future beyond tolerance */
  isFuture: boolean
}

/** 容忍最大 60 秒的轻微未来时钟偏差（网络对时或发布服务器微小误差） */
export const PUBLISH_TIME_SKEW_TOLERANCE_MS = 60_000

const JUST_NOW_BY_LANG: Record<DesktopLanguage, string> = {
  zh: '刚刚',
  en: 'Just now',
  es: 'Ahora mismo',
  'pt-BR': 'Agora mesmo',
  de: 'Gerade eben',
  fr: 'À l’instant',
  ja: 'たった今'
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>()
const fullDtfCache = new Map<string, Intl.DateTimeFormat>()
const dateOnlyDtfCache = new Map<string, Intl.DateTimeFormat>()

function getRelativeTimeFormatter(locale?: string): Intl.RelativeTimeFormat {
  const key = locale ?? 'default'
  let formatter = rtfCache.get(key)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto' })
    rtfCache.set(key, formatter)
  }
  return formatter
}

function getFullDateTimeFormatter(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? 'default'
  let formatter = fullDtfCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale || undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    })
    fullDtfCache.set(key, formatter)
  }
  return formatter
}

function getDateOnlyFormatter(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? 'default'
  let formatter = dateOnlyDtfCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale || undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    })
    dateOnlyDtfCache.set(key, formatter)
  }
  return formatter
}

export function getJustNowText(locale?: string): string {
  const lang = resolveDesktopLanguage(locale ?? 'en')
  return JUST_NOW_BY_LANG[lang] ?? 'Just now'
}

/**
 * 校验 publishedAt 是否为合法的时间戳数字
 * 0 和 1970 年之前的负数时间戳均合法；只拒绝非法和越界值。
 */
export function isValidPublishTime(publishedAt: unknown): publishedAt is number {
  if (typeof publishedAt !== 'number') return false
  if (!Number.isFinite(publishedAt)) return false
  // JS Date 最大安全时间戳约为 8.64e15 ms
  if (Math.abs(publishedAt) > 8_640_000_000_000_000) return false
  const date = new Date(publishedAt)
  return !Number.isNaN(date.getTime())
}

/**
 * 格式化文章发布时间。
 * @param publishedAt 文章发布毫秒时间戳（0 为合法 epoch）
 * @param locale 当前语言代码
 * @param now 基准时间戳（默认当前时间），便于确定性测试
 * @returns 包含语义 iso、相对时间、完整时间和详情展示文本的结构，非法/缺失时返回 null
 */
export function formatArticlePublishTime(
  publishedAt: unknown,
  locale?: string,
  now: number = Date.now()
): ArticlePublishTimeInfo | null {
  if (!isValidPublishTime(publishedAt)) return null

  const date = new Date(publishedAt)
  const diffMs = now - publishedAt
  const full = getFullDateTimeFormatter(locale).format(date)
  const iso = date.toISOString()

  let relative: string
  let isFuture = false

  // 1. 未来时间判断：超过微小时钟误差（60秒）的不伪装为“刚刚”，真实展示日期
  if (diffMs < -PUBLISH_TIME_SKEW_TOLERANCE_MS) {
    isFuture = true
    relative = getDateOnlyFormatter(locale).format(date)
  } else if (diffMs <= PUBLISH_TIME_SKEW_TOLERANCE_MS) {
    // 2. 刚刚（含微小未来时钟偏差容忍）
    relative = getJustNowText(locale)
  } else if (diffMs < 3_600_000) {
    // 3. 1小时内：按分钟
    const minutes = Math.max(1, Math.floor(diffMs / 60_000))
    relative = getRelativeTimeFormatter(locale).format(-minutes, 'minute')
  } else if (diffMs < 86_400_000) {
    // 4. 24小时内：按小时
    const hours = Math.floor(diffMs / 3_600_000)
    relative = getRelativeTimeFormatter(locale).format(-hours, 'hour')
  } else if (diffMs < 86_400_000 * 30) {
    // 5. 30天内：按天
    const days = Math.floor(diffMs / 86_400_000)
    relative = getRelativeTimeFormatter(locale).format(-days, 'day')
  } else if (diffMs < 86_400_000 * 365) {
    // 6. 1年内：按月
    const months = Math.floor(diffMs / (86_400_000 * 30))
    relative = getRelativeTimeFormatter(locale).format(-Math.max(1, months), 'month')
  } else {
    // 7. 超过1年：按年
    const years = Math.floor(diffMs / (86_400_000 * 365))
    relative = getRelativeTimeFormatter(locale).format(-Math.max(1, years), 'year')
  }

  // 详情展示完整日期时间可附相对时间；若是远期未来日期则只展示完整日期时间
  const detail = isFuture ? full : `${full} (${relative})`

  return {
    iso,
    relative,
    full,
    detail,
    isFuture
  }
}
