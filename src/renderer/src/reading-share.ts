import type { TranslationDisplayMode } from '../../shared/translation'

export interface ReadingSharePreference {
  configured: boolean
  includeTitle: boolean
  includeBody: boolean
  includeTranslation: boolean
  includeSummary: boolean
}

export const DEFAULT_READING_SHARE_PREFERENCE: ReadingSharePreference = {
  configured: false,
  includeTitle: true,
  includeBody: false,
  includeTranslation: false,
  includeSummary: false
}

export interface ReadingShareInput {
  title: string
  sourceUrl: string | null
  bodyHtml: string
  translatedHtml: string | null
  translatedDisplayMode?: TranslationDisplayMode
  summaryMarkdown: string | null
  sourceUrlLabel: string
  summaryLabel: string
  preference: ReadingSharePreference
}

/**
 * 生成桌面端唯一的分享格式：Markdown。
 * 摘要和译文只接收阅读页当前正在显示的值，调用方不要传入历史缓存。
 */
export function buildReadingShareMarkdown(input: ReadingShareInput): string {
  const sections: string[] = []
  const title = input.title.trim()

  if (input.preference.includeTitle && title) sections.push(`# ${title}`)

  if (input.preference.includeSummary && input.summaryMarkdown?.trim()) {
    sections.push(formatSummaryAsQuote(input.summaryMarkdown, input.summaryLabel))
  }

  const hasTranslation = input.preference.includeTranslation && Boolean(input.translatedHtml?.trim())
  if (hasTranslation) {
    const translated = input.translatedDisplayMode === 'BILINGUAL'
      ? htmlToMarkdown(input.translatedHtml ?? '')
      : renderBilingualMarkdown(input.bodyHtml, input.translatedHtml ?? '')
    if (translated) sections.push(translated)
  } else if (input.preference.includeBody && input.bodyHtml.trim()) {
    sections.push(htmlToMarkdown(input.bodyHtml))
  }

  const sourceUrl = input.sourceUrl?.trim() ?? ''
  if (sourceUrl) {
    const safeUrl = sourceUrl.replaceAll(')', '%29')
    sections.push(`---\n\n**${input.sourceUrlLabel}:** [${sourceUrl}](${safeUrl})`)
  }

  return normalizeMarkdown(sections.join('\n\n'))
}

export function formatSummaryAsQuote(summary: string, label: string): string {
  const cleaned = stripSummaryHeading(summary)
  if (!cleaned) return ''

  const rawLines = cleaned.split(/\r?\n/)
  const lines = rawLines.filter((line, index) => {
    const next = rawLines[index + 1]?.trim() ?? ''
    return line.trim() || !/^[-*+]\s+/.test(next)
  }).map((line) => {
    const value = line.replace(/^\s{0,3}#{1,6}\s+/, '').trimEnd()
    return value ? `> ${value}` : '>'
  })
  return [`> ${label.trim() || 'Summary'}`, '>', ...lines].join('\n')
}

function stripSummaryHeading(summary: string): string {
  return summary
    .replace(/^\s*<!--[^>]*-->\s*/s, '')
    .replace(/^\s{0,3}#{1,6}\s*(?:已生成的\s*)?(?:AI\s*)?(?:摘要|summary)\s*\r?\n+/i, '')
    .trim()
}

function renderBilingualMarkdown(originalHtml: string, translatedHtml: string): string {
  const originalBlocks = selectTranslationBlocks(originalHtml)
  const translatedBlocks = selectTranslationBlocks(translatedHtml)
  if (originalBlocks.length === 0 || originalBlocks.length !== translatedBlocks.length) {
    return htmlToMarkdown(translatedHtml)
  }

  const sections: string[] = []
  originalBlocks.forEach((original, index) => {
    const originalMarkdown = renderNode(original)
    const translatedMarkdown = renderNode(translatedBlocks[index]!, true)
    if (originalMarkdown) sections.push(originalMarkdown)
    if (translatedMarkdown) sections.push(translatedMarkdown)
  })
  return normalizeMarkdown(sections.join('\n\n'))
}

function selectTranslationBlocks(html: string): Element[] {
  const root = parseFragment(html)
  const selector = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption, td, th'
  return Array.from(root.querySelectorAll(selector)).filter((element) => {
    if (!element.textContent?.trim()) return false
    return !element.parentElement?.closest(selector)
  })
}

function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(renderBlockChildren(parseFragment(html).childNodes))
}

function parseFragment(html: string): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = html
  root.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove())
  return root
}

function renderBlockChildren(nodes: NodeListOf<ChildNode> | NodeList): string {
  const blocks: string[] = []
  let inline: string[] = []

  const flushInline = (): void => {
    const value = inline.join('').trim()
    if (value) blocks.push(value)
    inline = []
  }

  nodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && isBlockTag((node as Element).tagName)) {
      flushInline()
      const value = renderNode(node).trim()
      if (value) blocks.push(value)
    } else if (node.nodeType === Node.ELEMENT_NODE && isMediaBlockNode(node as Element)) {
      flushInline()
      const value = renderNode(node).trim()
      if (value) blocks.push(value)
    } else {
      inline.push(renderInline(node))
    }
  })
  flushInline()
  return blocks.join('\n\n')
}

