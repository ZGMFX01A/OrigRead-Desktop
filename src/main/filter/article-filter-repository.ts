import { assertSafeRegexPattern, compileSafeRegex } from '../security/safe-regex'
import { writeAtomicTextFile, backupCorruptFileAndThrow } from '../storage/atomic-json-file'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import type { ArticleRecord } from '../../shared/library'
import type { ArticleFilterRule, ArticleFilterRuleBundle, ArticleFilterRuleType, ArticleFilterSnapshot, ArticleFilterStats } from '../../shared/filter-rules'

const EMPTY_STATS: ArticleFilterStats = { totalFiltered: 0, lastFilteredAt: null, lastMatchedRule: null }

export class ArticleFilterRepository {
  private cachedRawState: string | null = null
  private cachedBundle: ArticleFilterRuleBundle | null = null
  private readonly compiledPatterns = new Map<string, RegExp>()
  constructor(private readonly file: string) {}

  exportRawState(): string | null {
    this.load()
    return this.cachedRawState
  }

  restoreRawState(raw: string | null): void {
    if (raw === null) {
      if (existsSync(this.file)) unlinkSync(this.file)
    } else {
      decode(raw)
      writeAtomicTextFile(this.file, raw)
    }
    this.cachedRawState = null
    this.cachedBundle = null
    this.compiledPatterns.clear()
  }
  snapshot(): ArticleFilterSnapshot { const bundle=this.load();return{rules:structuredClone(bundle.rules),stats:{...bundle.stats}} }
  getAll():ArticleFilterRule[]{return structuredClone(this.load().rules)}
  getByFeed(feedId:string):ArticleFilterRule[]{return structuredClone(this.load().rules.filter((rule)=>rule.feedId===feedId))}
  add(keyword:string,type:ArticleFilterRuleType='KEYWORD',feedId:string|null=null,feedName:string|null=null):ArticleFilterRuleBundle{
    validatePattern(keyword,type);const bundle=this.load();const rule:ArticleFilterRule={id:randomUUID(),keyword:keyword.trim(),feedId,feedName,type,enabled:true};return this.write({...bundle,rules:normalize([...bundle.rules,rule])})
  }
  setEnabled(id:string,enabled:boolean):ArticleFilterRuleBundle{const bundle=this.load();return this.write({...bundle,rules:bundle.rules.map((rule)=>rule.id===id?{...rule,enabled}:rule)})}
  delete(id:string):ArticleFilterRuleBundle{const bundle=this.load();return this.write({...bundle,rules:bundle.rules.filter((rule)=>rule.id!==id)})}
  deleteByFeed(feedId:string):void{const bundle=this.load();this.write({...bundle,rules:bundle.rules.filter((rule)=>rule.feedId!==feedId)})}
  match(title:string,feedId:string):ArticleFilterRule|null{return structuredClone(matchArticleFilter(title,feedId,this.load().rules,this.compiledPatterns))}
  filterArticles(feedId:string,articles:ArticleRecord[]):{kept:ArticleRecord[];filtered:number}{const kept:ArticleRecord[]=[];const matches:ArticleFilterRule[]=[];for(const article of articles){const rule=this.match(article.title,feedId);if(rule)matches.push(rule);else kept.push(article)}if(matches.length)this.recordMatches(matches);return{kept,filtered:matches.length}}
  exportRules(accountFeedIds?:ReadonlySet<string>):string{const bundle=this.load();return JSON.stringify({...bundle,rules:accountFeedIds?bundle.rules.filter(rule=>rule.feedId===null||accountFeedIds.has(rule.feedId)):bundle.rules},null,2)}
  importRules(content:string):number{const incoming=decode(content);incoming.rules.forEach((rule)=>validatePattern(rule.keyword,rule.type));const current=this.load();this.write({...current,rules:normalize([...current.rules,...incoming.rules])});return incoming.rules.length}
  validateBackup(content:string):void{decode(content).rules.forEach((rule)=>validatePattern(rule.keyword,rule.type))}
  restoreBackup(content:string,feedIdMap:Map<string,string>,currentAccountFeedIds?:ReadonlySet<string>):number{const incoming=decode(content);const rules=incoming.rules.map((rule)=>rule.feedId===null?rule:feedIdMap.has(rule.feedId)?{...rule,feedId:feedIdMap.get(rule.feedId)!}:null).filter((rule):rule is ArticleFilterRule=>Boolean(rule));rules.forEach((rule)=>validatePattern(rule.keyword,rule.type));const current=this.load();const retained=currentAccountFeedIds?current.rules.filter(rule=>rule.feedId!==null&&!currentAccountFeedIds.has(rule.feedId)):[];this.write({...incoming,stats:currentAccountFeedIds?current.stats:incoming.stats,rules:normalize([...retained,...rules])});return rules.length}
  private recordMatches(matches:ArticleFilterRule[]):void{const bundle=this.load();this.write({...bundle,stats:{totalFiltered:bundle.stats.totalFiltered+matches.length,lastFilteredAt:Date.now(),lastMatchedRule:matches.at(-1)?.keyword??null}})}
  private load(): ArticleFilterRuleBundle {
    if (this.cachedBundle) return this.cachedBundle
    if (!existsSync(this.file)) return this.cachedBundle = {schemaVersion:1,rules:[],stats:{...EMPTY_STATS}}
    try {
      const raw = readFileSync(this.file, 'utf8')
      const bundle = decode(raw)
      this.refreshCache(bundle)
      this.cachedRawState = raw
      return bundle
    } catch (error) {
      return backupCorruptFileAndThrow(this.file, '过滤规则文件', error)
    }
  }
  private refreshCache(bundle: ArticleFilterRuleBundle): void {
    const compiled = new Map<string, RegExp>()
    for (const rule of bundle.rules) if (rule.type === 'REGEX') compiled.set(rule.keyword, compileSafeRegex(rule.keyword, 'i'))
    this.compiledPatterns.clear()
    for (const [pattern, regex] of compiled) this.compiledPatterns.set(pattern, regex)
    this.cachedBundle = bundle
  }
  private write(value: ArticleFilterRuleBundle): ArticleFilterRuleBundle {
    const raw = JSON.stringify(value, null, 2)
    writeAtomicTextFile(this.file, raw)
    this.refreshCache(value)
    this.cachedRawState = raw
    return structuredClone(value)
  }
}

