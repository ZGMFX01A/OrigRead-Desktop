import * as cheerio from 'cheerio'
import type { TranslationProviderType } from '../../shared/translation'

export interface TranslationRuntimeConfig { endpoint: string; apiKey: string; region: string }
export interface TranslationBatchResult { texts: string[]; detectedSourceLanguage: string | null }

export interface TranslationProvider {
  type: TranslationProviderType
  maxBatchItems: number
  maxBatchCharacters: number
  maxSegmentCharacters: number
  translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult>
}

abstract class HttpProvider implements TranslationProvider {
  abstract type: TranslationProviderType
  maxBatchItems = 50
  maxBatchCharacters = 30_000
  maxSegmentCharacters = 4_000
  abstract translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult>
  protected async json(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    const text = await response.text()
    if (!response.ok) throw new Error(translationHttpError(response.status, text))
    try { return JSON.parse(text) } catch { throw new Error('翻译服务返回了无法解析的 JSON') }
  }
}

export class MicrosoftTranslationProvider extends HttpProvider {
  type = 'MICROSOFT' as const
  maxBatchItems = 100
  maxBatchCharacters = 40_000
  async translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult> {
    requireEndpoint(config); requireApiKey(config)
    const params = new URLSearchParams({ 'api-version': '3.0', to: microsoftLanguage(targetLanguage) })
    if (sourceLanguage) params.set('from', microsoftLanguage(sourceLanguage))
    const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': config.apiKey.trim() }
    if (config.region.trim()) headers['Ocp-Apim-Subscription-Region'] = config.region.trim()
    const root = await this.json(`${config.endpoint.replace(/\/+$/,'')}/translate?${params}`, { method:'POST',headers,body:JSON.stringify(texts.map((Text) => ({ Text }))) })
    if (!Array.isArray(root)) throw new Error('Microsoft Translator 返回结构无效')
    const translated = root.map((item) => {
      const record = asRecord(item); const list = Array.isArray(record?.translations) ? record.translations : []
      return stringValue(asRecord(list[0])?.text)
    })
    ensureCount(translated, texts.length)
    return { texts: translated, detectedSourceLanguage: sourceLanguage ?? (stringValue(asRecord(asRecord(root[0])?.detectedLanguage)?.language) || null) }
  }
}

export class DeepLTranslationProvider extends HttpProvider {
  type = 'DEEPL' as const
  maxBatchItems = 50
  async translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult> {
    requireEndpoint(config); requireApiKey(config)
    const body: Record<string, unknown> = { text: texts, target_lang: deepLLanguage(targetLanguage, true) }
    if (sourceLanguage) body.source_lang = deepLLanguage(sourceLanguage, false)
    const root = asRecord(await this.json(resolveDeepLEndpoint(config.endpoint, config.apiKey), { method:'POST',headers:{'Content-Type':'application/json','Authorization':`DeepL-Auth-Key ${config.apiKey.trim()}`},body:JSON.stringify(body) }))
    const list = Array.isArray(root?.translations) ? root.translations : []
    const translated = list.map((item) => stringValue(asRecord(item)?.text))
    ensureCount(translated, texts.length)
    return { texts: translated, detectedSourceLanguage: sourceLanguage ?? (stringValue(asRecord(list[0])?.detected_source_language) || null) }
  }
  async usage(config: TranslationRuntimeConfig): Promise<{ characterCount: number; characterLimit: number }> {
    requireEndpoint(config); requireApiKey(config)
    const root = asRecord(await this.json(resolveDeepLUsageEndpoint(config.endpoint, config.apiKey), { headers:{'Authorization':`DeepL-Auth-Key ${config.apiKey.trim()}`} }))
    return { characterCount:Number(root?.character_count ?? 0), characterLimit:Number(root?.character_limit ?? 0) }
  }
}

export class GoogleCloudTranslationProvider extends HttpProvider {
  type = 'GOOGLE_CLOUD' as const
  maxBatchItems = 100
  async translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult> {
    requireEndpoint(config); requireApiKey(config)
    const url = new URL(config.endpoint); url.searchParams.set('key', config.apiKey.trim())
    const body: Record<string, unknown> = { q:texts,target:googleLanguage(targetLanguage),format:'text' }
    if (sourceLanguage) body.source = googleLanguage(sourceLanguage)
    const root = asRecord(await this.json(url.toString(), { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) }))
    const list = Array.isArray(asRecord(root?.data)?.translations) ? asRecord(root?.data)!.translations as unknown[] : []
    const translated = list.map((item) => decodeHtmlEntities(stringValue(asRecord(item)?.translatedText)))
    ensureCount(translated,texts.length)
    return { texts:translated, detectedSourceLanguage:sourceLanguage ?? (stringValue(asRecord(list[0])?.detectedSourceLanguage) || null) }
  }
}

