import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Dedicated Web Search keeps AUTO/FORCE and cancellation semantics visible in real Electron Chat', async () => {
  test.setTimeout(30_000)
  const fixture=await startFixture()
  const testApp=await launchIsolatedOrigRead()
  try{
    const page=await testApp.app.firstWindow()
    const articleId=await page.evaluate(async({baseUrl,feedUrl})=>{
      const added=await window.origread.addRssSource(feedUrl)
      const ai=await window.origread.getAiSettings();const aiProvider=ai.providers[0];if(!aiProvider)throw new Error('AI provider missing')
      await window.origread.updateAiProvider({id:aiProvider.id,endpoint:`${baseUrl}/v1`,defaultModel:'fixture-model',models:['fixture-model'],apiKey:''})
      await window.origread.updateAiSettings({enabled:true,defaultProviderId:aiProvider.id})
      const search=await window.origread.addWebSearchProvider('TAVILY');const provider=search.providers[0];if(!provider)throw new Error('Search provider missing')
      await window.origread.updateWebSearchProvider({id:provider.id,name:'Failure Search',endpoint:`${baseUrl}/search`,apiKey:'fixture-key'})
      await window.origread.updateWebSearchSettings({mode:'AUTO',defaultProviderId:provider.id,maxResults:5})
      const article=(await window.origread.listArticles(100)).find((item)=>item.feedId===added.feedId);if(!article)throw new Error('Article missing');return article.id
    },{baseUrl:fixture.baseUrl,feedUrl:`${fixture.baseUrl}/feed.xml`})

    await page.reload();await page.locator(`.article-item[data-article-id="${articleId}"]`).click();await page.keyboard.press('a')
    const composer=page.getByRole('textbox',{name:'问问这篇文章……'})

    await composer.fill('latest auto failure');await composer.press('Enter')
    let assistant=page.locator('.reader-ai-message.assistant').last()
    await expect(assistant).toContainText('Fallback answer')
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('搜索失败 · 已继续回答')
    expect(fixture.modelRequests).toBe(1)

    await page.evaluate(async()=>{await window.origread.updateWebSearchSettings({mode:'OFF'})})
    await page.getByRole('button',{name:'下一条强制联网搜索'}).click()
    await composer.fill('force failure');await composer.press('Enter')
    assistant=page.locator('.reader-ai-message.assistant').last()
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('强制搜索失败')
    await expect(assistant.locator('.reader-ai-message-status.error')).toBeVisible()
    expect(fixture.modelRequests).toBe(1)

    await page.evaluate(async()=>{await window.origread.updateWebSearchSettings({mode:'AUTO'})})
    await composer.fill('latest slow search');await composer.press('Enter')
    assistant=page.locator('.reader-ai-message.assistant').last()
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('正在搜索网页')
    await page.getByRole('button',{name:'停止生成'}).click()
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('搜索已停止')
    await expect(assistant.locator('.reader-ai-message-status')).toContainText('已停止')
    expect(fixture.modelRequests).toBe(1)

    await composer.fill('latest slow model');await composer.press('Enter')
    assistant=page.locator('.reader-ai-message.assistant').last()
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('已搜索网页')
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('1 条结果')
    await expect.poll(()=>fixture.modelRequests).toBe(2)
    await page.getByRole('button',{name:'停止生成'}).click()
    await expect(assistant.locator('.reader-ai-message-status')).toContainText('已停止')
    await expect(assistant.locator('.reader-ai-web-search-activity')).toContainText('已搜索网页')
    await assistant.getByRole('button',{name:'查看结果'}).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail','web-search')
    await expect(page.locator('.reader-ai-web-search-result')).toContainText('Persisted search result')

    const messages=await page.evaluate(async(id)=>{const c=(await window.origread.listLlmConversations(id))[0];if(!c)throw new Error('Conversation missing');return window.origread.getLlmMessages(c.id)},articleId)
    const assistants=messages.filter((message)=>message.role==='ASSISTANT'&&message.historyActive)
    expect(assistants.map((message)=>message.webSearchStatus)).toEqual(['FAILED_FALLBACK','FAILED_REQUIRED','CANCELLED','SUCCESS'])
    expect(assistants.at(-1)).toMatchObject({status:'STOPPED',webSearchStatus:'SUCCESS',webSearchResultCount:1})
  }finally{await testApp.close();await closeServer(fixture.server)}
})

async function startFixture():Promise<{server:Server;baseUrl:string;get modelRequests():number}>{
  let modelRequests=0
  const server=createServer((request,response)=>{
    if(request.url==='/feed.xml'){
      response.writeHead(200,{'content-type':'application/rss+xml'});response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Failure Search</title><link>http://127.0.0.1/</link><description>E2E</description><item><title>Failure Article</title><link>http://127.0.0.1/a</link><guid>failure-search</guid><description><![CDATA[<p>Baseline article content.</p>]]></description></item></channel></rss>`);return
    }
    if(request.url==='/search'&&request.method==='POST'){
      let body='';request.on('data',(chunk)=>{body+=chunk});request.on('end',()=>{
        const query=String((JSON.parse(body) as {query?:unknown}).query??'')
        if(query.includes('auto failure')||query.includes('force failure')){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({detail:'fixture unavailable'}));return}
        const finish=()=>{if(response.destroyed||response.writableEnded)return;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({results:[{title:'Persisted search result',url:'https://example.com/current',content:'Current supporting evidence.'}]}))}
        if(query.includes('slow search'))setTimeout(finish,2_000);else finish()
      });return
    }
    if(request.url==='/v1/chat/completions'&&request.method==='POST'){
      modelRequests+=1;let body='';request.on('data',(chunk)=>{body+=chunk});request.on('end',()=>{
        const slow=body.includes('slow model')
        const finish=()=>{if(response.destroyed||response.writableEnded)return;response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.write(`data: ${JSON.stringify({choices:[{delta:{content:body.includes('auto failure')?'Fallback answer':'Search-backed answer'},finish_reason:null}]})}\n\n`);response.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);response.end('data: [DONE]\n\n')}
        if(slow)setTimeout(finish,2_000);else finish()
      });return
    }
    response.writeHead(404);response.end('not found')
  })
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture port missing')
  return{server,baseUrl:`http://127.0.0.1:${address.port}`,get modelRequests(){return modelRequests}}
}

async function closeServer(server:Server):Promise<void>{await new Promise<void>((resolve)=>server.close(()=>resolve()))}