export function matchArticleFilter(title:string,feedId:string,rules:ArticleFilterRule[],compiled = new Map<string, RegExp>()):ArticleFilterRule|null{return [...rules].filter((rule)=>rule.enabled&&(rule.feedId===null||rule.feedId===feedId)).sort((a,b)=>Number(b.feedId!==null)-Number(a.feedId!==null)).find((rule)=>rule.type==='KEYWORD'?title.toLocaleLowerCase().includes(rule.keyword.trim().toLocaleLowerCase()):(compiled.get(rule.keyword) ?? compileSafeRegex(rule.keyword,'i')).test(title))??null}
function validatePattern(keyword:string,type:ArticleFilterRuleType):void{if(!keyword.trim())throw new Error('过滤规则不能为空');if(type==='REGEX')assertSafeRegexPattern(keyword)}
function normalize(rules:ArticleFilterRule[]):ArticleFilterRule[]{const seen=new Set<string>();return rules.map((rule)=>({...rule,keyword:rule.keyword.trim(),feedId:rule.feedId??null,feedName:rule.feedName??null,type:rule.type==='REGEX'?'REGEX':'KEYWORD',enabled:rule.enabled!==false} as ArticleFilterRule)).filter((rule)=>{if(!rule.keyword)return false;const pattern=rule.type==='KEYWORD'?rule.keyword.toLocaleLowerCase():rule.keyword;const key=`${rule.feedId??''}\0${rule.type}\0${pattern}`;if(seen.has(key))return false;seen.add(key);return true})}
function decode(content:string):ArticleFilterRuleBundle{const parsed=JSON.parse(content) as Partial<ArticleFilterRuleBundle>;if((parsed.schemaVersion??1)!==1)throw new Error(`不支持的过滤规则版本：${parsed.schemaVersion}`);if(!Array.isArray(parsed.rules))throw new Error('过滤规则文件缺少 rules');for(const rule of parsed.rules){if(!rule||typeof rule.id!=='string'||typeof rule.keyword!=='string'||!['KEYWORD','REGEX'].includes(rule.type)|| (rule.enabled!==undefined&&typeof rule.enabled!=='boolean') || (rule.feedId!=null&&typeof rule.feedId!=='string') || (rule.feedName!=null&&typeof rule.feedName!=='string'))throw new Error('过滤规则格式非法');validatePattern(rule.keyword,rule.type)};if(parsed.stats!==undefined&&(!parsed.stats||typeof parsed.stats!=='object'||Array.isArray(parsed.stats)||(parsed.stats.totalFiltered!==undefined&&(!Number.isFinite(parsed.stats.totalFiltered)||parsed.stats.totalFiltered<0))||(parsed.stats.lastFilteredAt!=null&&(typeof parsed.stats.lastFilteredAt!=='number'||!Number.isFinite(parsed.stats.lastFilteredAt)))||(parsed.stats.lastMatchedRule!=null&&typeof parsed.stats.lastMatchedRule!=='string')))throw new Error('过滤统计格式非法');return{schemaVersion:1,rules:normalize(parsed.rules as ArticleFilterRule[]),stats:parsed.stats&&typeof parsed.stats==='object'?{totalFiltered:Number(parsed.stats.totalFiltered??0),lastFilteredAt:parsed.stats.lastFilteredAt??null,lastMatchedRule:parsed.stats.lastMatchedRule??null}:{...EMPTY_STATS}}}

