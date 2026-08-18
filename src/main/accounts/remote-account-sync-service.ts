import * as cheerio from 'cheerio'
import type { AccountRecord } from '../../shared/account'
import type { ArticleRecord, FeedRecord, GroupRecord } from '../../shared/library'
import type { DiscoveredRssFeed } from '../../shared/rss'
import { defaultGroupId } from '../database/migrations'
import { LibraryRepository } from '../database/library-repository'
import { AccountRepository, remoteDbId, remoteId } from './account-repository'
import {
  categoryRemoteId, feedRemoteId, FeverApi, type FeverFeedsGroups, type FeverItem,
  googleRemoteItemId, GoogleReaderApi, type GoogleReaderItem, STREAM_READ, STREAM_STARRED,
  type AccountFetch
} from './remote-account-api'
import { createCertificateAwareAccountFetch } from './account-http-fetch'

export class RemoteAccountSyncService {
  constructor(
    private readonly accounts:AccountRepository,
    private readonly library:LibraryRepository,
    private readonly fetcher?:AccountFetch
  ) {}

  async validCredentials(account:AccountRecord):Promise<boolean>{
    if(account.type==='local')return true
    if(account.type==='fever')return this.feverApi(account).validCredentials()
    const api=this.googleApi(account)
    const valid=await api.validCredentials()
    if(valid){
      try{
        const info=await api.getUserInfo()
        if(info.userName?.trim())this.accounts.update({id:account.id,name:info.userName.trim()})
      }catch{/* Android 同样不因 user-info 失败否定已通过的凭据 */}
    }
    return valid
  }

  async sync(accountId:number):Promise<void>{
    const account=this.requireRemote(accountId)
    if(account.type==='fever')await this.syncFever(account)
    else await this.syncGoogleReader(account)
  }

  async subscribeRss(discovered:DiscoveredRssFeed,groupId?:string):Promise<string>{
    const account=this.accounts.current()
    if(account.type==='fever')throw new Error('Fever 账户不支持在客户端添加订阅')
    if(account.type==='local')throw new Error('Local 账户应使用本地订阅服务')
    const api=this.googleApi(account)
    const quick=await api.subscriptionQuickAdd(discovered.feedUrl)
    const remoteFeedId=quick.streamId?feedRemoteId(quick.streamId):''
    if(!remoteFeedId)throw new Error('服务器没有返回 feedId')
    const group=groupId
      ? this.library.listGroupsForAccount(account.id).find((item)=>item.id===groupId)
      : this.ensureDefaultGroup(account.id)
    await api.subscriptionEdit({
      feedId:remoteFeedId,
      destCategoryId:group?googleReaderCategoryId(account.id,group.id):undefined,
      title:discovered.title
    })
    const now=Date.now()
    const id=remoteDbId(account.id,remoteFeedId)
    this.library.upsertFeed({
      id,accountId:account.id,groupId:group?.id??this.ensureDefaultGroup(account.id).id,
      name:discovered.title,url:discovered.feedUrl,sourcePageUrl:discovered.siteUrl,
      sourceType:'rss',icon:discovered.iconUrl,isNotification:false,isFullContent:false,
      isBrowser:false,dynamicRendering:false,createdAt:now,updatedAt:now
    })
    return id
  }

  async addGroup(name:string,destFeedId?:string):Promise<GroupRecord>{
    const account=this.accounts.current()
    if(account.type==='local')throw new Error('Local 账户应使用本地分组服务')
    if(account.type==='fever')throw new Error('Fever 账户不支持在客户端新建分组')
    const normalized=name.trim()
    if(!normalized)throw new Error('分组名称不能为空')
    await this.googleApi(account).subscriptionEdit({feedId:destFeedId?remoteId(destFeedId):undefined,destCategoryId:normalized})
    const group:GroupRecord={id:remoteDbId(account.id,`user/-/label/${normalized}`),accountId:account.id,name:normalized,sortOrder:this.library.listGroupsForAccount(account.id).length,isDefault:false}
    this.library.upsertGroup(group)
    return group
  }

