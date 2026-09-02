import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader AI Chat exposes Dedicated Web Search activity, frozen results, one-shot force, and restart history', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const articleId = await page.evaluate(async ({baseUrl,feedUrl}) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const aiProvider = ai.providers[0]
      if (!aiProvider) throw new Error('AI provider missing')
      await window.origread.updateAiProvider({id:aiProvider.id,endpoint:`${baseUrl}/v1`,defaultModel:'search-chat-model',models:['search-chat-model'],apiKey:''})
      await window.origread.updateAiSettings({enabled:true,defaultProviderId:aiProvider.id})

      const search = await window.origread.addWebSearchProvider('TAVILY')
      const searchProvider = search.providers[0]
      if (!searchProvider) throw new Error('Search provider missing')
      await window.origread.updateWebSearchProvider({id:searchProvider.id,name:'Fixture Search',endpoint:`${baseUrl}/search`,apiKey:'fixture-search-key'})
      await window.origread.updateWebSearchSettings({mode:'AUTO',defaultProviderId:searchProvider.id,maxResults:5})
      const article = (await window.origread.listArticles(100)).find((item)=>item.feedId===added.feedId)
      if (!article) throw new Error('Article missing')
      return article.id
    }, {baseUrl:fixture.baseUrl,feedUrl:`${fixture.baseUrl}/feed.xml`})

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleId}"]`).click()
    await page.keyboard.press('a')
    const composer = page.getByRole('textbox', {name:'问问这篇文章……'})
    await composer.fill('What are the latest developments?')
    await composer.press('Enter')

    const assistant = page.locator('.reader-ai-message.assistant').last()
    await expect(assistant).toContainText('Search-backed answer')
    const inlineCitation = assistant.locator('.reader-ai-inline-citation').first()
    await expect(inlineCitation).toBeVisible()
    await inlineCitation.hover()
    await expect(assistant.locator('.reader-ai-inline-citation-popover').first()).toContainText('Search result one')
    await expect(assistant.locator('.reader-ai-inline-citation-popover').first()).toContainText('First current development')
    await assistant.getByRole('button', {name:'来源'}).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail','sources')
    const sources = page.locator('.reader-ai-sources-detail')
    await expect(sources).toContainText('网页来源')
    await expect(sources).toContainText('Search result one')
    await expect(sources).toContainText('First current development with supporting detail.')
    await expect(sources).toContainText('已用于回答')
    await page.getByRole('button', {name:'返回'}).click()
    const activity = assistant.locator('.reader-ai-web-search-activity')
    await expect(activity).toContainText('已搜索网页')
    await expect(activity).toContainText('Fixture Search')
    await expect(activity).toContainText('2 条结果')
    const searchFeedback = await activity.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return { animationName: style.animationName, transitionProperty: style.transitionProperty }
    })
    expect(searchFeedback.animationName).toBe('motion-feedback-enter')
    expect(searchFeedback.transitionProperty).toContain('background-color')
    await expect.poll(()=>fixture.searchRequests.length).toBe(1)
    const sentQuery = JSON.parse(fixture.searchRequests[0]!.body).query as string
    await expect(activity).toContainText(sentQuery)

    await activity.getByRole('button', {name:'查看结果'}).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail','web-search')
    const detail = page.locator('.reader-ai-web-search-detail')
    await expect(detail).toContainText(sentQuery)
    await expect(detail).toContainText('Fixture Search')
    await expect(detail.locator('.reader-ai-web-search-result')).toHaveCount(2)
    await expect(detail).toContainText('Search result one')
    await expect(detail).toContainText('example.com')
    await expect(detail).toContainText('已使用')
    await page.getByRole('button', {name:'返回'}).click()

    await page.evaluate(async()=>{await window.origread.updateWebSearchSettings({mode:'OFF'})})
    const force = page.getByRole('button', {name:'下一条强制联网搜索'})
    await force.click()
    await expect(force).toHaveAttribute('aria-pressed','true')
    await composer.fill('Explain the implications.')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant')).toHaveCount(2)
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Search-backed answer')
    await expect.poll(()=>fixture.searchRequests.length).toBe(2)
    await expect(page.getByRole('button', {name:'下一条强制联网搜索'})).toHaveAttribute('aria-pressed','false')

    const persisted = await page.evaluate(async(id)=>{
      const conversation=(await window.origread.listLlmConversations(id))[0]
      if(!conversation)throw new Error('Conversation missing')
      return await window.origread.getLlmMessages(conversation.id)
    },articleId)
    expect(persisted.filter((message)=>message.role==='ASSISTANT')).toMatchObject([
      {webSearchStatus:'SUCCESS',webSearchProviderName:'Fixture Search',webSearchResultCount:2},
      {webSearchStatus:'SUCCESS',webSearchProviderName:'Fixture Search',webSearchResultCount:2}
    ])

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleId}"]`).click()
    await page.keyboard.press('a')
    await page.getByRole('button',{name:'对话历史'}).click()
    await page.locator('.reader-ai-history-main').first().click()
    await expect(page.locator('.reader-ai-web-search-activity')).toHaveCount(2)
    await expect(page.locator('.reader-ai-web-search-activity').first()).toContainText('2 条结果')
    await expect(page.locator('.reader-ai-inline-citation')).toHaveCount(2)
    await page.locator('.reader-ai-message.assistant').first().getByRole('button',{name:'来源'}).click()
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('Search result one')
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('First current development with supporting detail.')
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function startFixture(): Promise<{server:Server;baseUrl:string;searchRequests:Array<{body:string}>}> {
  const searchRequests:Array<{body:string}>=[]
  const server=createServer((request,response)=>{
    if(request.url==='/feed.xml'){
      response.writeHead(200,{'content-type':'application/rss+xml; charset=utf-8'})
      response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Search E2E</title><link>http://127.0.0.1/</link><description>E2E</description><item><title>Search Article</title><link>http://127.0.0.1/article</link><guid>search-e2e</guid><description><![CDATA[<p>This article needs current follow-up information.</p>]]></description></item></channel></rss>`)
      return
    }
    if(request.url==='/search'&&request.method==='POST'){
      let body='';request.on('data',(chunk)=>{body+=chunk});request.on('end',()=>{
        searchRequests.push({body})
        response.writeHead(200,{'content-type':'application/json'})
        response.end(JSON.stringify({results:[
          {title:'Search result one',url:'https://example.com/one',content:'First current development with supporting detail.'},
          {title:'Search result two',url:'https://example.org/two',content:'Second current development with additional evidence.'}
        ]}))
      })
      return
    }
    if(request.url==='/v1/chat/completions'&&request.method==='POST'){
      let body='';request.on('data',(chunk)=>{body+=chunk});request.on('end',()=>{
        if(!body.includes('Search result one')){
          response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:'Search context missing'}));return
        }
        const evidenceId=findEvidenceId(body,'First current development with supporting detail.')
        if(!evidenceId){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:'Search evidence id missing'}));return}
        response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'})
        response.write(`data: ${JSON.stringify({choices:[{delta:{content:`Search-backed answer [[${evidenceId}]]`},finish_reason:null}]})}\n\n`)
        response.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`)
        response.end('data: [DONE]\n\n')
      })
      return
    }
    response.writeHead(404);response.end('not found')
  })
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture port missing')
  return {server,baseUrl:`http://127.0.0.1:${address.port}`,searchRequests}
}

async function closeServer(server:Server):Promise<void>{await new Promise<void>((resolve)=>server.close(()=>resolve()))}

function findEvidenceId(rawRequest:string,marker:string):string|null{
  try{
    const parsed=JSON.parse(rawRequest) as {messages?:Array<{role?:string;content?:string}>}
    const system=parsed.messages?.find((message)=>message.role==='system')?.content??''
    const markerIndex=system.indexOf(marker)
    if(markerIndex<0)return null
    const matches=[...system.slice(0,markerIndex).matchAll(/\[ORIGREAD_EVIDENCE id="(E\d+)"\]/g)]
    return matches.at(-1)?.[1]??null
  }catch{return null}
}
