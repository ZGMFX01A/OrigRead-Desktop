import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonArticleParser } from '../sources/json/json-article-parser'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AiSettingsRepository } from './ai-settings-repository'
import { AiRuleGenerationService } from './ai-rule-generation-service'
import type { OpenAiCompatibleProvider } from './openai-compatible-provider'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()})

describe('AiRuleGenerationService',()=>{
  it('locally validates a website rule and only saves the confirmed preview',async()=>{
    const fixture=await startFixture();const env=createEnvironment([websiteRuleJson()]);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const progress:string[]=[]
    const preview=await service.generateWebsiteRule(`${fixture.baseUrl}/news`,{model:'selected-model'},(stage)=>progress.push(stage))
    expect(preview.kind).toBe('WEBSITE');expect(preview.articleCount).toBe(10);expect(preview.score).toBeGreaterThan(0);expect(preview.model).toBe('selected-model');expect(env.models()).toEqual(['selected-model']);expect(progress.slice(0,5)).toEqual(['PREPARING','FETCHING_SOURCE','ANALYZING_SOURCE','GENERATING_CANDIDATE','VALIDATING_CANDIDATE']);expect(progress).toContain('FETCHING_CONTENT');expect(preview.contentStatus).toBe('FAILED')
    expect(env.website.listRules().filter((rule)=>rule.id.startsWith('ai-website-'))).toHaveLength(0)
    service.save(preview.previewId)
    expect(env.website.listRules().some((rule)=>rule.id.startsWith('ai-website-')&&rule.name==='Mock Website')).toBe(true)
  })

  it('does not retain an unverified website content selector when content validation fails',async()=>{
    const fixture=await startFixture();const env=createEnvironment([websiteRuleWithUnverifiedContentJson(),'{invalid']);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateWebsiteRule(`${fixture.baseUrl}/news`)
    const rule=JSON.parse(preview.ruleJson).rules[0]
    expect(preview.contentStatus).toBe('FAILED')
    expect(rule.contentSelectors).toEqual([])
  })

  it('preserves the automatic date extraction decision from an AI website rule',async()=>{
    const fixture=await startFixture();const env=createEnvironment([websiteRuleWithAutomaticDateJson()]);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateWebsiteRule(`${fixture.baseUrl}/news`)
    const rule=JSON.parse(preview.ruleJson).rules[0]
    expect(rule.automaticDateExtraction).toBe(true)
  })

  it('repairs a website candidate that ignores visible article dates',async()=>{
    const fixture=await startFixture();const env=createEnvironment([websiteRuleJson(),websiteRuleWithAutomaticDateJson()]);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateWebsiteRule(`${fixture.baseUrl}/news-with-date`)
    const rule=JSON.parse(preview.ruleJson).rules[0]
    expect(rule.automaticDateExtraction).toBe(true)
    expect(preview.attempts).toBe(2)
  })

  it('does not retain an unverified JSON content path when content validation fails',async()=>{
    const fixture=await startFixture();const env=createEnvironment([jsonRuleWithUnverifiedContentJson(),'{invalid']);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateJsonRule(`${fixture.baseUrl}/api`)
    const rule=JSON.parse(preview.ruleJson).rules[0]
    expect(preview.contentStatus).toBe('FAILED')
    expect(rule.contentPath).toBeNull()
  })

  it('repairs one invalid JSON candidate and saves only the locally validated result',async()=>{
    const fixture=await startFixture();const env=createEnvironment([invalidJsonRuleJson(),validJsonRuleJson(),jsonContentRuleJson()]);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateJsonRule(`${fixture.baseUrl}/api`)
    expect(env.calls()).toBe(3);expect(preview.kind).toBe('JSON');expect(preview.articleCount).toBe(10);expect(preview.sampleTitles[0]).toBe('Fixture article 1');expect(preview.attempts).toBe(2);expect(preview.contentStatus).toBe('VERIFIED');expect(preview.contentSampleCount).toBe(10);expect(preview.contentMessage).toContain('共用同一字段')
    expect(env.json.listRules()).toHaveLength(0)
    service.save(preview.previewId)
    expect(env.json.listRules().some((rule)=>rule.id.startsWith('ai-json-')&&rule.name==='Mock JSON')).toBe(true)
  })

  it('normalizes a root-array JSON rule to item paths before local validation',async()=>{
    const fixture=await startFixture();const env=createEnvironment([rootArrayJsonRuleJson(),jsonContentRuleJson()]);cleanup.push(fixture.close,env.close)
    const service=new AiRuleGenerationService(env.ai,env.website,env.json,new JsonArticleParser(),env.provider)
    const preview=await service.generateJsonRule(`${fixture.baseUrl}/array-api`)
    expect(preview.articleCount).toBe(10);expect(preview.contentStatus).toBe('VERIFIED')
    service.save(preview.previewId)
    expect(env.json.listRules()[0]?.itemsPath).toBe('$[*]')
  })
})

