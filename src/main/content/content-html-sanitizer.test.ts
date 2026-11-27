import { describe, expect, it } from 'vitest'
import { sanitizeContentHtml } from './content-html-sanitizer'

describe('sanitizeContentHtml', () => {
  it('allows only semantic tags and per-tag attributes, strips all CSS and unwraps unknown containers', () => {
    const html = sanitizeContentHtml(`<article id="clobber" name="x" style="position:fixed;background:url(https://evil.example)">
      <custom-box data-secret="x"><p strange="x" xmlns="evil">kept</p></custom-box>
      <textarea>removed textarea</textarea><select><option>removed option</option></select>
      <applet>removed applet</applet><style>removed css</style>
      <pre class="language-ts"><code class="javascript">code</code></pre>
      <p class="language-ts">plain</p><code class="bad:class">safe</code>
      <video poster="javascript:evil" controls src="/video.mp4"></video>
      <img data-src="/image.png" data-original="/other.png" style="position:fixed" arbitrary="x">
    </article>`, 'https://news.example/article')
    expect(html).toContain('<article>')
    expect(html).toContain('<p>kept</p>')
    expect(html).toContain('class="language-ts"')
    expect(html).toContain('class="javascript"')
    expect(html).toContain('src="https://news.example/image.png"')
    expect(html).toContain('src="https://news.example/video.mp4"')
    expect(html).not.toMatch(/style=|id=|name=|xmlns=|strange=|data-|arbitrary=|custom-box|removed|bad:class|poster=|<p class=/)
  })

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

