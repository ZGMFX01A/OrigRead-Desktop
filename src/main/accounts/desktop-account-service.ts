import { randomUUID } from 'node:crypto'
import type { AccountConnectionTestResult, AccountCreateInput, AccountPatch, AccountRecord, AccountSnapshot } from '../../shared/account'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import { findGroupByName, normalizeGroupName } from '../../shared/group-name'
import { findSiblingGroupByName, validateGroupParent } from '../../shared/group-tree'
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { SourceSyncBatchResult } from '../../shared/source-sync'
import { LibraryRepository } from '../database/library-repository'
import { AccountRepository } from './account-repository'
import { RemoteAccountSyncService } from './remote-account-sync-service'

interface LocalSyncRunner {
  refreshAllSources(fetchedAt?:number, accountId?:number):Promise<SourceSyncBatchResult>
  refreshGroup?(groupId:string, fetchedAt?:number, accountId?:number):Promise<SourceSyncBatchResult>
}

export interface CreateGroupOptions {
  parentId?: string | null
  destFeedId?: string
}

export class DesktopAccountService {
  constructor(
    private readonly accounts:AccountRepository,
    private readonly library:LibraryRepository,
    private readonly services: { remote:RemoteAccountSyncService; localSync:LocalSyncRunner }
  ) {}

  snapshot():AccountSnapshot{return this.accounts.snapshot()}
  current():AccountRecord{return this.accounts.current()}

  async add(input:AccountCreateInput):Promise<AccountRecord>{
    const previous=this.accounts.currentId()
    const account=this.accounts.add(input)
    if(account.type==='local')return account
    try{
      if(!await this.services.remote.validCredentials(account))throw new Error('服务器拒绝了当前账户凭据')
    }catch(error){
      // Android AccountViewModel：验证失败会删除刚插入账户；Desktop 同时显式恢复添加前账户。
      this.accounts.delete(account.id)
      if(this.accounts.get(previous))this.accounts.switchTo(previous)
      throw error
    }
    // Android 在 credentials 通过后 enqueue OneTimeWork，不阻塞“添加成功”回调。
    void this.services.remote.sync(account.id).catch(()=>undefined)
    return this.accounts.get(account.id)!
  }

  switchTo(id:number):AccountRecord{return this.accounts.switchTo(id)}
  delete(id:number):AccountRecord{return this.accounts.delete(id)}
  update(patch:AccountPatch):AccountRecord{return this.accounts.update(patch)}