  async updateFeed(feedId:string,patch:{name?:string;url?:string;groupId?:string;isNotification?:boolean;isFullContent?:boolean;isBrowser?:boolean}):Promise<FeedRecord>{
    const account=this.accounts.current()
    const feed=this.library.getFeedByIdForAccount(account.id,feedId)
    if(!feed)throw new Error('来源不存在')
    if(account.type==='local')throw new Error('Local 账户应使用本地来源维护')
    if(patch.url!==undefined&&patch.url.trim()!==feed.url)throw new Error('远端账户不支持修改订阅 URL')
    if(account.type==='fever'){
      if((patch.name!==undefined&&patch.name.trim()!==feed.name)||(patch.groupId!==undefined&&patch.groupId!==feed.groupId))throw new Error('Fever 账户不支持在客户端重命名或移动订阅')
    }else{
      const api=this.googleApi(account)
      if(patch.name!==undefined&&patch.name.trim()!==feed.name)await api.subscriptionEdit({feedId:remoteId(feed.id),title:patch.name.trim()})
      if(patch.groupId!==undefined&&patch.groupId!==feed.groupId){
        const target=this.library.listGroupsForAccount(account.id).find((group)=>group.id===patch.groupId)
        if(!target)throw new Error('目标分组不存在')
        await api.subscriptionEdit({
          feedId:remoteId(feed.id),
          destCategoryId:googleReaderCategoryId(account.id,target.id),
          originCategoryId:googleReaderCategoryId(account.id,feed.groupId)
        })
      }
    }
    const next:FeedRecord={...feed,...patch,name:patch.name?.trim()||feed.name,url:feed.url,updatedAt:Date.now()}
    this.library.upsertFeed(next)
    return this.library.getFeedByIdForAccount(account.id,feedId)!
  }

  async deleteFeed(feedId:string):Promise<void>{
    const account=this.accounts.current()
    const feed=this.library.getFeedByIdForAccount(account.id,feedId)
    if(!feed)return
    if(account.type==='local')throw new Error('Local 账户应使用本地来源维护')
    if(account.type==='fever')throw new Error('Fever 账户不支持在客户端删除订阅')
    await this.googleApi(account).subscriptionEdit({action:'unsubscribe',feedId:remoteId(feed.id)})
    this.library.deleteArticlesByFeed(feed.id,true)
    this.library.deleteFeed(feed.id)
  }

  async markArticleUnread(articleId:string,unread:boolean):Promise<void>{
    const account=this.accounts.current()
    if(account.type==='local'){this.library.setArticleUnread(articleId,unread);return}
    if(account.type==='fever')await this.feverApi(account).markItem(unread?'unread':'read',remoteId(articleId))
    else await this.googleApi(account).editTag([remoteId(articleId)],unread?undefined:STREAM_READ,unread?STREAM_READ:undefined)
    this.library.setArticleUnreadForAccount(account.id,articleId,unread)
  }

  async markArticleStarred(articleId:string,starred:boolean):Promise<void>{
    const account=this.accounts.current()
    if(account.type==='local'){this.library.setArticleStarred(articleId,starred);return}
    if(account.type==='fever')await this.feverApi(account).markItem(starred?'saved':'unsaved',remoteId(articleId))
    else await this.googleApi(account).editTag([remoteId(articleId)],starred?STREAM_STARRED:undefined,starred?undefined:STREAM_STARRED)
    this.library.setArticleStarredForAccount(account.id,articleId,starred)
  }

