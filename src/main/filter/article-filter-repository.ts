import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ArticleRecord } from '../../shared/library'
import type { ArticleFilterRule, ArticleFilterRuleBundle, ArticleFilterRuleType, ArticleFilterSnapshot, ArticleFilterStats } from '../../shared/filter-rules'

const EMPTY_STATS: ArticleFilterStats = { totalFiltered: 0, lastFilteredAt: null, lastMatchedRule: null }

export class ArticleFilterRepository {
  constructor(private readonly file: string) {}
  snapshot(): ArticleFilterSnapshot { const bundle=this.load();return{rules:bundle.rules,stats:bundle.stats} }
  getAll():ArticleFilterRule[]{return this.load().rules}
  getByFeed(feedId:string):ArticleFilterRule[]{return this.load().rules.filter((rule)=>rule.feedId===feedId)}
  add(keyword:string,type:ArticleFilterRuleType='KEYWORD',feedId:string|null=null,feedName:string|null=null):ArticleFilterRuleBundle{
    validatePattern(keyword,type);const bundle=this.load();const rule:ArticleFilterRule={id:randomUUID(),keyword:keyword.trim(),feedId,feedName,type,enabled:true};return this.write({...bundle,rules:normalize([...bundle.rules,rule])})
  }
  setEnabled(id:string,enabled:boolean):ArticleFilterRuleBundle{const bundle=this.load();return this.write({...bundle,rules:bundle.rules.map((rule)=>rule.id===id?{...rule,enabled}:rule)})}
  delete(id:string):ArticleFilterRuleBundle{const bundle=this.load();return this.write({...bundle,rules:bundle.rules.filter((rule)=>rule.id!==id)})}
  deleteByFeed(feedId:string):void{const bundle=this.load();this.write({...bundle,rules:bundle.rules.filter((rule)=>rule.feedId!==feedId)})}
  match(title:string,feedId:string):ArticleFilterRule|null{return matchArticleFilter(title,feedId,this.load().rules)}
  filterArticles(feedId:string,articles:ArticleRecord[]):{kept:ArticleRecord[];filtered:number}{const kept:ArticleRecord[]=[];const matches:ArticleFilterRule[]=[];for(const article of articles){const rule=this.match(article.title,feedId);if(rule)matches.push(rule);else kept.push(article)}if(matches.length)this.recordMatches(matches);return{kept,filtered:matches.length}}
  exportRules():string{return JSON.stringify(this.load(),null,2)}
  importRules(content:string):number{const incoming=decode(content);incoming.rules.forEach((rule)=>validatePattern(rule.keyword,rule.type));const current=this.load();this.write({...current,rules:normalize([...current.rules,...incoming.rules])});return incoming.rules.length}
  validateBackup(content:string):void{decode(content).rules.forEach((rule)=>validatePattern(rule.keyword,rule.type))}
  restoreBackup(content:string,feedIdMap:Map<string,string>):number{const incoming=decode(content);const rules=incoming.rules.map((rule)=>rule.feedId===null?rule:feedIdMap.has(rule.feedId)?{...rule,feedId:feedIdMap.get(rule.feedId)!}:null).filter((rule):rule is ArticleFilterRule=>Boolean(rule));rules.forEach((rule)=>validatePattern(rule.keyword,rule.type));this.write({...incoming,rules:normalize(rules)});return rules.length}
  private recordMatches(matches:ArticleFilterRule[]):void{const bundle=this.load();this.write({...bundle,stats:{totalFiltered:bundle.stats.totalFiltered+matches.length,lastFilteredAt:Date.now(),lastMatchedRule:matches.at(-1)?.keyword??null}})}
  private load():ArticleFilterRuleBundle{try{if(!existsSync(this.file))return{schemaVersion:1,rules:[],stats:{...EMPTY_STATS}};return decode(readFileSync(this.file,'utf8'))}catch{return{schemaVersion:1,rules:[],stats:{...EMPTY_STATS}}}}
  private write(value:ArticleFilterRuleBundle):ArticleFilterRuleBundle{writeFileSync(this.file,JSON.stringify(value,null,2),'utf8');return value}
}

export function matchArticleFilter(title:string,feedId:string,rules:ArticleFilterRule[]):ArticleFilterRule|null{return [...rules].filter((rule)=>rule.enabled&&(rule.feedId===null||rule.feedId===feedId)).sort((a,b)=>Number(b.feedId!==null)-Number(a.feedId!==null)).find((rule)=>rule.type==='KEYWORD'?title.toLocaleLowerCase().includes(rule.keyword.trim().toLocaleLowerCase()):safeRegex(rule.keyword,title))??null}
function safeRegex(pattern:string,value:string):boolean{try{return new RegExp(pattern,'i').test(value)}catch{return false}}
function validatePattern(keyword:string,type:ArticleFilterRuleType):void{if(!keyword.trim())throw new Error('过滤规则不能为空');if(type==='REGEX')new RegExp(keyword)}
function normalize(rules:ArticleFilterRule[]):ArticleFilterRule[]{const seen=new Set<string>();return rules.map((rule)=>({...rule,keyword:rule.keyword.trim(),feedId:rule.feedId??null,feedName:rule.feedName??null,type:rule.type==='REGEX'?'REGEX':'KEYWORD',enabled:rule.enabled!==false} as ArticleFilterRule)).filter((rule)=>{if(!rule.keyword)return false;const pattern=rule.type==='KEYWORD'?rule.keyword.toLocaleLowerCase():rule.keyword;const key=`${rule.feedId??''}\0${rule.type}\0${pattern}`;if(seen.has(key))return false;seen.add(key);return true})}
function decode(content:string):ArticleFilterRuleBundle{const parsed=JSON.parse(content) as Partial<ArticleFilterRuleBundle>;if((parsed.schemaVersion??1)!==1)throw new Error(`不支持的过滤规则版本：${parsed.schemaVersion}`);if(!Array.isArray(parsed.rules))throw new Error('过滤规则文件缺少 rules');return{schemaVersion:1,rules:normalize(parsed.rules as ArticleFilterRule[]),stats:parsed.stats&&typeof parsed.stats==='object'?{totalFiltered:Number(parsed.stats.totalFiltered??0),lastFilteredAt:parsed.stats.lastFilteredAt??null,lastMatchedRule:parsed.stats.lastMatchedRule??null}:{...EMPTY_STATS}}}

