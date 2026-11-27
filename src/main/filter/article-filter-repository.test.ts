import { mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { ArticleFilterRepository,matchArticleFilter } from './article-filter-repository'
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach((dir)=>rmSync(dir,{recursive:true,force:true})))
describe('ArticleFilter Android parity',()=>{
  it('exports and replaces only global and current-account rules while retaining shared statistics',()=>{
    const dir=mkdtempSync(join(tmpdir(),'origread-filter-'));dirs.push(dir)
    const repo=new ArticleFilterRepository(join(dir,'rules.json'))
    repo.add('Global');repo.add('Current','KEYWORD','current');repo.add('Other','KEYWORD','other')
    const other=repo.getByFeed('other')
    const stats=repo.snapshot().stats
    expect(JSON.parse(repo.exportRules(new Set(['current']))).rules.map((rule:{keyword:string})=>rule.keyword)).toEqual(['Global','Current'])
    repo.restoreBackup(JSON.stringify({schemaVersion:1,rules:[{id:'new',keyword:'Incoming',feedId:'old',type:'KEYWORD',enabled:true}],stats:{totalFiltered:99}}),new Map([['old','current']]),new Set(['current']))
    expect(repo.getByFeed('other')).toEqual(other)
    expect(repo.getAll().map(rule=>rule.keyword)).toEqual(['Other','Incoming'])
    expect(repo.snapshot().stats).toEqual(stats)
  })
  it('prioritizes source rules over globals and supports keyword/regex',()=>{const rules=[{id:'g',keyword:'news',feedId:null,feedName:null,type:'KEYWORD' as const,enabled:true},{id:'s',keyword:'Breaking',feedId:'f',feedName:'Feed',type:'REGEX' as const,enabled:true}];expect(matchArticleFilter('Breaking news','f',rules)?.id).toBe('s');expect(matchArticleFilter('Other news','f',rules)?.id).toBe('g')})
  it('deduplicates rules and remaps source ids on Android backup restore',()=>{const dir=mkdtempSync(join(tmpdir(),'origread-filter-'));dirs.push(dir);const repo=new ArticleFilterRepository(join(dir,'rules.json'));repo.add('Ads','KEYWORD');repo.add('ads','KEYWORD');expect(repo.getAll()).toHaveLength(1);const incoming=JSON.stringify({schemaVersion:1,rules:[{id:'x',keyword:'Sponsored',feedId:'old',feedName:'Old',type:'KEYWORD',enabled:true}],stats:{totalFiltered:4,lastFilteredAt:null,lastMatchedRule:null}});expect(repo.restoreBackup(incoming,new Map([['old','new']]))).toBe(1);expect(repo.getByFeed('new')[0]?.keyword).toBe('Sponsored')})
})


describe('filter cache and corruption protection', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'origread-filter-')); dirs.push(dir)
    const file = join(dir, 'rules.json')
    return {dir, file, repo: new ArticleFilterRepository(file)}
  }
  it('reuses cached rules across matching and filtering even if disk changes', () => {
    const {file, repo} = fixture()
    repo.add('ads', 'REGEX')
    const raw = repo.exportRawState()
    writeFileSync(file, '{broken')
    expect(repo.exportRawState()).toBe(raw)
    unlinkSync(file)
    for (let n=0; n<100; n++) expect(repo.match('ADS', 'feed')?.keyword).toBe('ads')
    expect(repo.filterArticles('feed', [])).toEqual({kept:[], filtered:0})
    expect(repo.getAll()).toHaveLength(1)
    const rules = repo.getAll(); rules[0]!.keyword = 'changed'
    expect(repo.match('ADS', 'feed')?.keyword).toBe('ads')
  })
  it.each(['(a+)+$', '(a|aa)+$', '([a-zA-Z]+)*$'])('rejects unsafe add/import %s without changing state', pattern => {
    const {repo} = fixture()
    expect(() => repo.add(pattern, 'REGEX')).toThrow()
    expect(() => repo.importRules(JSON.stringify({schemaVersion:1,rules:[{id:'x',keyword:pattern,type:'REGEX'}]}))).toThrow()
    expect(repo.getAll()).toEqual([])
    expect(() => matchArticleFilter('aaa','f',[{id:'x',keyword:pattern,type:'REGEX',enabled:true,feedId:null,feedName:null}])).toThrow()
  })
  it.each(['{', '{"rules":[],"stats":[]}', '{"rules":[],"stats":{"lastFilteredAt":1e999}}', JSON.stringify({rules:[{id:'x',keyword:'(a+)+',type:'REGEX'}]}), JSON.stringify({rules:[{id:'x',keyword:'a',type:'invalid'}]})])('backs up invalid on-disk configuration', raw => {
    const {file,dir,repo} = fixture(); writeFileSync(file,raw)
    expect(() => repo.getAll()).toThrow('备份')
    expect(readFileSync(file,'utf8')).toBe(raw)
    const backup = readdirSync(dir).find(name=>name.includes('.corrupt-'))!
    expect(readFileSync(join(dir,backup),'utf8')).toBe(raw)
  })
  it('restores atomically and invalidates both caches', () => {
    const {repo} = fixture(); repo.add('old','REGEX'); const raw=repo.exportRawState()
    repo.delete(repo.getAll()[0]!.id); expect(repo.match('old','f')).toBeNull()
    repo.restoreRawState(raw); expect(repo.match('old','f')?.keyword).toBe('old')
    repo.restoreRawState(null); expect(repo.match('old','f')).toBeNull()
  })
})
