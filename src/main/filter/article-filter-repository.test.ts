import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { ArticleFilterRepository,matchArticleFilter } from './article-filter-repository'
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach((dir)=>rmSync(dir,{recursive:true,force:true})))
describe('ArticleFilter Android parity',()=>{
  it('prioritizes source rules over globals and supports keyword/regex',()=>{const rules=[{id:'g',keyword:'news',feedId:null,feedName:null,type:'KEYWORD' as const,enabled:true},{id:'s',keyword:'Breaking',feedId:'f',feedName:'Feed',type:'REGEX' as const,enabled:true}];expect(matchArticleFilter('Breaking news','f',rules)?.id).toBe('s');expect(matchArticleFilter('Other news','f',rules)?.id).toBe('g')})
  it('deduplicates rules and remaps source ids on Android backup restore',()=>{const dir=mkdtempSync(join(tmpdir(),'origread-filter-'));dirs.push(dir);const repo=new ArticleFilterRepository(join(dir,'rules.json'));repo.add('Ads','KEYWORD');repo.add('ads','KEYWORD');expect(repo.getAll()).toHaveLength(1);const incoming=JSON.stringify({schemaVersion:1,rules:[{id:'x',keyword:'Sponsored',feedId:'old',feedName:'Old',type:'KEYWORD',enabled:true}],stats:{totalFiltered:4,lastFilteredAt:null,lastMatchedRule:null}});expect(repo.restoreBackup(incoming,new Map([['old','new']]))).toBe(1);expect(repo.getByFeed('new')[0]?.keyword).toBe('Sponsored')})
})

