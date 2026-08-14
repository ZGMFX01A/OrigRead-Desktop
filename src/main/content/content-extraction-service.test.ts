import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebsiteRule } from '../../shared/website'
import { ContentExtractionService } from './content-extraction-service'
import {
  ReadabilityContentExtractor,
  StructuredMetadataContentExtractor,
  WeChatArticleContentExtractor,
  WebsiteRuleContentExtractor
} from './content-extractors'

describe('ContentExtractionService Android parity', () => {
  it('explicit website content selector wins over readability', () => {
    const service = createService([rule('sample', 'example.com', '.story-body')])
    const html = fixture('content/sample-article.html')
    const result = service.extract(html, 'https://example.com/news/1', '规则正文测试')
    expect(result?.source).toBe('WEBSITE_RULE')
    expect(result?.html).toContain('规则指定正文')
    expect(result?.html).toContain('https://example.com/images/photo.jpg')
    expect(result?.html).toContain('https://example.com/more')
    expect(result?.html).not.toContain('window.bad')
  })

  it('website selector falls back when matched content is too short', () => {
    const result = createService([rule('sample', 'example.com', 'nav')])
      .extract(fixture('content/sample-article.html'), 'https://example.com/news/1', '规则正文测试')
    expect(result).not.toBeNull()
    expect(result?.source).not.toBe('WEBSITE_RULE')
  })

  it('extracts JSON-LD articleBody and author', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"NewsArticle","headline":"测试标题","articleBody":"第一段正文内容足够长，用于验证结构化数据正文提取、候选评分和中文短讯兼容能力。\\n\\n第二段正文内容同样足够长，并确保明确提供的 articleBody 不会被普通页面导航内容覆盖。","author":{"name":"作者"}}
      </script></head><body><main><a href="/more">详情</a></main></body></html>`
    const result = createService().extract(html, 'https://example.com/news/1', '测试标题')
    expect(result?.source).toBe('STRUCTURED_DATA')
    expect(result?.html).toContain('第一段正文内容')
    expect(result?.author).toBe('作者')
  })

  it('does not retain score from content removed by sanitizer', () => {
    const html = `<html><body><div class="unsafe-content"><nav>${'导航内容'.repeat(200)}</nav><p>太短</p></div></body></html>`
    expect(createService([rule('unsafe', 'example.com', '.unsafe-content')]).extract(html, 'https://example.com/news/1')).toBeNull()
  })

  it('short meta description does not become article content', () => {
    expect(createService().extract("<html><head><meta property='og:description' content='太短'></head><body>菜单</body></html>", 'https://example.com')).toBeNull()
  })

  it('wechat article prefers js_content and restores lazy images', () => {
    const html = `<html><head><meta property="og:title" content="微信文章标题"></head><body>
      <h1 id="activity-name">微信文章标题</h1><span id="js_name">测试公众号</span>
      <div id="js_content"><p>${'这是一段微信公众号正文内容。'.repeat(12)}</p><img data-src="https://mmbiz.qpic.cn/test/image.jpg"></div>
      <div>${'页面外围噪声'.repeat(100)}</div></body></html>`
    const result = createService().extract(html, 'https://mp.weixin.qq.com/s/example', '微信文章标题')
    expect(result?.source).toBe('PLATFORM_SPECIFIC')
    expect(result?.author).toBe('测试公众号')
    expect(result?.html).toContain('微信公众号正文内容')
    expect(result?.html).toContain('src="https://mmbiz.qpic.cn/test/image.jpg"')
    expect(result?.html).not.toContain('页面外围噪声')
  })
})

describe('fixed Android article samples', () => {
  const samples: Array<{
    name: string
    file: string
    url: string
    title: string
    author: string
    published: string
    image?: string
    link?: string
    minText?: number
    rules?: WebsiteRule[]
  }> = [
    {
      name: 'IT-style explicit rule', file: 'article-samples/it-home.html', url: 'https://www.ithome.test/0/1/1.htm',
      title: '国产芯片平台发布新一代桌面处理器', author: '测试编辑', published: '2026-08-05T08:30:00+08:00',
      image: 'https://www.ithome.test/images/chip-platform.jpg', link: 'https://www.ithome.test/review/chip-platform',
      rules: [rule('ithome-sample', 'www.ithome.test', '.post_content')]
    },
    {
      name: 'Finance JSON-LD', file: 'article-samples/caijing.html', url: 'https://finance.test/news/2026/08/04/1.html',
      title: '制造业景气度连续改善', author: '财经观察员', published: '2026-08-04T18:00:00+08:00', minText: 180
    },
    {
      name: 'Engineering blog readability', file: 'article-samples/github-blog.html', url: 'https://engineering.test/blog/search-reliability',
      title: 'Improving repository search reliability', author: 'Engineering Team', published: '2026-08-03T12:00:00Z',
      image: 'https://engineering.test/assets/search-pipeline.png', link: 'https://engineering.test/engineering/search-details'
    },
    {
      name: 'WordPress explicit rule', file: 'article-samples/wordpress.html', url: 'https://wordpress.test/news/2026/08/release-notes/',
      title: 'Community release notes for August', author: 'Release Team', published: '2026-08-02T09:15:00Z',
      image: 'https://wordpress.test/news/2026/08/uploads/release-dashboard.jpg', link: 'https://wordpress.test/docs/upgrade-guide',
      rules: [rule('wordpress-sample', 'wordpress.test', '.entry-content')]
    },
    {
      name: 'Publishing platform readability', file: 'article-samples/medium.html', url: 'https://publishing.test/offline-readers',
      title: 'Designing resilient offline readers', author: 'Sample Writer', published: '2026-08-01T20:45:00Z',
      image: 'https://publishing.test/media/offline-reader.png', link: 'https://publishing.test/notes/offline-reader'
    }
  ]

  for (const sample of samples) {
    it(sample.name, () => {
      const result = createService(sample.rules).extract(fixture(sample.file), sample.url, sample.title)
      expect(result).not.toBeNull()
      expect(stripHtml(result!.html).length).toBeGreaterThanOrEqual(sample.minText ?? 120)
      expect(result!.score).toBeGreaterThanOrEqual(20)
      expect(result!.title).toContain(sample.title)
      expect(result!.author).toBe(sample.author)
      expect(result!.publishedTime).toBe(sample.published)
      if (sample.image) expect(result!.html).toContain(sample.image)
      if (sample.link) expect(result!.html).toContain(sample.link)
    })
  }
})

function createService(rules: WebsiteRule[] = []): ContentExtractionService {
  return new ContentExtractionService([
    new WeChatArticleContentExtractor(),
    new WebsiteRuleContentExtractor(() => rules),
    new StructuredMetadataContentExtractor(),
    new ReadabilityContentExtractor()
  ])
}

function rule(id: string, host: string, contentSelector: string): WebsiteRule {
  return {
    id, name: id, version: 1, enabled: true, hosts: [host], articleSelectors: ['article'], titleSelector: 'h1',
    linkSelector: 'a', linkAttribute: 'href', dateRules: [], imageSelector: null, imageAttributes: ['src'],
    contentSelectors: [contentSelector], includeUrlRegex: null, automaticUrlPattern: null, automaticDateExtraction: false,
    automaticRegionScore: 0, excludeTitleRegexes: [], maxItems: 50, cleanupMode: 'NONE', urlIdRegex: null
  }
}

function fixture(relative: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', relative), 'utf8')
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