  async testConnection(id:number):Promise<AccountConnectionTestResult>{
    const account=this.accounts.get(id)
    if(!account)return{ok:false,error:'账户不存在'}
    try{
      const ok=await this.services.remote.validCredentials(account)
      return{ok,error:ok?null:'服务器拒绝了当前账户凭据'}
    }catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)}}
  }

  async syncCurrent():Promise<SourceSyncBatchResult>{
    const account=this.accounts.current()
    if(account.type==='local'){
      const result=await this.services.localSync.refreshAllSources(Date.now(), account.id)
      // 部分失败不能推进成功时间或清理历史；成功后重读用户在抓取期间修改的配置。
      if(result.failedCount===0){
        this.accounts.updateSyncMetadata(account.id,Date.now())
        const current=this.accounts.get(account.id)
        if(current)this.clearKeepArchived(current)
      }
      return result
    }
    const startedAt=Date.now()
    const before=this.library.snapshot(account.id)
    await this.services.remote.sync(account.id)
    this.clearKeepArchived(this.accounts.get(account.id)??account)
    const after=this.library.snapshot(account.id)
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

  async refreshGroup(groupId:string):Promise<SourceSyncBatchResult>{
    const account=this.current()
    if(account.type==='local'){
      if(!this.services.localSync.refreshGroup)throw new Error('当前同步器不支持分组刷新')
      return this.services.localSync.refreshGroup(groupId,Date.now(),account.id)
    }
    return this.syncCurrent()
  }

  async subscribeRss(discovered:DiscoveredRssFeed,groupId?:string):Promise<string>{
    return this.services.remote.subscribeRss(discovered,groupId)
  }

  async addGroup(name: string, optionsOrDestFeedId?: string | CreateGroupOptions): Promise<GroupRecord> {
    const account = this.current()
    const normalized = normalizeGroupName(name)
    if (normalized.length > 200) {
      throw new Error('分组名称不能超过 200 个字符')
    }

    const options: CreateGroupOptions =
      typeof optionsOrDestFeedId === 'string'
        ? { destFeedId: optionsOrDestFeedId }
        : (optionsOrDestFeedId ?? {})

    const normalizedParentId =
      typeof options.parentId === 'string' && options.parentId.trim()
        ? options.parentId.trim()
        : null

    if (account.type === 'local') {
      const groups = this.library.listGroupsForAccount(account.id)

      if (normalizedParentId !== null) {
        const parent = groups.find((g) => g.id === normalizedParentId)
        if (!parent) {
          throw new Error('指定的父分组不存在')
        }
        if (parent.accountId !== undefined && parent.accountId !== account.id) {
          throw new Error('父分组必须属于同一账户')
        }
        if (parent.isDefault) {
          throw new Error('默认分组不允许作为父分组')
        }
      }

      const existing = findSiblingGroupByName(groups, normalized, normalizedParentId)
      if (existing) return existing

      const newGroupId = randomUUID()
      validateGroupParent({
        groupId: newGroupId,
        parentId: normalizedParentId,
        allGroups: groups,
        isLocalAccount: true,
        accountId: account.id,
        isDefault: false,
        maxDepth: 32
      })

      const group: GroupRecord = {
        id: newGroupId,
        accountId: account.id,
        name: normalized,
        sortOrder: Math.max(-1, ...groups.map((item) => item.sortOrder)) + 1,
        isDefault: false,
        parentId: normalizedParentId
      }
      this.library.upsertGroup(group)
      return group
    }

    if (normalizedParentId !== null) {
      throw new Error('远程账户分组不支持层级结构')
    }
    return this.services.remote.addGroup(normalized, options.destFeedId)
  }

  async renameGroup(groupId: string, name: string): Promise<GroupRecord> {
    const account = this.current()
    if (account.type !== 'local') return this.services.remote.renameGroup(groupId, name)
    const normalized = normalizeGroupName(name)
    if (normalized.length > 200) throw new Error('分组名称不能超过 200 个字符')
    const groups = this.library.listGroupsForAccount(account.id)
    const currentGroup = groups.find((group) => group.id === groupId)
    if (!currentGroup) throw new Error('分组不存在')
    const existing = findSiblingGroupByName(groups, normalized, currentGroup.parentId, currentGroup.id)
    if (existing) throw new Error('分组名称已存在')
    const updated: GroupRecord = {
      ...currentGroup,
      name: normalized
    }
    this.library.upsertGroup(updated)
    return updated
  }

  async moveGroup(groupId: string, targetParentId?: string | null): Promise<GroupRecord> {
    const account = this.current()
    if (account.type !== 'local') {
      throw new Error('远程账户分组不支持层级结构')
    }

    const groups = this.library.listGroupsForAccount(account.id)
    const currentGroup = groups.find((group) => group.id === groupId)
    if (!currentGroup) throw new Error('分组不存在')
    if (currentGroup.isDefault) throw new Error('默认分组不允许移动')

    const normalizedParentId =
      typeof targetParentId === 'string' && targetParentId.trim()
        ? targetParentId.trim()
        : null

    if (normalizedParentId !== null) {
      if (normalizedParentId === currentGroup.id) {
        throw new Error('分组不能将自身设为父分组')
      }
      const parent = groups.find((g) => g.id === normalizedParentId)
      if (!parent) {
        throw new Error('指定的父分组不存在')
      }
      if (parent.accountId !== undefined && parent.accountId !== account.id) {
        throw new Error('父分组必须属于同一账户')
      }
      if (parent.isDefault) {
        throw new Error('默认分组不允许作为父分组')
      }
    }

    const existingSibling = findSiblingGroupByName(groups, currentGroup.name, normalizedParentId, currentGroup.id)
    if (existingSibling) {
      throw new Error('同一层级下已存在同名分组')
    }

    validateGroupParent({
      groupId: currentGroup.id,
      parentId: normalizedParentId,
      allGroups: groups,
      isLocalAccount: true,
      accountId: account.id,
      isDefault: currentGroup.isDefault,
      maxDepth: 32
    })

    const updated: GroupRecord = {
      ...currentGroup,
      parentId: normalizedParentId
    }
    this.library.upsertGroup(updated)
    return updated
  }

  async updateFeed(feedId:string,patch:{name?:string;url?:string;groupId?:string;isNotification?:boolean;isFullContent?:boolean;isBrowser?:boolean}):Promise<FeedRecord>{
    if(this.current().type!=='local')return this.services.remote.updateFeed(feedId,patch)
    const current=this.library.getFeedById(feedId);if(!current)throw new Error('来源不存在')
    if(current.sourceType==='json'&&patch.url!==undefined&&patch.url!==current.url){
      throw new Error('JSON 来源地址需要在解析设置中重新探测并确认规则')
    }
    const next={...current,...patch,updatedAt:Date.now()};this.library.upsertFeed(next);return this.library.getFeedById(feedId)!
  }

  async deleteFeed(feedId:string):Promise<void>{
    if(this.current().type!=='local')return this.services.remote.deleteFeed(feedId)
    this.library.deleteArticlesByFeed(feedId,true);this.library.deleteFeed(feedId)
  }

  async markArticleUnread(articleId:string,unread:boolean):Promise<void>{await this.services.remote.markArticleUnread(articleId,unread)}
  async markArticleStarred(articleId:string,starred:boolean):Promise<void>{await this.services.remote.markArticleStarred(articleId,starred)}

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
