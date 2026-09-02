import { describe, expect, it } from 'vitest'
import { sanitizeContentHtml } from './content-html-sanitizer'

describe('sanitizeContentHtml', () => {
  it('removes executable elements and event attributes', () => {
    const html = sanitizeContentHtml(`
      <article onclick="alert(1)">
        <script>alert(1)</script>
        <iframe src="https://evil.example/"></iframe>
        <p onmouseover="evil()">Safe text</p>
        <img srcdoc="bad" src="/cover.jpg">
      </article>
    `, 'https://news.example.com/posts/1')

    expect(html).toContain('Safe text')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('onclick=')
    expect(html).not.toContain('onmouseover=')
    expect(html).not.toContain('srcdoc=')
  })

  it('removes document metadata and active namespaces from untrusted article HTML', () => {
    const html = sanitizeContentHtml(`
      <base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <link rel="stylesheet" href="https://evil.example/style.css">
      <svg><a href="javascript:alert(1)"><text>unsafe svg</text></a></svg>
      <math><mi>x</mi></math>
      <p>kept text</p>
    `, 'https://news.example.com/article')

    expect(html).toContain('kept text')
    expect(html).not.toContain('<base')
    expect(html).not.toContain('<meta')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<math')
    expect(html).not.toContain('javascript:')
  })

  it('resolves relative resources and removes non-http urls', () => {
    const html = sanitizeContentHtml(`
      <p><a href="/docs/guide">Guide</a></p>
      <p><a href="javascript:alert(1)">Unsafe</a></p>
      <img data-src="../images/cover.jpg">
      <img srcset="/a.jpg 1x, javascript:bad 2x, /b.jpg 3x">
    `, 'https://news.example.com/posts/2026/item.html')

    expect(html).toContain('href="https://news.example.com/docs/guide"')
    expect(html).toContain('src="https://news.example.com/posts/images/cover.jpg"')
    expect(html).toContain('https://news.example.com/a.jpg 1x')
    expect(html).toContain('https://news.example.com/b.jpg 3x')
    expect(html).not.toContain('javascript:')
  })
})

