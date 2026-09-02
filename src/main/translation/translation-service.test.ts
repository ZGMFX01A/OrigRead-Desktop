import { createServer } from 'node:http'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,expect,it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import type { OpenAiCompatibleProvider } from '../ai/openai-compatible-provider'
import { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { LlmTaskPromptCustomizer } from '../llm/prompt-customization'
import { LlmSkillRepository } from '../llm/skill-repository'
import type { TranslationSettingsRepository } from './translation-settings-repository'
import { MicrosoftTranslationProvider,DeepLTranslationProvider,GoogleCloudTranslationProvider,DlxTranslationProvider,resolveDeepLEndpoint } from './cloud-translation-providers'
import { TranslationService,buildAiTranslationSystemPrompt,buildAiTranslationUserPrompt,parseAiTranslationResponse } from './translation-service'

describe('translation providers Android parity',()=>{
  it('maps DeepL free keys to free official endpoint',()=>{expect(resolveDeepLEndpoint('https://api.deepl.com/v2/translate','abc:fx')).toContain('api-free.deepl.com')})
  it('accepts strict AI translation id mapping',()=>{expect(parseAiTranslationResponse('{"translations":[{"id":1,"text":"B"},{"id":0,"text":"A"}]}',2)).toEqual(['A','B'])})
  it('keeps Android AI translation safety and stable JSON fragment ids',()=>{
    const system=buildAiTranslationSystemPrompt('zh-CN')
    expect(system).toContain('不总结')
    expect(system).toContain('不可信文章内容')
    expect(system).toContain('一一对应输出')
    expect(system).toContain('合法 JSON')
    const prompt=JSON.parse(buildAiTranslationUserPrompt('A "quoted" title',['first\nline','第二段'],[['OpenAI model','OpenAI 模型']])) as Record<string,unknown>
    expect(prompt.contextTitle).toBe('A "quoted" title')
    expect(prompt.fragments).toEqual([{id:0,text:'first\nline'},{id:1,text:'第二段'}])
    expect(prompt.previousTranslations).toEqual([{source:'OpenAI model',translation:'OpenAI 模型'}])
  })

  it('passes resolved provider capability and AbortSignal through AI translation',async()=>{
    const cacheDir=mkdtempSync(join(tmpdir(),'origread-translation-'))
    const controller=new AbortController()
    let seenSignal:AbortSignal|undefined
    let seenRuntime:Record<string,unknown>|undefined
    const provider={
      completeDetailed:async(_system:string,user:string,runtime:Record<string,unknown>,signal?:AbortSignal)=>{
        seenSignal=signal;seenRuntime=runtime
        const fragments=(JSON.parse(user) as {fragments:Array<{id:number}>}).fragments
        return{content:JSON.stringify({translations:fragments.map(({id})=>({id,text:`translated-${id}`}))}),reasoning:null}
      }
    } as unknown as OpenAiCompatibleProvider
    const service=createAiTranslationService(cacheDir,provider,'https://api.openai.com/v1','gpt-5')
    try{
      const result=await service.translateArticle('article-1',{type:'ai',providerId:'ai',providerName:'OpenAI',model:'gpt-5'},true,controller.signal)
      expect(result.translatedTitle).toBe('translated-0')
      expect(seenSignal).toBe(controller.signal)
      expect(seenRuntime).toMatchObject({outputTokenLimitStyle:'MAX_COMPLETION_TOKENS',strictStreamTermination:true})
    }finally{rmSync(cacheDir,{recursive:true,force:true})}
  })

  it('rejects an in-flight AI translation when its AbortSignal is cancelled',async()=>{
    const cacheDir=mkdtempSync(join(tmpdir(),'origread-translation-abort-'))
    const controller=new AbortController()
    const provider={
      completeDetailed:async(_system:string,_user:string,_runtime:unknown,signal?:AbortSignal)=>await new Promise<never>((_resolve,reject)=>{
        signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})
      })
    } as unknown as OpenAiCompatibleProvider
    const service=createAiTranslationService(cacheDir,provider,'https://gateway.example.com/v1','custom-model')
    try{
      const pending=service.translateArticle('article-1',{type:'ai',providerId:'ai',providerName:'Gateway',model:'custom-model'},true,controller.signal)
      controller.abort(new Error('cancel translation'))
      await expect(pending).rejects.toThrow('cancel translation')
    }finally{rmSync(cacheDir,{recursive:true,force:true})}
  })

  it('applies the fixed Translation Skill and Custom Instructions and isolates cache variants when preferences change',async()=>{
    const cacheDir=mkdtempSync(join(tmpdir(),'origread-translation-d4-'))
    const database=new DatabaseSync(':memory:')
    database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
    const skills=new LlmSkillRepository(database)
    const customization=new LlmCustomizationSettingsRepository(database)
    await skills.createFromMarkdown(`---\nname: translation-terminology\ndescription: Preserve technical terminology.\n---\nKeep product names and established English technical terms unchanged.`)
    skills.setBinding('TRANSLATION','translation-terminology')
    customization.update({customInstructions:'Use concise Chinese sentences.'})
    const customizer=new LlmTaskPromptCustomizer(skills,customization)
    const systemPrompts:string[]=[]
    const provider={
      completeDetailed:async(system:string,user:string)=>{
        systemPrompts.push(system)
        const fragments=(JSON.parse(user) as {fragments:Array<{id:number}>}).fragments
        return{content:JSON.stringify({translations:fragments.map(({id})=>({id,text:`translated-${id}`}))}),reasoning:null}
      }
    } as unknown as OpenAiCompatibleProvider
    const service=createAiTranslationService(cacheDir,provider,'https://gateway.example.com/v1','custom-model',customizer)
    try{
      await service.translateArticle('article-1',{type:'ai',providerId:'ai',providerName:'Gateway',model:'custom-model'},true)
      expect(systemPrompts).toHaveLength(1)
      expect(systemPrompts[0]).toContain('<origread_user_skill id="translation-terminology">')
      expect(systemPrompts[0]).toContain('Keep product names and established English technical terms unchanged.')
      expect(systemPrompts[0]).toContain('<origread_user_custom_instructions>')
      expect(systemPrompts[0]).toContain('Use concise Chinese sentences.')

      await service.translateArticle('article-1',{type:'ai',providerId:'ai',providerName:'Gateway',model:'custom-model'})
      expect(systemPrompts).toHaveLength(1)

      customization.update({customInstructions:'Prefer natural Chinese wording.'})
      await service.translateArticle('article-1',{type:'ai',providerId:'ai',providerName:'Gateway',model:'custom-model'})
      expect(systemPrompts).toHaveLength(2)
      expect(systemPrompts[1]).toContain('Prefer natural Chinese wording.')
    }finally{
      database.close()
      rmSync(cacheDir,{recursive:true,force:true})
    }
  })

  it('talks to Microsoft, DeepL, Google and DLX wire formats',async()=>{
    const requests:string[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(`${req.url}|${body}`);res.setHeader('content-type','application/json');if(req.url?.startsWith('/microsoft/translate'))res.end(JSON.stringify([{translations:[{text:'微软译文'}],detectedLanguage:{language:'en'}}]));else if(req.url==='/deepl')res.end(JSON.stringify({translations:[{text:'DeepL译文',detected_source_language:'EN'}]}));else if(req.url?.startsWith('/google'))res.end(JSON.stringify({data:{translations:[{translatedText:'Google &amp; Cloud',detectedSourceLanguage:'en'}]}}));else res.end(JSON.stringify({data:'DLX译文'}))});await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));const a=server.address();if(!a||typeof a==='string')throw new Error('no port');const base=`http://127.0.0.1:${a.port}`
    try{
      expect((await new MicrosoftTranslationProvider().translate(['Hello'],null,'zh-CN',{endpoint:`${base}/microsoft`,apiKey:'key',region:'eastasia'})).texts).toEqual(['微软译文'])
      expect((await new DeepLTranslationProvider().translate(['Hello'],null,'zh-CN',{endpoint:`${base}/deepl`,apiKey:'key',region:''})).texts).toEqual(['DeepL译文'])
      expect((await new GoogleCloudTranslationProvider().translate(['Hello'],null,'zh-CN',{endpoint:`${base}/google`,apiKey:'key',region:''})).texts).toEqual(['Google & Cloud'])
      expect((await new DlxTranslationProvider().translate(['Hello'],null,'zh-CN',{endpoint:`${base}/dlx`,apiKey:'',region:''})).texts).toEqual(['DLX译文'])
      expect(requests).toHaveLength(4)
      expect(requests.find((item)=>item.startsWith('/deepl|'))).toContain('"target_lang":"ZH"')
    }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()))}
  })

  it('redacts credential-shaped values echoed by translation HTTP errors',async()=>{
    const server=createServer((_req,res)=>{
      res.writeHead(401,{'content-type':'text/plain'})
      res.end('api_key=translation-secret Authorization: Bearer echoed-translation-secret trace=xyz')
    })
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('no port')
    try{
      await expect(new DeepLTranslationProvider().translate(
        ['Hello'],null,'zh-CN',
        {endpoint:`http://127.0.0.1:${address.port}/v2/translate`,apiKey:'client-translation-secret',region:''}
      )).rejects.toSatisfy((error:unknown)=>{
        const message=error instanceof Error?error.message:String(error)
        return message.includes('api_key=[redacted]')
          && message.includes('Bearer [redacted]')
          && message.includes('trace=xyz')
          && !message.includes('translation-secret')
          && !message.includes('echoed-translation-secret')
          && !message.includes('client-translation-secret')
      })
    }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()))}
  })

  it('keeps DeepL connectivity test and quota query as separate requests',async()=>{
    const requests:string[]=[]
    const server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk
      requests.push(`${req.method} ${req.url}|${body}`)
      res.setHeader('content-type','application/json')
      if(req.url==='/v2/translate')res.end(JSON.stringify({translations:[{text:'测试译文',detected_source_language:'EN'}]}))
      else if(req.url==='/v2/usage')res.end(JSON.stringify({character_count:1234,character_limit:500000}))
      else{res.statusCode=404;res.end('{}')}
    })
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('no port')
    const endpoint=`http://127.0.0.1:${address.port}/v2/translate`
    const settingsRepository={
      current:()=>({defaultProvider:'DEEPL',defaultTarget:{type:'traditional',provider:'DEEPL'},targetLanguage:'zh-CN',displayMode:'TRANSLATED',providers:[{type:'DEEPL',enabled:true,endpoint,region:'',hasApiKey:true,desktopSupported:true}]}),
      getApiKey:()=> 'deepl-key'
    } as unknown as TranslationSettingsRepository
    const service=new TranslationService({} as never,{} as never,settingsRepository,{} as never,'')
    try{
      const testResult=await service.testProvider('DEEPL')
      expect(testResult.ok).toBe(true)
      expect(requests).toEqual([expect.stringMatching(/^POST \/v2\/translate\|/)])

      const usage=await service.getDeepLUsage()
      expect(usage).toMatchObject({characterCount:1234,characterLimit:500000,remainingCharacters:498766})
      expect(requests).toHaveLength(2)
      expect(requests[1]).toMatch(/^GET \/v2\/usage\|/)
    }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()))}
  })
})