export class DlxTranslationProvider extends HttpProvider {
  type = 'DLX' as const
  maxBatchItems = 1
  maxBatchCharacters = 5_000
  async translate(texts: string[], sourceLanguage: string | null, targetLanguage: string, config: TranslationRuntimeConfig): Promise<TranslationBatchResult> {
    requireEndpoint(config)
    const output:string[]=[]
    for (const text of texts) {
      const headers:Record<string,string>={'Content-Type':'application/json'}
      if (config.apiKey.trim()) headers.Authorization=`Bearer ${config.apiKey.trim()}`
      const root = asRecord(await this.json(resolveDlxEndpoint(config.endpoint), { method:'POST',headers,body:JSON.stringify({text,source_lang:sourceLanguage?dlxLanguage(sourceLanguage):'auto',target_lang:dlxLanguage(targetLanguage)}) }))
      const direct = stringValue(root?.data) || stringValue(root?.translation)
      if (direct) { output.push(direct); continue }
      const list=Array.isArray(root?.translations)?root.translations:[]; const first=list[0]
      const value=typeof first==='string'?first:stringValue(asRecord(first)?.text)||stringValue(asRecord(first)?.translation)
      if (!value) throw new Error('DLX 返回结果中没有译文')
      output.push(value)
    }
    return { texts:output,detectedSourceLanguage:sourceLanguage }
  }
}

export class UnsupportedMlKitProvider implements TranslationProvider {
  type='ML_KIT' as const; maxBatchItems=50;maxBatchCharacters=30_000;maxSegmentCharacters=4_000
  async translate():Promise<TranslationBatchResult>{ throw new Error('Google ML Kit 是 Android 本地翻译引擎，Desktop 不支持该运行时；请选择 Microsoft、DeepL、Google Cloud、DeepLX 或 AI 翻译') }
}

export function resolveDeepLEndpoint(endpoint:string,apiKey:string):string{
  const url=new URL(endpoint);const free=apiKey.trim().toLowerCase().endsWith(':fx')
  if(free&&url.hostname==='api.deepl.com')url.hostname='api-free.deepl.com';else if(!free&&url.hostname==='api-free.deepl.com')url.hostname='api.deepl.com'
  if(url.pathname==='/'||!url.pathname)url.pathname='/v2/translate';return url.toString()
}
export function resolveDeepLUsageEndpoint(endpoint:string,apiKey:string):string{
  const url=new URL(resolveDeepLEndpoint(endpoint,apiKey));const path=url.pathname.replace(/\/+$/,'')
  url.pathname=path.endsWith('/translate')?`${path.slice(0,-'/translate'.length)}/usage`:path.endsWith('/usage')?path:path?`${path}/v2/usage`:'/v2/usage';url.search='';return url.toString()
}
function resolveDlxEndpoint(endpoint:string):string{return endpoint.replace(/\/+$/,'')}
function requireEndpoint(config:TranslationRuntimeConfig):void{if(!config.endpoint.trim())throw new Error('翻译服务地址不能为空')}
function requireApiKey(config:TranslationRuntimeConfig):void{if(!config.apiKey.trim())throw new Error('翻译服务 API Key 不能为空')}
function microsoftLanguage(tag:string):string{const k=tag.toLowerCase();return ['zh-cn','zh-sg','zh-hans'].includes(k)?'zh-Hans':['zh-tw','zh-hk','zh-hant'].includes(k)?'zh-Hant':tag}
function googleLanguage(tag:string):string{return tag.toLowerCase()==='zh-hans'?'zh-CN':tag.toLowerCase()==='zh-hant'?'zh-TW':tag}
function deepLLanguage(tag:string,target:boolean):string{const n=tag.replace('_','-').toUpperCase();if(['ZH-CN','ZH-SG','ZH-HANS'].includes(n))return target?'ZH-HANS':'ZH';if(['ZH-TW','ZH-HK','ZH-HANT'].includes(n))return target?'ZH-HANT':'ZH';if(target&&n==='EN')return'EN-US';return n.split('-')[0]!}
function dlxLanguage(tag:string):string{const k=tag.toLowerCase();return ['zh-cn','zh-sg','zh-hans','zh-tw','zh-hk','zh-hant'].includes(k)?'ZH':tag.split('-')[0]!.toUpperCase()}
function decodeHtmlEntities(value:string):string{return cheerio.load(`<body>${value}</body>`)('body').text()}
function asRecord(value:unknown):Record<string,unknown>|null{return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null}
function stringValue(value:unknown):string{return typeof value==='string'?value:''}
function ensureCount(values:string[],expected:number):void{if(values.length!==expected||values.some((item)=>!item))throw new Error('翻译服务返回的段落数量或内容无效')}
function translationHttpError(status:number,body:string):string{const detail=body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,240);const suffix=detail?`：${detail}`:'';if([401,403].includes(status))return`翻译服务鉴权失败（HTTP ${status}）${suffix}`;if([429,456].includes(status))return`翻译服务请求过于频繁或额度已用尽（HTTP ${status}）${suffix}`;if([404,405].includes(status))return`翻译服务地址或接口路径不正确（HTTP ${status}）${suffix}`;if([400,422].includes(status))return`翻译服务拒绝了当前请求参数（HTTP ${status}）${suffix}`;return`翻译服务请求失败（HTTP ${status}）${suffix}`}