function createEnvironment(outputs:string[]){
  const dir=mkdtempSync(join(tmpdir(),'origread-ai-rule-'));const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  const ai=new AiSettingsRepository(database,new MemorySecretStore());ai.setEnabled(true);const defaultId=ai.current().defaultProviderId;ai.updateProvider({id:defaultId,endpoint:'http://mock-ai.local/v1',defaultModel:'mock-model'})
  const website=new WebsiteRuleRepository(join(dir,'website.json'));const json=new JsonRuleRepository(join(dir,'json.json'));let calls=0
  const nextOutput=()=>{const value=outputs[Math.min(calls,outputs.length-1)]!;calls+=1;return value}
  const models:string[]=[]
  const provider={
    async complete(_system:string,_user:string,config:{model:string}){models.push(config.model);return nextOutput()},
    async completeDetailed(){return{content:nextOutput(),reasoning:null}},
    async listModels(){return['mock-model']}
  } as unknown as OpenAiCompatibleProvider
  return{ai,website,json,provider,calls:()=>calls,models:()=>models,close:()=>{database.close();rmSync(dir,{recursive:true,force:true})}}
}

async function startFixture():Promise<{baseUrl:string;close:()=>Promise<void>}>{
  const server=createServer((request,response)=>{
    if(request.url==='/api'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({items:Array.from({length:10},(_,i)=>({title:`Fixture article ${i+1}`,url:`/article/${i+1}`,summary:`This is a sufficiently long fixture article body for validating the shared description and content field in the JSON rule. Item ${i+1}.`}))}));return}
    if(request.url==='/array-api'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(Array.from({length:10},(_,i)=>({title:`Fixture article ${i+1}`,url:`/article/${i+1}`,summary:`This is a sufficiently long fixture article body for validating the shared description and content field in the JSON rule. Item ${i+1}.`}))));return}
    if(request.url==='/news'){response.writeHead(200,{'content-type':'text/html'});response.end(`<!doctype html><html><body><ul id="news">${Array.from({length:10},(_,i)=>`<li class="item"><a href="/article/${i+1}">Fixture article ${i+1}</a></li>`).join('')}</ul></body></html>`);return}
    if(request.url==='/news-with-date'){response.writeHead(200,{'content-type':'text/html'});response.end(`<!doctype html><html><body><ul id="news">${Array.from({length:10},(_,i)=>`<li class="item"><a href="/article/${i+1}">Fixture article ${i+1}</a><span class="age">2 hours ago</span></li>`).join('')}</ul></body></html>`);return}
    response.writeHead(404);response.end('not found')
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture did not bind')
  return{baseUrl:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()))}
}

function websiteRuleJson():string{return JSON.stringify({id:'draft',name:'Mock Website',version:1,enabled:true,hosts:['invalid.local'],articleSelectors:['#news .item'],titleSelector:'a',linkSelector:'a',linkAttribute:'href',dateRules:[],imageSelector:null,imageAttributes:['src'],contentSelectors:[],includeUrlRegex:null,excludeTitleRegexes:[],maxItems:50,cleanupMode:'NONE'})}
function websiteRuleWithUnverifiedContentJson():string{return JSON.stringify({...JSON.parse(websiteRuleJson()),contentSelectors:['#content']})}
function websiteRuleWithAutomaticDateJson():string{return JSON.stringify({...JSON.parse(websiteRuleJson()),automaticDateExtraction:true})}
function invalidJsonRuleJson():string{return JSON.stringify({id:'draft',name:'Mock JSON',version:1,enabled:true,hosts:['invalid.local'],sourceKind:'API',endpoint:'.',itemsPath:'$.missing[*]',titlePath:'$.title',linkPath:'$.url',datePath:null,authorPath:null,descriptionPath:null,imagePath:null,idPath:null,dateFormat:null,maxItems:50})}
function validJsonRuleJson():string{return JSON.stringify({id:'draft',name:'Mock JSON',version:1,enabled:true,hosts:['invalid.local'],sourceKind:'API',endpoint:'.',itemsPath:'$.items[*]',titlePath:'$.title',linkPath:'$.url',datePath:null,authorPath:null,descriptionPath:'$.summary',contentPath:null,imagePath:null,idPath:null,dateFormat:null,maxItems:50})}
function jsonRuleWithUnverifiedContentJson():string{return JSON.stringify({...JSON.parse(validJsonRuleJson()),contentPath:'$.summary'})}
function rootArrayJsonRuleJson():string{return JSON.stringify({id:'draft',name:'Root Array JSON',version:1,enabled:true,hosts:['invalid.local'],sourceKind:'API',endpoint:'.',itemsPath:'$',titlePath:'$.title',linkPath:'$.url',datePath:null,authorPath:null,descriptionPath:'$.summary',contentPath:null,imagePath:null,idPath:null,dateFormat:null,maxItems:50})}
function jsonContentRuleJson():string{return JSON.stringify({contentPath:'$.summary',sampleCount:10})}
