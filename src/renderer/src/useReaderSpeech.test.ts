import { describe, expect, it } from 'vitest'
import { chunkSpeechText, selectMainSpeechSource, speechTextFromMarkdown } from './useReaderSpeech'

describe('reader speech helpers',()=>{
  it('chunks long text without dropping content',()=>{
    const text='第一句。'.repeat(400)
    const chunks=chunkSpeechText(text,120)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk)=>chunk.length<=121)).toBe(true)
    expect(chunks.join('').replace(/\s/g,'')).toBe(text.replace(/\s/g,''))
  })
  it('strips markdown control syntax for summary speech',()=>{
    expect(speechTextFromMarkdown('# 标题\n- **重点** [来源](https://example.com)')).toContain('标题 重点 来源')
  })
  it('uses only translated content when translation is the active reader mode',()=>{
    expect(selectMainSpeechSource({
      mode:'translation',
      articleTitle:'Original title',
      articleHtml:'<p>ORIGINAL ONLY</p>',
      translatedTitle:'译文标题',
      translatedHtml:'<p>只读译文</p>'
    })).toEqual({title:'译文标题',html:'<p>只读译文</p>'})
  })
})
