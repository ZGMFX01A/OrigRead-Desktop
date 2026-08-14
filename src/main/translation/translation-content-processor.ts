import * as cheerio from 'cheerio'
import type { TranslationDisplayMode } from '../../shared/translation'

export interface PreparedTranslationContent { html:string; texts:string[] }

const BLOCK_SELECTOR='p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,th'

export class TranslationContentProcessor {
  prepare(content:string):PreparedTranslationContent{
    const $=cheerio.load(`<body>${content}</body>`,null,false);const texts:string[]=[]
    $(BLOCK_SELECTOR).each((_i,node)=>{const element=$(node);if(element.parents(BLOCK_SELECTOR).length>0)return;const text=element.text().replace(/\s+/g,' ').trim();if(!text)return;element.attr('data-origread-translate-index',String(texts.length));texts.push(text)})
    return {html:$.html(),texts}
  }
  render(prepared:PreparedTranslationContent,translations:string[],mode:TranslationDisplayMode):string{
    if(translations.length!==prepared.texts.length)throw new Error('译文段落数量与正文不一致')
    const $=cheerio.load(prepared.html,null,false)
    $('[data-origread-translate-index]').each((_i,node)=>{const element=$(node);const index=Number(element.attr('data-origread-translate-index'));const text=translations[index]??'';element.removeAttr('data-origread-translate-index')
      if(mode==='BILINGUAL'){element.after(`<div class="origread-translation">${escapeHtml(text)}</div>`)}else{const media=element.find('img,picture,video,audio,source').clone();element.empty().text(text);if(media.length)element.append(media)}
    })
    return $.html()
  }
}
function escapeHtml(value:string):string{return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

