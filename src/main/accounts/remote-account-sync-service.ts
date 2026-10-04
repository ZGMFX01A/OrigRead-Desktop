import { feverItemToArticle, decodeHtml } from './remote-article-records'
import { syncGoogleReaderAccount } from './google-reader-account-sync'
import type { AccountRecord } from '../../shared/account'
import type { ArticleRecord, FeedRecord, GroupRecord } from '../../shared/library'
import type { DiscoveredRssFeed } from '../../shared/rss'
import { defaultGroupId } from '../database/migrations'
import { LibraryRepository } from '../database/library-repository'
import { AccountRepository, remoteDbId, remoteId } from './account-repository'
import {
  categoryRemoteId, feedRemoteId, FeverApi, type FeverFeedsGroups,
  GoogleReaderApi,  STREAM_READ, STREAM_STARRED,
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
    else await syncGoogleReaderAccount({ account, api: this.googleApi(account), library: this.library, accounts: this.accounts, ensureDefaultGroup: () => this.ensureDefaultGroup(account.id) })
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
    const account=this.articleAccount(articleId)
    if(account.type==='local'){this.library.setArticleUnreadForAccount(account.id,articleId,unread);return}
    if(account.type==='fever')await this.feverApi(account).markItem(unread?'unread':'read',remoteId(articleId))
    else await this.googleApi(account).editTag([remoteId(articleId)],unread?undefined:STREAM_READ,unread?STREAM_READ:undefined)
    this.library.setArticleUnreadForAccount(account.id,articleId,unread)
  }

  async markArticleStarred(articleId:string,starred:boolean):Promise<void>{
    const account=this.articleAccount(articleId)
    if(account.type==='local'){this.library.setArticleStarredForAccount(account.id,articleId,starred);return}
    if(account.type==='fever')await this.feverApi(account).markItem(starred?'saved':'unsaved',remoteId(articleId))
    else await this.googleApi(account).editTag([remoteId(articleId)],starred?STREAM_STARRED:undefined,starred?undefined:STREAM_STARRED)
    this.library.setArticleStarredForAccount(account.id,articleId,starred)
  }

  /** 已读和收藏均以文章持久化归属为准，同号远端文章不能串用另一账户的凭据。 */
  private articleAccount(articleId:string):AccountRecord{
    const accountId=this.library.getArticleAccountId(articleId)
    if(accountId===null)throw new Error(`文章不存在：${articleId}`)
    const account=this.accounts.get(accountId)
    if(!account)throw new Error(`文章账户不存在：${accountId}`)
    return account
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
        const article=feverItemToArticle(item,account.id,now)
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

function mergeFeverGroupMapping(...groups:Array<FeverFeedsGroups[]|undefined>):Map<string,string>{
  const map=new Map<string,string>();for(const list of groups)for(const relation of list??[]){if(relation.group_id===undefined)continue;for(const feedId of splitIds(relation.feed_ids??''))map.set(feedId,String(relation.group_id))}return map
}
function googleReaderCategoryId(accountId:number,groupId:string):string|undefined{
  if(groupId===defaultGroupId(accountId))return undefined
  return categoryRemoteId(remoteId(groupId))
}
function splitIds(value:string):string[]{return value.split(',').map((item)=>item.trim()).filter(Boolean)}
function required(value:string|null,label:string):string{if(!value)throw new Error(`${label}不能为空`);return value}
