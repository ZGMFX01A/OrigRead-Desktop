import * as cheerio from 'cheerio'
import type { ArticleRecord } from '../../shared/library'
import { remoteDbId } from './account-repository'
import { feedRemoteId, googleRemoteItemId, type GoogleReaderItem, type FeverItem } from './remote-account-api'

// 沿用远端文章摘要长度和服务端秒时间戳单位。
const ARTICLE_PREVIEW_MAX_LENGTH = 280
const MILLISECONDS_PER_SECOND = 1_000

/** Google Reader 内容和状态映射携带同一账户快照，不借用当前界面账户。 */
export function googleItemToArticle(item:GoogleReaderItem, options:{accountId:number;unread:Set<string>;starred:Set<string>;updated:number|undefined;now:number}):ArticleRecord|null{
    const {accountId,unread,starred,updated,now}=options
    if(!item.id||!item.origin?.streamId)return null
    const id=googleRemoteItemId(item.id)
    const feed=feedRemoteId(item.origin.streamId)
    const html=item.summary?.content??''
    return {
      id:remoteDbId(accountId,id),accountId,feedId:remoteDbId(accountId,feed),title:decodeHtml(item.title??'')||'Untitled',
      url:item.canonical?.[0]?.href??item.alternate?.[0]?.href??item.origin.htmlUrl??null,author:item.author??null,
      publishedAt:normalizePublished(item.published,now),description:textFromHtml(html).slice(0,ARTICLE_PREVIEW_MAX_LENGTH),contentHtml:html||null,
      fullContentHtml:null,imageUrl:firstImage(html),isUnread:unread.has(id),isStarred:starred.has(id),
      createdAt:now,updatedAt:updated?updated*MILLISECONDS_PER_SECOND:Number(item.crawlTimeMsec)||now
    }
  }

/** Fever 文章使用服务端身份与任务账户组合，保留原状态解释。 */
export function feverItemToArticle(item:FeverItem,accountId:number,now:number):ArticleRecord|null{
    if(!item.id||item.feed_id===undefined)return null
    const html=item.html??''
    return {
      id:remoteDbId(accountId,item.id),accountId,feedId:remoteDbId(accountId,item.feed_id),title:decodeHtml(item.title??'')||'Untitled',
      url:item.url??null,author:item.author??null,publishedAt:normalizePublished(item.created_on_time,now),
      description:textFromHtml(html).slice(0,ARTICLE_PREVIEW_MAX_LENGTH),contentHtml:html||null,fullContentHtml:null,imageUrl:firstImage(html),
      isUnread:(item.is_read??0)<=0,isStarred:(item.is_saved??0)>0,createdAt:now,updatedAt:now
    }
  }


/** 上游秒时间转换为毫秒，未来日期仍按本轮抓取时间收敛。 */
function normalizePublished(seconds:number|undefined,now:number):number{const value=seconds?seconds*MILLISECONDS_PER_SECOND:now;return value>now?now:value}
/** HTML 摘要转换为紧凑纯文本，避免将标签用于列表展示。 */
function textFromHtml(html:string):string{return cheerio.load(html).root().text().replace(/\s+/g,' ').trim()}
/** 上游正文的首张图片用于列表封面。 */
function firstImage(html:string):string|null{return cheerio.load(html)('img[src]').first().attr('src')??null}
/** 上游目录和文章标题使用相同的 HTML 实体解码。 */
export function decodeHtml(value:string):string{return cheerio.load(`<body>${value}</body>`)('body').text().trim()}
