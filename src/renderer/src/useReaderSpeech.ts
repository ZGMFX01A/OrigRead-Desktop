import { useCallback, useEffect, useRef, useState } from 'react'

export type ReaderSpeechDomain = 'main' | 'summary'
export type ReaderSpeechStatus = 'idle' | 'speaking' | 'paused'

export interface ReaderSpeechState {
  domain: ReaderSpeechDomain | null
  status: ReaderSpeechStatus
}

export interface MainSpeechSource {
  title: string
  html: string
}

export function selectMainSpeechSource(input: {
  mode: 'article' | 'ai' | 'translation'
  articleTitle: string
  articleHtml: string
  translatedTitle?: string | null
  translatedHtml?: string | null
}): MainSpeechSource {
  if (input.mode === 'translation' && input.translatedHtml?.trim()) {
    return {
      title: input.translatedTitle?.trim() || input.articleTitle,
      html: input.translatedHtml
    }
  }
  return { title: input.articleTitle, html: input.articleHtml }
}

export function useReaderSpeech(voiceURI: string): {
  state: ReaderSpeechState
  voices: SpeechSynthesisVoice[]
  start(text: string, domain: ReaderSpeechDomain): void
  pause(): void
  resume(): void
  stop(): void
} {
  const [state, setState] = useState<ReaderSpeechState>({ domain: null, status: 'idle' })
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const generationRef = useRef(0)

  useEffect(() => {
    const synthesis = window.speechSynthesis
    const refresh = (): void => setVoices(synthesis.getVoices().slice().sort((a,b)=>a.lang.localeCompare(b.lang)||a.name.localeCompare(b.name)))
    refresh()
    synthesis.addEventListener('voiceschanged', refresh)
    return () => synthesis.removeEventListener('voiceschanged', refresh)
  }, [])

  const stop = useCallback((): void => {
    generationRef.current += 1
    window.speechSynthesis.cancel()
    setState({ domain: null, status: 'idle' })
  }, [])

  const start = useCallback((text: string, domain: ReaderSpeechDomain): void => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return
    generationRef.current += 1
    const generation = generationRef.current
    const synthesis = window.speechSynthesis
    synthesis.cancel()
    const chunks = chunkSpeechText(normalized)
    let index = 0
    const speakNext = (): void => {
      if (generation !== generationRef.current) return
      const chunk = chunks[index++]
      if (!chunk) {
        setState({ domain: null, status: 'idle' })
        return
      }
      const utterance = new SpeechSynthesisUtterance(chunk)
      const voice = synthesis.getVoices().find((item)=>item.voiceURI===voiceURI)
      if (voice) utterance.voice = voice
      utterance.onend = speakNext
      utterance.onerror = (event) => {
        if (event.error === 'canceled' || event.error === 'interrupted') return
        if (generation === generationRef.current) setState({ domain: null, status: 'idle' })
      }
      synthesis.speak(utterance)
    }
    setState({ domain, status: 'speaking' })
    speakNext()
  }, [voiceURI])

  const pause = useCallback((): void => {
    if (!window.speechSynthesis.speaking || window.speechSynthesis.paused) return
    window.speechSynthesis.pause()
    setState((current)=>current.domain?{...current,status:'paused'}:current)
  }, [])

  const resume = useCallback((): void => {
    if (!window.speechSynthesis.paused) return
    window.speechSynthesis.resume()
    setState((current)=>current.domain?{...current,status:'speaking'}:current)
  }, [])

  useEffect(() => () => {
    generationRef.current += 1
    window.speechSynthesis.cancel()
  }, [])

  return { state, voices, start, pause, resume, stop }
}

export function chunkSpeechText(text: string, maxLength = 900): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const chunks:string[]=[]
  let remaining=normalized
  while(remaining.length>maxLength){
    const windowText=remaining.slice(0,maxLength+1)
    const candidates=[windowText.lastIndexOf('。'),windowText.lastIndexOf('！'),windowText.lastIndexOf('？'),windowText.lastIndexOf('. '),windowText.lastIndexOf('! '),windowText.lastIndexOf('? '),windowText.lastIndexOf('；'),windowText.lastIndexOf('; '),windowText.lastIndexOf('，'),windowText.lastIndexOf(', ')]
    const cut=Math.max(...candidates)
    const index=cut>=Math.floor(maxLength*0.55)?cut+1:maxLength
    chunks.push(remaining.slice(0,index).trim())
    remaining=remaining.slice(index).trim()
  }
  if(remaining)chunks.push(remaining)
  return chunks
}

export function speechTextFromHtml(title: string, html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return `${title}\n${document.body.textContent ?? ''}`.replace(/\s+/g, ' ').trim()
}

export function speechTextFromMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
