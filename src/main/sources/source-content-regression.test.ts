import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OpmlService } from '../import-export/opml-service'
import { JsonSubscriptionService } from './json/json-subscription-service'
import { WebsiteSourceService } from './website/website-source-service'
import { WebsiteRuleRepository } from './website/website-rule-repository'
import { WebsiteParsePreferenceRepository } from './website/website-parse-preference-repository'
import { withLibrary, jsonSource } from './subscription-regression-support'

describe('Android 审查问题在桌面 OPML、JSON、网站链路的回归', () => {
  it('保留任意深度分组、默认组身份，并按 XML 首次出现顺序去重', async () => withLibrary(async (library) => {
    const service = new OpmlService(library)
    const input = `<opml><body><outline text="Tech"><outline text="Java">
      <outline text="First" xmlUrl="https://example.com/feed?utm_source=a" />
      </outline></outline><outline text="Default" isDefault="true">
      <outline text="Duplicate" xmlUrl="https://example.com/feed?utm_source=b" />
      <outline text="Default feed" xmlUrl="https://example.com/feed/" />
      </outline></body></opml>`
    expect(service.importFromString(input)).toEqual({ groupsAdded: 2, feedsAdded: 2, feedsSkipped: 1 })
    const first = library.listFeeds().find((feed) => feed.name === 'First')!
    expect(library.listGroups().find((group) => group.id === first.groupId)?.name).toBe('Tech / Java')
    expect(library.listFeeds().find((feed) => feed.name === 'Default feed')?.groupId).toBe(library.getCurrentDefaultGroup().id)
    expect(service.importFromString(input)).toEqual({ groupsAdded: 0, feedsAdded: 0, feedsSkipped: 3 })
  }))

  it('标准 OPML 导出只声明 RSS，避免 JSON 和网站被重新导入成 RSS', async () => withLibrary(async (library) => {
    const base = library.listFeeds()[0]!
    library.upsertFeed({ ...base, id: 'json', name: 'JSON', url: 'https://example.com/api', sourceType: 'json' })
    library.upsertFeed({ ...base, id: 'web', name: 'Website', url: 'https://example.com/web', sourceType: 'website' })
    const exported = new OpmlService(library).exportToString(true)
    expect(exported).not.toContain('xmlUrl="https://example.com/api"')
    expect(exported).not.toContain('xmlUrl="https://example.com/web"')
    expect(exported).toContain('type="rss"')
  }))

  it('订阅保存成功探测的 JSON 规则，刷新不会被同域其他规则替换', async () => withLibrary(async (library) => {
    const { source, rules } = jsonSource(() => '[{"id":1,"date_gmt":"2026-08-03T08:00:00","link":"https://example.com/1","title":{"rendered":"One"}}]')
    const probe = (await source.probe('https://example.com/wp-json/wp/v2/posts'))!
    const subscription = new JsonSubscriptionService(library, source)
    const added = await subscription.add(probe)
    rules.findRuleForEndpoint = () => ({ ...probe.rule, id: 'unrelated', itemsPath: '$.unrelated[*]' })
    expect((await subscription.refresh(added.feedId)).fetchedArticles).toBe(1)
    expect(library.listArticlesByFeed(added.feedId)[0]?.title).toBe('One')
  }))

  it('WordPress date_gmt 始终按照 UTC 解析', async () => {
    const { source } = jsonSource(() => '[{"id":1,"date_gmt":"2026-08-03T08:00:00","link":"https://example.com/1","title":{"rendered":"One"}}]')
    const probe = (await source.probe('https://example.com/wp-json/wp/v2/posts'))!
    expect(probe.articles[0]?.publishedAt).toBe(Date.parse('2026-08-03T08:00:00Z'))
  })

  it('失效的手动网站规则不阻断现有的自动 DOM 识别', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-rule-regression-'))
    try {
      const rules = new WebsiteRuleRepository(join(directory, 'rules.json'))
      rules.importRules(JSON.stringify({ rules: [{ id: 'broken', name: 'Broken selector', hosts: ['news.example.com'], articleSelectors: ['.removed article'], titleSelector: 'a' }] }))
      const html = `<html><body><main><section class="news-list">${Array.from({ length: 5 }, (_, i) =>
        `<article><h2><a href="/posts/2026/08/03/regression-${100 + i}.html">足够长的回归新闻文章标题 ${i}</a></h2><time datetime="2026-08-03T08:00:00Z"></time></article>`).join('')}</section></main></body></html>`
      const service = new WebsiteSourceService(rules, new WebsiteParsePreferenceRepository(join(directory, 'prefs.json')),
        { fetcher: async () => ({ status: 200, finalUrl: 'https://news.example.com/', html }) })
      const inspected = await service.inspect('https://news.example.com/', Date.parse('2026-08-04T00:00:00Z'))
      expect(inspected.candidate.rule.id).toMatch(/^auto-dom:/)
      expect(inspected.candidate.articles).toHaveLength(5)
      expect(inspected.candidates.find((candidate) => candidate.rule.id === 'broken')?.diagnostics.state).toBe('INVALID_CONTENT')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
