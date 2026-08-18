import { createHash } from 'node:crypto'

export type AccountFetch = (input:string|URL|Request,init?:RequestInit)=>Promise<Response>

export interface GoogleReaderSubscription {
  id?:string
  title?:string
  categories?:Array<{id?:string;label?:string}>
  url?:string
  htmlUrl?:string
  iconUrl?:string
}

export interface GoogleReaderItem {
  id?:string
  crawlTimeMsec?:string
  published?:number
  title?:string
  summary?:{content?:string}
  origin?:{streamId?:string;htmlUrl?:string;title?:string}
  author?:string
  canonical?:Array<{href?:string}>
  alternate?:Array<{href?:string}>
}

export class GoogleReaderApi {
  private loginToken:string|null=null
  private actionToken:string|null=null

  constructor(
    private readonly serverUrl:string,
    private readonly username:string,
    private readonly password:string,
    private readonly fetcher:AccountFetch=fetch
  ) {}

  clearAuthorization():void { this.loginToken=null;this.actionToken=null }

  async validCredentials():Promise<boolean>{
    try{await this.authenticate();return true}catch{return false}
  }

  async authenticate():Promise<void>{
    const form=new URLSearchParams({
      output:'json',Email:this.username,Passwd:this.password,client:'ReadYou',
      accountType:'HOSTED_OR_GOOGLE',service:'reader'
    })
    const response=await this.fetcher(`${this.serverUrl}accounts/ClientLogin`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'OrigRead Desktop'},
      body:form,signal:AbortSignal.timeout(20_000)
    })
    const text=await response.text()
    if(response.status===400)throw new Error('BadRequest for CL Token')
    if(response.status===401)throw new Error('Unauthorized for CL Token')
    if(!response.ok)throw new Error(text||`HTTP ${response.status}`)
    let token:string|undefined
    try{token=(JSON.parse(text) as {Auth?:string}).Auth}catch{token=undefined}
    token??=text.split('\n').find((line)=>line.startsWith('Auth='))?.slice(5)
    if(!token)throw new Error('body format error for CL Token')
    this.loginToken=token

    // Android 把 action token 当作可选能力：取不到不否定 ClientLogin 已认证成功。
    try{
      const action=await this.fetcher(`${this.serverUrl}reader/api/0/token`,{
        headers:{Authorization:`GoogleLogin auth=${token}`},signal:AbortSignal.timeout(20_000)
      })
      if(action.ok)this.actionToken=await action.text()
    }catch{this.actionToken=null}
  }

  async getUserInfo():Promise<{userName?:string}>{return this.getJson('reader/api/0/user-info')}
  async getSubscriptionList():Promise<{subscriptions:GoogleReaderSubscription[]}>{return this.getJson('reader/api/0/subscription/list')}

  async getUnreadItemIds(continuation?:string):Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>{
    return this.getJson('reader/api/0/stream/items/ids',params([['s',STREAM_ALL],['xt',STREAM_READ],['n','1000'],['c',continuation]]))
  }
  async getStarredItemIds(continuation?:string):Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>{
    return this.getJson('reader/api/0/stream/items/ids',params([['s',STREAM_STARRED],['n','1000'],['c',continuation]]))
  }
  async getReadItemIds(sinceSeconds:number,freshRss:boolean,continuation?:string):Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>{
    return this.getJson('reader/api/0/stream/items/ids',params([
      ['s',freshRss?STREAM_ALL:STREAM_READ],
      [freshRss?'it':'s',freshRss?STREAM_READ:undefined],
      ['ot',String(sinceSeconds)],['n','1000'],['c',continuation]
    ]))
  }
  async getItemIdsForFeed(feedId:string,filterRead:boolean,continuation?:string):Promise<{itemRefs?:Array<{id?:string}>;continuation?:string}>{
    return this.getJson('reader/api/0/stream/items/ids',params([
      ['s',`feed/${feedId}`],['xt',filterRead?STREAM_READ:undefined],['n','1000'],['c',continuation]
    ]))
  }
  async getItemsContents(ids:string[]):Promise<{updated?:number;items?:GoogleReaderItem[]}>{
    return this.postJson('reader/api/0/stream/items/contents',ids.map((id)=>['i',id]))
  }
  async subscriptionQuickAdd(feedUrl:string):Promise<{streamId?:string;streamName?:string}>{
    return this.postJson('reader/api/0/subscription/quickadd',[['quickadd',feedUrl]],params([['quickadd',feedUrl]]))
  }
  async subscriptionEdit(input:{action?:string;feedId?:string;destCategoryId?:string;originCategoryId?:string;title?:string}):Promise<void>{
    await this.postText('reader/api/0/subscription/edit',[
      ['ac',input.action??'edit'],['s',input.feedId?`feed/${input.feedId}`:undefined],
      ['a',input.destCategoryId?categoryStream(input.destCategoryId):undefined],
      ['r',input.originCategoryId?categoryStream(input.originCategoryId):undefined],['t',input.title]
    ])
  }
  async editTag(ids:string[],mark?:string,unmark?:string):Promise<void>{
    await this.postText('reader/api/0/edit-tag',[
      ...ids.map((id)=>['i',id] as [string,string]),['a',mark],['r',unmark]
    ])
  }
  async disableTag(categoryId:string):Promise<void>{await this.postText('reader/api/0/disable-tag',[['s',categoryStream(categoryId)]])}
  async renameTag(categoryId:string,name:string):Promise<void>{await this.postText('reader/api/0/rename-tag',[['s',categoryStream(categoryId)],['dest',categoryStream(name)]])}

  private async ensureAuth():Promise<void>{if(!this.loginToken)await this.authenticate()}
  private async getJson<T>(path:string,query=''):Promise<T>{
    await this.ensureAuth()
    return this.requestWithReauth(async()=>{
      const response=await this.fetcher(`${this.serverUrl}${path}?output=json${query}`,{headers:this.authHeaders(),signal:AbortSignal.timeout(30_000)})
      return parseJsonResponse<T>(response)
    })
  }
  private async postJson<T>(path:string,formEntries:Array<[string,string|undefined]>,query=''):Promise<T>{
    const text=await this.postText(path,formEntries,query)
    try{return JSON.parse(text) as T}catch{throw new Error(`Google Reader 返回了无效 JSON：${text.slice(0,160)}`)}
  }
  private async postText(path:string,formEntries:Array<[string,string|undefined]>,query=''):Promise<string>{
    await this.ensureAuth()
    return this.requestWithReauth(async()=>{
      const form=new URLSearchParams()
      for(const [key,value] of formEntries)if(value!==undefined)form.append(key,value)
      if(this.actionToken)form.append('T',this.actionToken)
      const response=await this.fetcher(`${this.serverUrl}${path}?output=json${query}`,{
        method:'POST',headers:{...this.authHeaders(),'Content-Type':'application/x-www-form-urlencoded'},body:form,
        signal:AbortSignal.timeout(30_000)
      })
      const text=await response.text()
      if(response.status===401)throw new UnauthorizedError()
      if(response.status===400)throw new Error('BadRequest')
      if(!response.ok)throw new Error(text||`HTTP ${response.status}`)
      return text
    })
  }
  private authHeaders():Record<string,string>{return{Authorization:`GoogleLogin auth=${this.loginToken}`,'User-Agent':'OrigRead Desktop'}}
  private async requestWithReauth<T>(work:()=>Promise<T>):Promise<T>{
    try{return await work()}catch(error){
      if(!(error instanceof UnauthorizedError))throw error
      this.clearAuthorization();await this.authenticate();return work()
    }
  }
}

