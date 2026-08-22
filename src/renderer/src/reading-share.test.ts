import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReadingShareMarkdown, type ReadingSharePreference } from './reading-share'

const preference: ReadingSharePreference = {
  configured: true,
  includeTitle: true,
  includeBody: true,
  includeTranslation: true,
  includeSummary: true
}

describe('desktop reading share', () => {
  beforeEach(() => {
    const dom = parseHTML('<!doctype html><html><body></body></html>')
    vi.stubGlobal('document', dom.document)
    vi.stubGlobal('Node', dom.Node)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the title, quoted summary, markdown body, image URL and source URL', () => {
    const markdown = buildReadingShareMarkdown({
      title: '文章标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<p>正文 <strong>重点</strong></p><img src="https://example.com/cover.jpg">',
      translatedHtml: null,
      summaryMarkdown: '## 主要内容\n\n- **重点一**',
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference: { ...preference, includeTranslation: false }
    })

    expect(markdown).toContain('# 文章标题')
    expect(markdown).toContain('> 摘要\n>\n> 主要内容\n> - **重点一**')
    expect(markdown).not.toContain('## 摘要')
    expect(markdown).toContain('正文 **重点**')
    expect(markdown).toContain('![image](https://example.com/cover.jpg)')
    expect(markdown).toContain('**原文链接:** [https://example.com/article](https://example.com/article)')
  })

  it('interleaves original and translated paragraphs regardless of translation display mode', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<p>原文一</p><p>原文二</p>',
      translatedHtml: '<p>译文一</p><p>译文二</p>',
      translatedDisplayMode: 'TRANSLATED',
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference
    })

    expect(markdown.indexOf('原文一')).toBeLessThan(markdown.indexOf('译文一'))
    expect(markdown.indexOf('译文一')).toBeLessThan(markdown.indexOf('原文二'))
    expect(markdown.indexOf('原文二')).toBeLessThan(markdown.indexOf('译文二'))
  })

  it('puts an image on its own markdown line when it appears inside a paragraph', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<p>图片前文字<img src="https://example.com/chart.png">图片后文字</p>',
      translatedHtml: null,
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference: { ...preference, includeTranslation: false, includeSummary: false }
    })

    expect(markdown).toContain('图片前文字\n\n![image](https://example.com/chart.png)\n\n图片后文字')
  })

  it('also separates images wrapped by a link or figure container', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<div>段落文字<a href="https://example.com/chart"><img src="https://example.com/chart.png"></a>后续文字</div><figure><img src="https://example.com/photo.jpg"></figure>',
      translatedHtml: null,
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference: { ...preference, includeTranslation: false, includeSummary: false }
    })

    expect(markdown).toContain('段落文字\n\n[![image](https://example.com/chart.png)](https://example.com/chart)\n\n后续文字')
    expect(markdown).toContain('后续文字\n\n![image](https://example.com/photo.jpg)')
  })

  it('does not include historical summary or translation when the caller does not pass current content', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<p>正文</p>',
      translatedHtml: null,
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference
    })

    expect(markdown).toContain('# 标题')
    expect(markdown).toContain('正文')
    expect(markdown).not.toContain('摘要')
    expect(markdown).toContain('https://example.com/article')
  })

  it('preserves whitespace around inline markdown markers', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<p>This is <strong>important </strong>information and<em> useful</em>.</p>',
      translatedHtml: null,
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference: { ...preference, includeTranslation: false, includeSummary: false }
    })

    expect(markdown).toContain('This is **important** information and *useful*.')
  })

  it('does not copy non-content HTML nodes into shared markdown', () => {
    const markdown = buildReadingShareMarkdown({
      title: '标题',
      sourceUrl: 'https://example.com/article',
      bodyHtml: '<style>.article { color: red; }</style><p>正文</p><script>alert("xss")</script><noscript>备用文本</noscript><template>模板文本</template>',
      translatedHtml: null,
      summaryMarkdown: null,
      sourceUrlLabel: '原文链接',
      summaryLabel: '摘要',
      preference: { ...preference, includeTranslation: false, includeSummary: false }
    })

    expect(markdown).toContain('正文')
    expect(markdown).not.toContain('.article')
    expect(markdown).not.toContain('alert')
    expect(markdown).not.toContain('备用文本')
    expect(markdown).not.toContain('模板文本')
  })
})
