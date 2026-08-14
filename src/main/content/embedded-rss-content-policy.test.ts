import { describe, expect, it } from 'vitest'
import { shouldUseEmbeddedRssAsFullContent } from './embedded-rss-content-policy'

const weChatArticle = 'https://mp.weixin.qq.com/s?__biz=MzIyMDE5OTYyMw==&mid=2651051632&idx=1&sn=abc'

describe('EmbeddedRssContentPolicy Android parity', () => {
  it('uses substantial WeChat RSS content as full content', () => {
    const html = Array.from({ length: 8 }, (_, index) =>
      `<p>第${index + 1}段：这是由 RSS content:encoded 直接提供的公众号正文，包含足够完整的上下文、论述和文章内容，不需要再次访问微信原网页。</p>`
    ).join('')
    expect(shouldUseEmbeddedRssAsFullContent(weChatArticle, html)).toBe(true)
  })

  it('rejects short WeChat descriptions, normal sites and captcha URLs', () => {
    expect(shouldUseEmbeddedRssAsFullContent(weChatArticle, '<p>泡沫中不能说的秘密</p>')).toBe(false)
    expect(shouldUseEmbeddedRssAsFullContent('https://example.com/article/1', `<p>${'普通网站正文'.repeat(200)}</p>`)).toBe(false)
    expect(shouldUseEmbeddedRssAsFullContent('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=token', `<p>${'安全验证提示'.repeat(100)}</p>`)).toBe(false)
  })
})