  private async syncGoogleReader(account:AccountRecord):Promise<void>{
    const api=this.googleApi(account)
    await api.authenticate()
    const sinceSeconds=Math.floor((Date.now()-30*24*60*60_000)/1000)
    const [remoteUnread,remoteStarred,remoteRead,subscriptions]=await Promise.all([
      collectIds((c)=>api.getUnreadItemIds(c)),
      collectIds((c)=>api.getStarredItemIds(c)),
      collectIds((c)=>api.getReadItemIds(sinceSeconds,account.type==='fresh_rss',c)),
      api.getSubscriptionList()
    ])
    const unread=new Set(remoteUnread.map(googleRemoteItemId))
    const starred=new Set(remoteStarred.map(googleRemoteItemId))
    const read=new Set(remoteRead.map(googleRemoteItemId))
    const localStates=this.library.listArticleStateForAccount(account.id)
    const localIds=new Set(localStates.map((item)=>remoteId(item.id)))

    const defaultGroup=this.ensureDefaultGroup(account.id)
    const remoteGroups=new Map<string,GroupRecord>([[defaultGroup.id,defaultGroup]])
    const remoteFeeds:FeedRecord[]=[]
    const now=Date.now()
    for(const subscription of subscriptions.subscriptions??[]){
      if(!subscription.id)continue
      const category=subscription.categories?.[0]
      let group=defaultGroup
      if(category?.id){
        const categoryId=categoryRemoteId(category.id)
        group={id:remoteDbId(account.id,categoryId),accountId:account.id,name:category.label??categoryId,sortOrder:0,isDefault:false}
        remoteGroups.set(group.id,group)
      }
      const remoteFeedId=feedRemoteId(subscription.id)
      const url=subscription.url??subscription.htmlUrl
      if(!url)continue
      remoteFeeds.push({
        id:remoteDbId(account.id,remoteFeedId),accountId:account.id,groupId:group.id,
        name:decodeHtml(subscription.title??'')||'Untitled',url,sourcePageUrl:subscription.htmlUrl??null,
        sourceType:'rss',icon:subscription.iconUrl??null,isNotification:false,isFullContent:false,
        isBrowser:false,dynamicRendering:false,createdAt:now,updatedAt:now
      })
    }
    for(const group of remoteGroups.values())this.library.upsertGroup(group)
    for(const feed of remoteFeeds)this.library.upsertFeed(feed)

    const needed=new Set([...unread,...starred,...read].filter((id)=>!localIds.has(id)))
    const chunks=[...needed].reduce<string[][]>((list,id,index)=>{const bucket=Math.floor(index/100);(list[bucket]??=[]).push(id);return list},[])
    for(let offset=0;offset<chunks.length;offset+=8){
      const batches=await Promise.all(chunks.slice(offset,offset+8).map((ids)=>api.getItemsContents(ids)))
      for(const batch of batches){
        for(const item of batch.items??[]){
          const article=this.googleItemToArticle(account.id,item,unread,starred,batch.updated,now)
          if(!article)continue
          this.library.upsertArticle(article)
          this.library.setArticleUnreadForAccount(account.id,article.id,article.isUnread)
          this.library.setArticleStarredForAccount(account.id,article.id,article.isStarred)
        }
      }
    }

    // 对齐 Android GoogleReaderRssService：先在内存求差集，再用 IN (...) 分批落库。
    // read 集合只有最近一个月窗口，不能简单用 !remoteUnread 把所有旧文章强制标为已读。
    const toBeStarred=localStates
      .filter((state)=>!state.isStarred&&starred.has(remoteId(state.id)))
      .map((state)=>state.id)
    const toBeUnstarred=localStates
      .filter((state)=>state.isStarred&&!starred.has(remoteId(state.id)))
      .map((state)=>state.id)
    const toBeRead=localStates
      .filter((state)=>state.isUnread&&read.has(remoteId(state.id)))
      .map((state)=>state.id)
    const toBeUnread=localStates
      .filter((state)=>!state.isUnread&&unread.has(remoteId(state.id)))
      .map((state)=>state.id)
    this.library.setArticleStarredBatchForAccount(account.id,toBeStarred,true)
    this.library.setArticleStarredBatchForAccount(account.id,toBeUnstarred,false)
    this.library.setArticleUnreadBatchForAccount(account.id,toBeRead,false)
    this.library.setArticleUnreadBatchForAccount(account.id,toBeUnread,true)

    const groupIds=new Set(remoteGroups.keys())
    for(const group of this.library.listGroupsForAccount(account.id))if(!groupIds.has(group.id))this.library.deleteGroupForAccountIfNoStarred(account.id,group.id)
    const feedIds=new Set(remoteFeeds.map((feed)=>feed.id))
    for(const feed of this.library.listFeedsForAccount(account.id))if(!feedIds.has(feed.id))this.library.deleteFeedForAccountIfNoStarred(account.id,feed.id)
    this.accounts.updateSyncMetadata(account.id,Date.now())
  }