function renderNode(node: Node, removeMedia = false): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeInlineText(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (removeMedia && ['img', 'picture', 'video', 'audio', 'source'].includes(tag)) return ''

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1))
    return `${'#'.repeat(level)} ${renderInlineChildren(element, removeMedia).trim()}`
  }
  if (tag === 'p' || tag === 'figcaption' || tag === 'td' || tag === 'th') {
    return renderParagraph(element, removeMedia)
  }
  if (tag === 'br') return '\n'
  if (tag === 'hr') return '---'
  if (tag === 'img') return renderInline(node, removeMedia)
  if (tag === 'a' && isMediaBlockNode(element)) return renderInline(node, removeMedia)
  if (tag === 'blockquote') {
    const value = renderBlockChildren(element.childNodes).trim()
    return value.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')
  }
  if (tag === 'ul' || tag === 'ol') return renderList(element, tag === 'ol', removeMedia)
  if (tag === 'pre') {
    const code = element.textContent?.replace(/\r\n/g, '\n').trim() ?? ''
    const fence = '```'
    return code ? `${fence}\n${code}\n${fence}` : ''
  }
  if (tag === 'table') return renderBlockChildren(element.childNodes)
  if (isBlockTag(tag)) return renderBlockChildren(element.childNodes)
  return renderInlineChildren(element, removeMedia)
}

function renderInlineChildren(element: Element, removeMedia = false): string {
  return Array.from(element.childNodes).map((child) => renderInline(child, removeMedia)).join('')
}

function renderParagraph(element: Element, removeMedia: boolean): string {
  const sections: string[] = []
  let inline: string[] = []

  const flushInline = (): void => {
    const value = inline.join('').trim()
    if (value) sections.push(value)
    inline = []
  }

  Array.from(element.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && isMediaBlockNode(child as Element)) {
      flushInline()
      const media = renderInline(child, removeMedia).trim()
      if (media) sections.push(media)
    } else {
      inline.push(renderInline(child, removeMedia))
    }
  })
  flushInline()
  return sections.join('\n\n')
}

function isMediaBlockNode(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (['img', 'picture', 'video', 'audio', 'source'].includes(tag)) return true
  return tag === 'a' && Boolean(element.querySelector('img, picture, video, audio, source'))
}

function renderInline(node: Node, removeMedia = false): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeInlineText(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (removeMedia && ['img', 'picture', 'video', 'audio', 'source'].includes(tag)) return ''
  if (tag === 'br') return '\n'
  if (tag === 'img') {
    const source = element.getAttribute('src')?.trim()
    if (!source) return ''
    const alt = element.getAttribute('alt')?.trim() || 'image'
    return `![${escapeMarkdownText(alt)}](${source.replaceAll(')', '%29')})`
  }
  if (tag === 'a') {
    const href = element.getAttribute('href')?.trim()
    const text = renderInlineChildren(element, removeMedia).trim() || href || ''
    return href ? `[${text}](${href.replaceAll(')', '%29')})` : text
  }
  if (tag === 'strong' || tag === 'b') return wrapInline('**', renderInlineChildren(element, removeMedia))
  if (tag === 'em' || tag === 'i') return wrapInline('*', renderInlineChildren(element, removeMedia))
  if (tag === 'del' || tag === 's') return wrapInline('~~', renderInlineChildren(element, removeMedia))
  if (tag === 'code') return wrapInline('`', element.textContent ?? '')
  if (isBlockTag(tag)) return renderNode(element, removeMedia)
  return renderInlineChildren(element, removeMedia)
}

function renderList(element: Element, ordered: boolean, removeMedia: boolean): string {
  const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'li')
  return items.map((item, index) => {
    const nested = Array.from(item.children)
      .filter((child) => child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')
      .map((child) => renderNode(child, removeMedia))
      .filter(Boolean)
      .join('\n')
    const value = Array.from(item.childNodes)
      .filter((child) => !(child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes((child as Element).tagName.toLowerCase())))
      .map((child) => renderInline(child, removeMedia))
      .join('')
      .trim()
    const marker = ordered ? `${index + 1}.` : '-'
    return `${marker} ${value}${nested ? `\n${nested.split('\n').map((line) => `  ${line}`).join('\n')}` : ''}`.trimEnd()
  }).join('\n')
}

function isBlockTag(tag: string): boolean {
  return ['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'img', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'].includes(tag)
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ')
}

function wrapInline(marker: string, value: string): string {
  const match = value.match(/^(\s*)(.*?)(\s*)$/s)
  if (!match) return ''
  const [, leading, content, trailing] = match
  return content ? `${leading}${marker}${content}${marker}${trailing}` : value
}

function escapeMarkdownText(value: string): string {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\[!\[[^\]]*\]\([^\)\n]+\)\]\([^\)\n]+\)|!\[[^\]]*\]\([^\)\n]+\)/g, '\n\n$&\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
