import * as cheerio from 'cheerio'
import type { WebsiteFetchPayload } from './website-source-service'
import type { FeedRecord } from '../../../shared/library'

import { javaStringHash, resolveHttpUrl, unsignedHex } from './website-dom'

import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'
import { decodeHttpText } from '../../network/http-text-decoder'

// 沿用当前自动 DOM 的资源上限；失效手动规则不能绕过自动识别的页面限制。
export const MAX_AUTOMATIC_HTML_CHARS = 750_000

export class WebsitePageTooComplexError extends Error {
  constructor() {
    super('页面过大，已超过自动 DOM 识别资源上限')
    this.name = 'WebsitePageTooComplexError'
  }
}

export async function defaultWebsiteFetcher(url: string, signal?: AbortSignal): Promise<WebsiteFetchPayload> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    headers: {
      'user-agent': DESKTOP_BROWSER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    finalUrl: response.url || url,
    html: decodeHttpText(bytes, response.headers.get('content-type'), 'html')
  }
}

export function probeFeedRecord(url: string, now: number): FeedRecord {
  return {
    id: `website-probe:${unsignedHex(javaStringHash(url))}`,
    groupId: 'website-probe',
    name: 'Website Probe',
    url,
    sourcePageUrl: url,
    sourceType: 'website',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

export function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function isWebsiteHealthCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('当前网站的解析规则均未通过健康检查：')
}

export function findIconUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  for (const link of $('link[href]').toArray()) {
    const rel = ($(link).attr('rel') ?? '').trim().toLowerCase()
    if (!/^(shortcut\s+)?icon$/.test(rel)) continue
    const href = $(link).attr('href')
    if (!href) continue
    const resolved = resolveHttpUrl(baseUrl, href)
    if (resolved) return resolved
  }
  return null
}