  private async syncFever(account:AccountRecord):Promise<void>{
    const api=this.feverApi(account)
    const [groupsBody,feedsBody,faviconsBody]=await Promise.all([api.getGroups(),api.getFeeds(),api.getFavicons()])
    const now=Date.now()
    const remoteGroups=(groupsBody.groups??[]).filter((item)=>item.id!==undefined).map((item):GroupRecord=>({
      id:remoteDbId(account.id,item.id!),accountId:account.id,name:item.title??'Untitled',sortOrder:0,isDefault:false
    }))
    const mapping=mergeFeverGroupMapping(groupsBody.feeds_groups,feedsBody.feeds_groups)
    const icons=new Map((faviconsBody.favicons??[]).map((item)=>[item.id,item.data??null]))
    let fallbackDefaultGroup:GroupRecord|null=null
    const remoteFeeds=(feedsBody.feeds??[]).filter((item)=>item.id!==undefined&&item.url).map((item):FeedRecord=>{
      const groupRemoteId=mapping.get(String(item.id))
      const groupId=groupRemoteId
        ? remoteDbId(account.id,groupRemoteId)
        : (fallbackDefaultGroup??=this.ensureDefaultGroup(account.id)).id
      return {
        id:remoteDbId(account.id,item.id!),accountId:account.id,groupId,
        name:decodeHtml(item.title??'')||'Untitled',url:item.url!,sourcePageUrl:item.site_url??null,
        sourceType:'rss',icon:item.favicon_id===undefined?null:icons.get(item.favicon_id)??null,
        isNotification:false,isFullContent:false,isBrowser:false,dynamicRendering:false,createdAt:now,updatedAt:now
      }
    })
    if(fallbackDefaultGroup&&!remoteGroups.some((group)=>group.id===fallbackDefaultGroup!.id))remoteGroups.push(fallbackDefaultGroup)
    for(const group of remoteGroups)this.library.upsertGroup(group)
    for(const feed of remoteFeeds)this.library.upsertFeed(feed)

    let lastSeen=account.lastArticleId?remoteId(account.lastArticleId):''
    while(true){
      const body=await api.getItemsSince(lastSeen)
      const items=body.items??[]
      if(items.length===0)break
      for(const item of items){
        const article=this.feverItemToArticle(account.id,item,now)
        if(article){
          this.library.upsertArticle(article)
          this.library.setArticleUnreadForAccount(account.id,article.id,article.isUnread)
          this.library.setArticleStarredForAccount(account.id,article.id,article.isStarred)
        }
      }
      const next=items.at(-1)?.id
      if(!next)break
      lastSeen=next
      if(items.length<50)break
    }

    const [unreadBody,savedBody]=await Promise.all([api.getUnreadItems(),api.getSavedItems()])
    const unread=unreadBody.unread_item_ids===undefined?null:new Set(splitIds(unreadBody.unread_item_ids))
    const saved=savedBody.saved_item_ids===undefined?null:new Set(splitIds(savedBody.saved_item_ids))
    for(const state of this.library.listArticleStateForAccount(account.id)){
      const id=remoteId(state.id)
      this.library.setArticleUnreadForAccount(account.id,state.id,unread?.has(id)??true)
      this.library.setArticleStarredForAccount(account.id,state.id,saved?.has(id)??false)
    }
    const groupIds=new Set(remoteGroups.map((group)=>group.id))
    for(const group of this.library.listGroupsForAccount(account.id))if(!groupIds.has(group.id))this.library.deleteGroupForAccountIfNoStarred(account.id,group.id)
    const feedIds=new Set(remoteFeeds.map((feed)=>feed.id))
    for(const feed of this.library.listFeedsForAccount(account.id))if(!feedIds.has(feed.id))this.library.deleteFeedForAccountIfNoStarred(account.id,feed.id)
    this.accounts.updateSyncMetadata(account.id,Date.now(),lastSeen?remoteDbId(account.id,lastSeen):null)
  }