export interface FeverItem {id?:string;feed_id?:number;title?:string;author?:string;html?:string;url?:string;is_saved?:number;is_read?:number;created_on_time?:number}
export interface FeverFeed {id?:number;favicon_id?:number;title?:string;url?:string;site_url?:string}
export interface FeverGroup {id?:number;title?:string}
export interface FeverFeedsGroups {group_id?:number;feed_ids?:string}

export class FeverApi {
  private readonly apiKey:string
  constructor(private readonly serverUrl:string,username:string,password:string,private readonly fetcher:AccountFetch=fetch){
    this.apiKey=createHash('md5').update(`${username}:${password}`).digest('hex')
  }
  async validCredentials():Promise<boolean>{try{const value=await this.request<{auth?:number}>(null);return (value.auth??0)>0}catch{return false}}
  getGroups(){return this.authed<{groups?:FeverGroup[];feeds_groups?:FeverFeedsGroups[]}>('groups')}
  getFeeds(){return this.authed<{feeds?:FeverFeed[];feeds_groups?:FeverFeedsGroups[]}>('feeds')}
  getFavicons(){return this.authed<{favicons?:Array<{id:number;data?:string}>}>('favicons')}
  getItemsSince(id:string){return this.authed<{items?:FeverItem[]}>('items&since_id='+encodeURIComponent(id))}
  getUnreadItems(){return this.authed<{unread_item_ids?:string}>('unread_item_ids')}
  getSavedItems(){return this.authed<{saved_item_ids?:string}>('saved_item_ids')}
  async markItem(status:'read'|'unread'|'saved'|'unsaved',id:string):Promise<void>{await this.authed(`mark=item&as=${status}&id=${encodeURIComponent(id)}`)}
  async markFeed(status:'read'|'unread',id:string,beforeSeconds:number):Promise<void>{await this.authed(`mark=feed&as=${status}&id=${encodeURIComponent(id)}&before=${beforeSeconds}`)}
  async markGroup(status:'read'|'unread',id:string,beforeSeconds:number):Promise<void>{await this.authed(`mark=group&as=${status}&id=${encodeURIComponent(id)}&before=${beforeSeconds}`)}
  private async authed<T=unknown>(query:string):Promise<T>{const value=await this.request<T&{auth?:number}>(query);const auth=(value as {auth?:number}).auth;if(auth!==undefined&&auth<=0)throw new Error('Unauthorized');return value}
  private async request<T>(query:string|null):Promise<T>{
    const separator=this.serverUrl.includes('?')?'&':'?'
    const url=`${this.serverUrl}${separator}api=${query?`&${query}`:''}`
    const form=new URLSearchParams({api_key:this.apiKey})
    const response=await this.fetcher(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(30_000)})
    if(response.status===401)throw new Error('Unauthorized')
    if(!response.ok)throw new Error('Forbidden')
    const text=await response.text()
    try{return JSON.parse(text) as T}catch{throw new Error('Unable to parse response')}
  }
}

