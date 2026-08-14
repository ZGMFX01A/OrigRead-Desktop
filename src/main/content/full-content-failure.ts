import * as cheerio from 'cheerio'
import type { FullContentFailureReason } from '../../shared/reader'

export class FullContentError extends Error {
  constructor(
    readonly reason: FullContentFailureReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'FullContentError'
  }
}

const ACCESS_MARKERS = [
  'access denied', 'forbidden', 'verify you are human', 'captcha', 'cloudflare ray id',
  '安全验证', '访问受限', '请先登录', '登录后查看'
]
const DYNAMIC_MARKERS = [
  'enable javascript', 'please enable javascript', 'javascript is required',
  'id="__next"', "id='__next'", 'id="app"></div>', "id='app'></div>",
  '_guard/auto.js', '需要启用 javascript'
]

export function classifyFullContentHtml(html: string): FullContentFailureReason {
  const normalized = html.toLocaleLowerCase()
  if (ACCESS_MARKERS.some((marker) => normalized.includes(marker))) return 'ACCESS_RESTRICTED'
  if (DYNAMIC_MARKERS.some((marker) => normalized.includes(marker))) return 'DYNAMIC_CONTENT'
  return 'NO_CONTENT'
}

export function classifyFullContentHttpStatus(status: number): FullContentFailureReason {
  if ([401, 403, 407, 429, 451].includes(status)) return 'ACCESS_RESTRICTED'
  if (status >= 400 && status <= 599) return 'PAGE_UNAVAILABLE'
  return 'UNKNOWN'
}

export function shouldAttemptDynamicArticleContent(
  html: string,
  reason: FullContentFailureReason,
  enabled: boolean,
  allowRestrictedFallback = false
): boolean {
  if (!enabled) return false
  if (reason === 'DYNAMIC_CONTENT') return true
  if (reason === 'ACCESS_RESTRICTED') return allowRestrictedFallback
  if (reason !== 'NO_CONTENT') return false
  const $ = cheerio.load(html)
  const visibleTextLength = $('body').text().trim().length
  if (visibleTextLength > 500) return false
  const normalized = html.toLocaleLowerCase()
  const dynamicRoots = [
    'id="__next"', "id='__next'", 'id="__nuxt"', "id='__nuxt'",
    'data-reactroot', 'data-server-rendered', 'ng-version=', 'id="app"', "id='app'"
  ]
  const hasHydrationRoot = dynamicRoots.some((marker) => normalized.includes(marker))
  const hasExecutableScripts = $('script[src], script:not([type="application/ld+json"])').length > 0
  return hasHydrationRoot || hasExecutableScripts
}