  private googleItemToArticle(accountId:number,item:GoogleReaderItem,unread:Set<string>,starred:Set<string>,updated:number|undefined,now:number):ArticleRecord|null{
    if(!item.id||!item.origin?.streamId)return null
    const id=googleRemoteItemId(item.id)
    const feed=feedRemoteId(item.origin.streamId)
    const html=item.summary?.content??''
    return {
      id:remoteDbId(accountId,id),accountId,feedId:remoteDbId(accountId,feed),title:decodeHtml(item.title??'')||'Untitled',
      url:item.canonical?.[0]?.href??item.alternate?.[0]?.href??item.origin.htmlUrl??null,author:item.author??null,
      publishedAt:normalizePublished(item.published,now),description:textFromHtml(html).slice(0,280),contentHtml:html||null,
      fullContentHtml:null,imageUrl:firstImage(html),isUnread:unread.has(id),isStarred:starred.has(id),
      createdAt:now,updatedAt:updated?updated*1000:Number(item.crawlTimeMsec)||now
    }
  }

  private feverItemToArticle(accountId:number,item:FeverItem,now:number):ArticleRecord|null{
    if(!item.id||item.feed_id===undefined)return null
    const html=item.html??''
    return {
      id:remoteDbId(accountId,item.id),accountId,feedId:remoteDbId(accountId,item.feed_id),title:decodeHtml(item.title??'')||'Untitled',
      url:item.url??null,author:item.author??null,publishedAt:normalizePublished(item.created_on_time,now),
      description:textFromHtml(html).slice(0,280),contentHtml:html||null,fullContentHtml:null,imageUrl:firstImage(html),
      isUnread:(item.is_read??0)<=0,isStarred:(item.is_saved??0)>0,createdAt:now,updatedAt:now
    }
  }

  private ensureDefaultGroup(accountId:number):GroupRecord{
    const existing=this.library.listGroupsForAccount(accountId).find((group)=>group.isDefault)
    if(existing)return existing
    const group:GroupRecord={id:defaultGroupId(accountId),accountId,name:'Default',sortOrder:0,isDefault:true}
    this.library.upsertGroup(group);return group
  }
  private requireRemote(id:number):AccountRecord{const account=this.accounts.get(id);if(!account)throw new Error('账户不存在');if(account.type==='local')throw new Error('Local 账户不使用远端同步');return account}
  private accountFetch(account:AccountRecord):AccountFetch{return this.fetcher??createCertificateAwareAccountFetch(this.accounts.clientCertificate(account.id))}
  private googleApi(account:AccountRecord):GoogleReaderApi{return new GoogleReaderApi(required(account.serverUrl,'服务器地址'),required(account.username,'用户名'),required(this.accounts.password(account.id),'密码'),this.accountFetch(account))}
  private feverApi(account:AccountRecord):FeverApi{return new FeverApi(required(account.serverUrl,'服务器地址'),required(account.username,'用户名'),required(this.accounts.password(account.id),'密码'),this.accountFetch(account))}
}

async function collectIds(loader:(continuation?:string)=>Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>):Promise<string[]>{
  const ids:string[]=[];let continuation:string|undefined
  do{const result=await loader(continuation);for(const item of result.itemRefs??[])if(item.id)ids.push(item.id);continuation=result.continuation}while(continuation)
  return ids
}
function mergeFeverGroupMapping(...groups:Array<FeverFeedsGroups[]|undefined>):Map<string,string>{
  const map=new Map<string,string>();for(const list of groups)for(const relation of list??[]){if(relation.group_id===undefined)continue;for(const feedId of splitIds(relation.feed_ids??''))map.set(feedId,String(relation.group_id))}return map
}
function googleReaderCategoryId(accountId:number,groupId:string):string|undefined{
  if(groupId===defaultGroupId(accountId))return undefined
  return categoryRemoteId(remoteId(groupId))
}
function splitIds(value:string):string[]{return value.split(',').map((item)=>item.trim()).filter(Boolean)}
function required(value:string|null,label:string):string{if(!value)throw new Error(`${label}不能为空`);return value}
function normalizePublished(seconds:number|undefined,now:number):number{const value=seconds?seconds*1000:now;return value>now?now:value}
function textFromHtml(html:string):string{return cheerio.load(html).root().text().replace(/\s+/g,' ').trim()}
function firstImage(html:string):string|null{return cheerio.load(html)('img[src]').first().attr('src')??null}
function decodeHtml(value:string):string{return cheerio.load(`<body>${value}</body>`)('body').text().trim()}