export const STREAM_ALL='user/-/state/com.google/reading-list'
export const STREAM_READ='user/-/state/com.google/read'
export const STREAM_STARRED='user/-/state/com.google/starred'

export function googleRemoteItemId(value:string):string{
  const prefix='tag:google.com,2005:reader/item/'
  if(!value.startsWith(prefix))return value
  const hex=value.slice(prefix.length)
  if(!/^[0-9a-f]{16}$/i.test(hex))return value
  return BigInt.asIntN(64,BigInt(`0x${hex}`)).toString()
}
export function feedRemoteId(value:string):string{return value.startsWith('feed/')?value.slice(5):value}
export function categoryRemoteId(value:string):string{return value.replace(/^user\/[^/]+\/label\//,'')}
export function categoryStream(value:string):string{return value.startsWith('user/')?value:`user/-/label/${value}`}

class UnauthorizedError extends Error{}
function params(entries:Array<[string,string|undefined]>):string{
  const query=new URLSearchParams();for(const [key,value] of entries)if(value!==undefined)query.append(key,value)
  const text=query.toString();return text?`&${text}`:''
}
async function parseJsonResponse<T>(response:Response):Promise<T>{
  const text=await response.text()
  if(response.status===401)throw new UnauthorizedError()
  if(response.status===400)throw new Error('BadRequest')
  if(!response.ok)throw new Error(text||`HTTP ${response.status}`)
  try{return JSON.parse(text) as T}catch{throw new Error(`Google Reader 返回了无效 JSON：${text.slice(0,160)}`)}
}
