import { randomUUID } from 'node:crypto'
import type { AccountConnectionTestResult, AccountCreateInput, AccountPatch, AccountRecord, AccountSnapshot } from '../../shared/account'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { SourceSyncBatchResult } from '../../shared/source-sync'
import { LibraryRepository } from '../database/library-repository'
import { AccountRepository } from './account-repository'
import { RemoteAccountSyncService } from './remote-account-sync-service'

interface LocalSyncRunner {
  refreshAllSources(fetchedAt?:number):Promise<SourceSyncBatchResult>
}

export class DesktopAccountService {
  constructor(
    private readonly accounts:AccountRepository,
    private readonly library:LibraryRepository,
    private readonly remote:RemoteAccountSyncService,
    private readonly localSync:LocalSyncRunner
  ) {}

  snapshot():AccountSnapshot{return this.accounts.snapshot()}
  current():AccountRecord{return this.accounts.current()}

  async add(input:AccountCreateInput):Promise<AccountRecord>{
    const previous=this.accounts.currentId()
    const account=this.accounts.add(input)
    if(account.type==='local')return account
    try{
      if(!await this.remote.validCredentials(account))throw new Error('服务器拒绝了当前账户凭据')
    }catch(error){
      // Android AccountViewModel：验证失败会删除刚插入账户；Desktop 同时显式恢复添加前账户。
      this.accounts.delete(account.id)
      if(this.accounts.get(previous))this.accounts.switchTo(previous)
      throw error
    }
    // Android 在 credentials 通过后 enqueue OneTimeWork，不阻塞“添加成功”回调。
    void this.remote.sync(account.id).catch(()=>undefined)
    return this.accounts.get(account.id)!
  }

  switchTo(id:number):AccountRecord{return this.accounts.switchTo(id)}
  delete(id:number):AccountRecord{return this.accounts.delete(id)}
  update(patch:AccountPatch):AccountRecord{return this.accounts.update(patch)}

  async testConnection(id:number):Promise<AccountConnectionTestResult>{
    const account=this.accounts.get(id)
    if(!account)return{ok:false,error:'账户不存在'}
    try{
      const ok=await this.remote.validCredentials(account)
      return{ok,error:ok?null:'服务器拒绝了当前账户凭据'}
    }catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)}}
  }

  async syncCurrent():Promise<SourceSyncBatchResult>{
    const account=this.accounts.current()
    if(account.type==='local'){
      const result=await this.localSync.refreshAllSources()
      this.clearKeepArchived(account)
      return result
    }
    const startedAt=Date.now()
    const before=this.library.snapshot()
    await this.remote.sync(account.id)
    this.clearKeepArchived(this.accounts.get(account.id)??account)
    const after=this.library.snapshot()
    const feeds=this.library.listFeedsForAccount(account.id)
    const inserted=Math.max(0,after.articles-before.articles)
    return{
      startedAt,finishedAt:Date.now(),sourceCount:feeds.length,successCount:feeds.length,failedCount:0,
      fetchedArticles:inserted,insertedArticles:inserted,deletedArticles:Math.max(0,before.articles-after.articles),
      retryRecommended:false,results:feeds.map((feed)=>({feedId:feed.id,feedName:feed.name,sourceType:feed.sourceType,
        status:'success',fetchedArticles:0,insertedArticles:0,deletedArticles:0,error:null}))
    }
  }

  refreshAllSources():Promise<SourceSyncBatchResult>{return this.syncCurrent()}

  async subscribeRss(discovered:DiscoveredRssFeed,groupId?:string):Promise<string>{
    return this.remote.subscribeRss(discovered,groupId)
  }

  async addGroup(name:string,destFeedId?:string):Promise<GroupRecord>{
    if(this.current().type==='local'){
      const groups=this.library.listGroups()
      const group:GroupRecord={id:randomUUID(),accountId:this.current().id,name:name.trim(),sortOrder:Math.max(-1,...groups.map((item)=>item.sortOrder))+1,isDefault:false}
      this.library.upsertGroup(group);return group
    }
    return this.remote.addGroup(name,destFeedId)
  }

  async updateFeed(feedId:string,patch:{name?:string;url?:string;groupId?:string;isNotification?:boolean;isFullContent?:boolean;isBrowser?:boolean}):Promise<FeedRecord>{
    if(this.current().type!=='local')return this.remote.updateFeed(feedId,patch)
    const current=this.library.getFeedById(feedId);if(!current)throw new Error('来源不存在')
    const next={...current,...patch,updatedAt:Date.now()};this.library.upsertFeed(next);return this.library.getFeedById(feedId)!
  }

  async deleteFeed(feedId:string):Promise<void>{
    if(this.current().type!=='local')return this.remote.deleteFeed(feedId)
    this.library.deleteArticlesByFeed(feedId,true);this.library.deleteFeed(feedId)
  }

  async markArticleUnread(articleId:string,unread:boolean):Promise<void>{await this.remote.markArticleUnread(articleId,unread)}
  async markArticleStarred(articleId:string,starred:boolean):Promise<void>{await this.remote.markArticleStarred(articleId,starred)}

  clearArticles(id:number):void{
    if(!this.accounts.get(id))throw new Error('账户不存在')
    this.library.deleteNonStarredArticlesForAccount(id)
  }

  private clearKeepArchived(account:AccountRecord):void {
    if(account.keepArchivedMillis<=0)return
    this.library.archiveExpiredArticlesForAccount(account.id,account.keepArchivedMillis)
  }
}

export class AccountSyncSettingsProvider {
  constructor(private readonly accounts:AccountRepository){}
  current():{syncIntervalMinutes:number;syncOnStart:boolean;syncOnlyWhenCharging:boolean}{
    const account=this.accounts.current()
    return{syncIntervalMinutes:account.syncIntervalMinutes,syncOnStart:account.syncOnStart,syncOnlyWhenCharging:account.syncOnlyWhenCharging}
  }
}