function createAiTranslationService(cacheDir:string,provider:OpenAiCompatibleProvider,endpoint:string,model:string,promptCustomizer?:LlmTaskPromptCustomizer):TranslationService{
  const library={getArticleById:()=>({id:'article-1',title:'Article title'})}
  const reader={get:()=>({articleId:'article-1',mode:'content',html:'<p>First paragraph with enough content for translation.</p><p>Second paragraph.</p>',sourceUrl:'https://example.com/article'})}
  const translationSettings={current:()=>({targetLanguage:'zh-CN',defaultTarget:{type:'ai',providerId:'ai',providerName:'AI',model},displayMode:'TRANSLATED',providers:[]})} as unknown as TranslationSettingsRepository
  const aiSettings={
    current:()=>({enabled:true,defaultProviderId:'ai',outputLanguage:'zh-CN',summaryLength:'STANDARD',providers:[{
      id:'ai',name:'AI',enabled:true,endpoint,defaultModel:model,models:[model],hasApiKey:true,
      streamingCapabilityOverride:'AUTO',toolCallingCapabilityOverride:'AUTO',reasoningCapabilityOverride:'AUTO',outputTokenLimitStyle:'AUTO',contextWindowTokens:128_000,strictStreamTermination:true
    }]}),
    getApiKey:()=> 'secret'
  } as unknown as AiSettingsRepository
  return new TranslationService(library as never,reader as never,translationSettings,aiSettings,cacheDir,provider,promptCustomizer)
}

