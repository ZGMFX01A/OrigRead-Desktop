import { join } from 'node:path'
import { vi } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { RssDiscoveryService, type RssFetchPayload } from './rss/rss-discovery-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { SourceDiscoveryService } from './source-discovery-service'
import { JsonArticleParser } from './json/json-article-parser'
import { JsonRuleRepository } from './json/json-rule-repository'
import { JsonSourceService } from './json/json-source-service'
import type { RssHubResolver } from './rsshub/rsshub-resolver'
import type { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { WebsiteSourceService } from './website/website-source-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'
import type { AccountRecord } from '../../shared/account'

/** 用真实 SQLite 和来源解析器复现订阅问题，测试结束关闭内存数据库。 */
export async function withLibrary(run: (library: LibraryRepository, database: DesktopDatabase) => Promise<void>): Promise<void> {
  const database = new DesktopDatabase(':memory:')
  try {
    await run(new LibraryRepository(database.connection), database)
  } finally {
    database.close()
  }
}

/** 每次返回可调整顺序、GUID、链接的真实 RSS XML。 */
export function rssXml(items: Array<{ guid?: string; link?: string; title: string }>): string {
  return `<rss version="2.0"><channel><title>Regression feed</title><link>https://example.com/</link>
    ${items.map((item) => `<item>${item.guid ? `<guid>${item.guid}</guid>` : ''}
      <title>${item.title}</title>${item.link ? `<link>${item.link}</link>` : ''}
      <pubDate>Mon, 03 Aug 2026 08:00:00 GMT</pubDate><description>Article body</description></item>`).join('')}
  </channel></rss>`
}

/** Atom 的 ID 和可打开链接分别进入正式解析器，便于验证两者独立变化。 */
export function atomXml(item: { id: string; link?: string; title: string }): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom regression</title>
    <id>urn:origread:feed</id><updated>2026-08-03T08:00:00Z</updated><entry>
    <id>${item.id}</id><title>${item.title}</title><updated>2026-08-03T08:00:00Z</updated>
    ${item.link ? `<link rel="alternate" href="${item.link}"/>` : ''}
    <content type="html">Article body</content></entry></feed>`
}

/** 用字节形式进入正式 XML 解码和解析路径。 */
export function rssPayload(finalUrl: string, content: string): RssFetchPayload {
  return { finalUrl, contentType: 'application/xml', bytes: new TextEncoder().encode(content) }
}

/** 禁止在这些回归用例中访问图标网络。 */
export function rssDiscovery(content: () => string): RssDiscoveryService {
  return new RssDiscoveryService(async (url) => rssPayload(url, content()), { findBestIcon: async () => null })
}

/** JSON 解析与规则选择保留正式实现，仅注入网络边界。 */
export function jsonSource(content: () => string): { rules: JsonRuleRepository; source: JsonSourceService } {
  const rules = new JsonRuleRepository(join(process.cwd(), '.absent-regression-json-rules'))
  return { rules, source: new JsonSourceService(rules, new JsonArticleParser(), async () => content()) }
}

/** 只注入不应调用的旁路服务；RSS 仍经过正式解析、评分、订阅和 SQLite。 */
export function discoveryFlow(options: {
  rss: RssDiscoveryService
  subscription: RssSubscriptionService
  current: () => AccountRecord
  rssHubResolver?: RssHubResolver
  rssHubSubscription?: RssHubSubscriptionService
}): { service: SourceDiscoveryService; unusedProbe: ReturnType<typeof vi.fn> } {
  const unusedProbe = vi.fn(async () => { throw new Error('Atom 成功后不应进入其他发现阶段') })
  const service = new SourceDiscoveryService(
    { rssDiscovery: options.rss,
      rssSubscription: options.subscription,
    rssHubResolver: options.rssHubResolver ?? { knownInstanceUrls: () => [], isEnabled: () => true, probe: unusedProbe } as unknown as RssHubResolver,
      rssHubSubscription: options.rssHubSubscription ?? { subscribe: unusedProbe } as unknown as RssHubSubscriptionService,
      jsonSource: { probe: unusedProbe } as unknown as JsonSourceService,
      jsonSubscription: { add: unusedProbe } as unknown as JsonSubscriptionService,
      websiteSource: { inspect: unusedProbe, inspectDynamic: unusedProbe, hasRule: () => false } as unknown as WebsiteSourceService,
      websiteSubscription: { add: unusedProbe } as unknown as WebsiteSubscriptionService,
      accountCoordinator: { current: options.current, subscribeRss: unusedProbe } }
  )
  return { service, unusedProbe }
}
