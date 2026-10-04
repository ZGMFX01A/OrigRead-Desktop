import type { AccountRecord } from '../../shared/account'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { LibraryRepository } from '../database/library-repository'
import type { AccountRepository } from './account-repository'
import { remoteDbId, remoteId } from './account-repository'
import { categoryRemoteId, feedRemoteId, googleRemoteItemId, type GoogleReaderApi } from './remote-account-api'
import { googleItemToArticle, decodeHtml } from './remote-article-records'

// Google Reader 已读快照仍只覆盖最近一个月，旧文章不能通过未读集合的补集强制改变。
const READ_SNAPSHOT_WINDOW_MS = 30 * 24 * 60 * 60_000
const MILLISECONDS_PER_SECOND = 1_000
// 保留原有每批文章数和网络并发，不截断上游返回的身份集合。
const CONTENT_BATCH_SIZE = 100
const CONTENT_CONCURRENCY = 8

interface SyncContext {
  readonly account: AccountRecord
  readonly api: GoogleReaderApi
  readonly library: LibraryRepository
  readonly accounts: AccountRepository
  readonly ensureDefaultGroup: () => GroupRecord
}
interface SyncState {
  readonly unread: Set<string>
  readonly starred: Set<string>
  readonly read: Set<string>
  readonly localStates: ReturnType<LibraryRepository['listArticleStateForAccount']>
  readonly localIds: Set<string>
  readonly subscriptions: Awaited<ReturnType<GoogleReaderApi['getSubscriptionList']>>
  readonly now: number
}
interface Catalog { readonly remoteGroups: Map<string, GroupRecord>; readonly remoteFeeds: FeedRecord[] }

/** 远端同步始终使用任务账户，成功时间通过局部列更新写入。 */
export async function syncGoogleReaderAccount(context: SyncContext): Promise<void> {
  const state = await fetchSnapshots(context)
  const catalog = saveCatalog(context, state)
  await fetchMissingArticles(context, state)
  applyArticleStates(context, state)
  cleanupCatalog(context, catalog)
}

/** 并行取状态和目录，保留所有分页身份，并在网络后读取本地状态快照。 */
async function fetchSnapshots(context: SyncContext): Promise<SyncState> {
    const { api, account, library } = context
    await api.authenticate()
    const sinceSeconds=Math.floor((Date.now()-READ_SNAPSHOT_WINDOW_MS)/MILLISECONDS_PER_SECOND)
    const [remoteUnread,remoteStarred,remoteRead,subscriptions]=await Promise.all([
      collectIds((c)=>api.getUnreadItemIds(c)),
      collectIds((c)=>api.getStarredItemIds(c)),
      collectIds((c)=>api.getReadItemIds(sinceSeconds,account.type==='fresh_rss',c)),
      api.getSubscriptionList()
    ])
    const unread=new Set(remoteUnread.map(googleRemoteItemId))
    const starred=new Set(remoteStarred.map(googleRemoteItemId))
    const read=new Set(remoteRead.map(googleRemoteItemId))
    const localStates=library.listArticleStateForAccount(account.id)
    const localIds=new Set(localStates.map((item)=>remoteId(item.id)))

  return { unread, starred, read, localStates, localIds, subscriptions, now: Date.now() }
}

/** 目录映射与写入使用同一任务账户和已确认的分组关系。 */
function saveCatalog(context: SyncContext, state: SyncState): Catalog {
  const { account, library } = context
  const { subscriptions } = state
    const defaultGroup=context.ensureDefaultGroup()
    const remoteGroups=new Map<string,GroupRecord>([[defaultGroup.id,defaultGroup]])
    const remoteFeeds:FeedRecord[]=[]
    const now=state.now
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
    for(const group of remoteGroups.values())library.upsertGroup(group)
    for(const feed of remoteFeeds)library.upsertFeed(feed)

  return { remoteGroups, remoteFeeds }
}

/** 分批抓取尚未拥有的文章，内容入库后单独应用本轮远端状态。 */
async function fetchMissingArticles(context: SyncContext, state: SyncState): Promise<void> {
  const { account, api, library } = context
  const { unread, starred, read, localIds, now } = state
    const needed=new Set([...unread,...starred,...read].filter((id)=>!localIds.has(id)))
    const chunks=[...needed].reduce<string[][]>((list,id,index)=>{const bucket=Math.floor(index/CONTENT_BATCH_SIZE);(list[bucket]??=[]).push(id);return list},[])
    for(let offset=0;offset<chunks.length;offset+=CONTENT_CONCURRENCY){
      const batches=await Promise.all(chunks.slice(offset,offset+CONTENT_CONCURRENCY).map((ids)=>api.getItemsContents(ids)))
      for(const batch of batches){
        for(const item of batch.items??[]){
          const article=googleItemToArticle(item,{accountId:account.id,unread,starred,updated:batch.updated,now})
          if(!article)continue
          library.upsertArticle(article)
          library.setArticleUnreadForAccount(account.id,article.id,article.isUnread)
          library.setArticleStarredForAccount(account.id,article.id,article.isStarred)
        }
      }
    }

}

/** 收藏和已读差集按账户分批更新，不覆盖内容字段。 */
function applyArticleStates(context: SyncContext, state: SyncState): void {
  const { account, library } = context
  const { unread, starred, read, localStates } = state
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
    library.setArticleStarredBatchForAccount(account.id,toBeStarred,true)
    library.setArticleStarredBatchForAccount(account.id,toBeUnstarred,false)
    library.setArticleUnreadBatchForAccount(account.id,toBeRead,false)
    library.setArticleUnreadBatchForAccount(account.id,toBeUnread,true)

}

/** 保留有收藏的孤儿目录，整轮完成后才推进同步时间。 */
function cleanupCatalog(context: SyncContext, catalog: Catalog): void {
  const { account, library } = context
  const { remoteGroups, remoteFeeds } = catalog
    const groupIds=new Set(remoteGroups.keys())
    for(const group of library.listGroupsForAccount(account.id))if(!groupIds.has(group.id))library.deleteGroupForAccountIfNoStarred(account.id,group.id)
    const feedIds=new Set(remoteFeeds.map((feed)=>feed.id))
    for(const feed of library.listFeedsForAccount(account.id))if(!feedIds.has(feed.id))library.deleteFeedForAccountIfNoStarred(account.id,feed.id)
    context.accounts.updateSyncMetadata(account.id,Date.now())
}

/** continuation 分页完整收集身份，任何一页失败仍抛给整轮同步。 */
async function collectIds(loader:(continuation?:string)=>Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>):Promise<string[]>{
  const ids:string[]=[]
  let continuation:string|undefined
  do {
    const result=await loader(continuation)
    for(const item of result.itemRefs??[])if(item.id)ids.push(item.id)
    continuation=result.continuation
  } while(continuation)
  return ids
}
