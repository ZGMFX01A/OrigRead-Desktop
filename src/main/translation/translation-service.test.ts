import { createServer } from 'node:http'
import { describe,expect,it } from 'vitest'
import { MicrosoftTranslationProvider,DeepLTranslationProvider,GoogleCloudTranslationProvider,DlxTranslationProvider,resolveDeepLEndpoint } from './cloud-translation-providers'
import { parseAiTranslationResponse } from './translation-service'

describe('translation providers Android parity',()=>{
  it('maps DeepL free keys to free official endpoint',()=>{expect(resolveDeepLEndpoint('https://api.deepl.com/v2/translate','abc:fx')).toContain('api-free.deepl.com')})
  it('accepts strict AI translation id mapping',()=>{expect(parseAiTranslationResponse('{"translations":[{"id":1,"text":"B"},{"id":0,"text":"A"}]}',2)).toEqual(['A','B'])})
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
})

