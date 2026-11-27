import * as cheerio from 'cheerio'
import type { TranslationDisplayMode } from '../../shared/translation'

export interface PreparedTranslationContent { html: string; texts: string[] }
const INDEX = 'data-origread-translate-index'
const BLOCKS = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,th'
const STRUCTURAL = `${BLOCKS},div,section,article,main,header,footer,aside,ul,ol,dl,dt,dd,table,thead,tbody,tfoot,tr`
const EXCLUDED = 'script,style,pre,code,noscript'

export class TranslationContentProcessor {
  prepare(content: string): PreparedTranslationContent {
    const $ = cheerio.load(content, null, false)
    const texts: string[] = []
    const mark = (element: ReturnType<typeof $>): void => {
      const text = element.clone().find(EXCLUDED).remove().end().text().replace(/\s+/g, ' ').trim()
      if (!text) return
      element.attr(INDEX, String(texts.length))
      texts.push(text)
    }
    const visit = (container: ReturnType<typeof $>): void => {
      let inline: ReturnType<typeof container.contents> = $([])
      const flush = (): void => {
        if (inline.text().trim()) {
          inline.wrapAll('<span></span>')
          mark(inline.first().parent())
        }
        inline = $([])
      }
      for (const node of container.contents().toArray()) {
        const element = $(node)
        if (element.is(EXCLUDED)) { flush(); continue }
        if (element.is(STRUCTURAL) || element.find(STRUCTURAL).length) {
          flush()
          if (element.is(BLOCKS) && !element.find(EXCLUDED).length) mark(element)
          else if (!element.find(STRUCTURAL).length && !element.find(EXCLUDED).length && !element.is('ul,ol,table,thead,tbody,tfoot,tr')) mark(element)
          else visit(element)
        } else inline = inline.add(node)
      }
      flush()
    }
    visit($.root())
    return { html: $.html(), texts }
  }

  render(prepared: PreparedTranslationContent, translations: string[], mode: TranslationDisplayMode): string {
    if (translations.length !== prepared.texts.length) throw new Error('译文段落数量与正文不一致')
    const $ = cheerio.load(prepared.html, null, false)
    $(`[${INDEX}]`).each((_i, node) => {
      const element = $(node)
      const text = translations[Number(element.attr(INDEX))] ?? ''
      element.removeAttr(INDEX)
      if (mode === 'BILINGUAL') {
        // Keep translations within semantic owners, including li/td and inline prose runs.
        element.append($('<span class="origread-translation" style="display:block"></span>').text(text))
      } else {
        const media = element.find('img,picture,video,audio,source').clone()
        element.empty().text(text)
        if (media.length) element.append(media)
      }
    })
    return $.html()
  }
}
