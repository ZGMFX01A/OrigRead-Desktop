import type { DatabaseSync } from 'node:sqlite'
import type { AccountCreateInput, AccountPatch, AccountRecord, AccountSnapshot, AccountType } from '../../shared/account'
import type { SecretStore } from '../security/secret-store'
import { CURRENT_ACCOUNT_SETTING_KEY, DEFAULT_LOCAL_ACCOUNT_ID, defaultGroupId } from '../database/migrations'

interface AccountRow {
  id: number
  name: string
  type: AccountType
  updated_at: number | null
  last_article_id: string | null
  sync_interval_minutes: number
  sync_on_start: number
  sync_only_on_wifi: number
  sync_only_when_charging: number
  keep_archived_millis: number
  sync_block_list: string
  server_url: string | null
  username: string | null
}

export class AccountRepository {
  constructor(private readonly database: DatabaseSync, private readonly secrets: SecretStore) {}

  snapshot(): AccountSnapshot {
    return { currentAccountId: this.currentId(), accounts: this.list() }
  }

  migrateLegacySyncSettings(syncIntervalMinutes:number,syncOnStart:boolean):void {
    const key='account.legacy_sync_migrated'
    if(this.database.prepare('SELECT 1 AS found FROM app_settings WHERE key=?').get(key))return
    this.database.prepare('UPDATE accounts SET sync_interval_minutes=?,sync_on_start=? WHERE id=?')
      .run(normalizeSyncInterval(syncIntervalMinutes),bool(syncOnStart),DEFAULT_LOCAL_ACCOUNT_ID)
    this.database.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)')
      .run(key,'1',Date.now())
  }

  currentId(): number {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(CURRENT_ACCOUNT_SETTING_KEY) as { value:string } | undefined
    const id = Number(row?.value ?? DEFAULT_LOCAL_ACCOUNT_ID)
    if (Number.isSafeInteger(id) && id > 0 && this.get(id)) return id
    const fallback = this.list()[0]
    if (!fallback) throw new Error('OrigRead 至少需要一个账户')
    this.switchTo(fallback.id)
    return fallback.id
  }

  current(): AccountRecord {
    const account = this.get(this.currentId())
    if (!account) throw new Error('当前账户不存在')
    return account
  }

  list(): AccountRecord[] {
    const rows = this.database.prepare(`
      SELECT id,name,type,updated_at,last_article_id,sync_interval_minutes,sync_on_start,
             sync_only_on_wifi,sync_only_when_charging,keep_archived_millis,sync_block_list,
             server_url,username
      FROM accounts ORDER BY id
    `).all() as unknown as AccountRow[]
    return rows.map((row)=>this.toRecord(row))
  }

  get(id: number): AccountRecord | null {
    const row = this.database.prepare(`
      SELECT id,name,type,updated_at,last_article_id,sync_interval_minutes,sync_on_start,
             sync_only_on_wifi,sync_only_when_charging,keep_archived_millis,sync_block_list,
             server_url,username
      FROM accounts WHERE id = ?
    `).get(id) as AccountRow | undefined
    return row ? this.toRecord(row) : null
  }

  add(input: AccountCreateInput): AccountRecord {
    const type = normalizeAccountType(input.type)
    const name = input.name?.trim() || defaultAccountName(type)
    const serverUrl = type === 'local' ? null : normalizeServerUrl(input.serverUrl, type !== 'fever')
    const username = type === 'local' ? null : requiredText(input.username, '用户名')
    if (type !== 'local') requiredText(input.password, '密码')
    const result = this.database.prepare(`
      INSERT INTO accounts (name,type,server_url,username,created_at)
      VALUES (?,?,?,?,?)
    `).run(name, type, serverUrl, username, Date.now())
    const id = Number(result.lastInsertRowid)
    if (type === 'local') {
      this.database.prepare(`INSERT INTO groups (id,account_id,name,sort_order,is_default) VALUES (?,?,?,?,1)`)
        .run(defaultGroupId(id), id, 'Default', 0)
    } else {
      this.secrets.put(passwordKey(id), input.password ?? '')
      if (input.clientCertificateBase64) {
        this.secrets.put(clientCertificateKey(id), input.clientCertificateBase64)
        this.secrets.put(clientCertificatePassphraseKey(id), input.clientCertificatePassphrase ?? '')
      }
    }
    this.switchTo(id)
    return this.get(id)!
  }

  update(patch: AccountPatch): AccountRecord {
    const current = this.get(patch.id)
    if (!current) throw new Error('账户不存在')
    const name = patch.name === undefined ? current.name : requiredText(patch.name, '账户名称')
    const serverUrl = current.type === 'local' ? null : patch.serverUrl === undefined ? current.serverUrl : normalizeServerUrl(patch.serverUrl, current.type !== 'fever')
    const username = current.type === 'local' ? null : patch.username === undefined ? current.username : requiredText(patch.username, '用户名')
    const syncIntervalMinutes = patch.syncIntervalMinutes === undefined ? current.syncIntervalMinutes : normalizeSyncInterval(patch.syncIntervalMinutes)
    const keepArchivedMillis = patch.keepArchivedMillis === undefined ? current.keepArchivedMillis : normalizeKeepArchived(patch.keepArchivedMillis)
    const syncBlockList = patch.syncBlockList === undefined ? current.syncBlockList : normalizeBlockList(patch.syncBlockList)
    this.database.prepare(`
      UPDATE accounts SET name=?,server_url=?,username=?,sync_interval_minutes=?,sync_on_start=?,
        sync_only_on_wifi=?,sync_only_when_charging=?,keep_archived_millis=?,sync_block_list=? WHERE id=?
    `).run(
      name, serverUrl, username, syncIntervalMinutes,
      bool(patch.syncOnStart ?? current.syncOnStart),
      bool(patch.syncOnlyOnWiFi ?? current.syncOnlyOnWiFi),
      bool(patch.syncOnlyWhenCharging ?? current.syncOnlyWhenCharging),
      keepArchivedMillis, JSON.stringify(syncBlockList), patch.id
    )
    if (patch.password !== undefined && current.type !== 'local') this.secrets.put(passwordKey(patch.id), patch.password)
    return this.get(patch.id)!
  }

  updateSyncMetadata(id: number, updatedAt: number, lastArticleId?: string | null): void {
    this.database.prepare('UPDATE accounts SET updated_at=?, last_article_id=COALESCE(?,last_article_id) WHERE id=?')
      .run(updatedAt, lastArticleId ?? null, id)
  }

  switchTo(id: number): AccountRecord {
    const account = this.get(id)
    if (!account) throw new Error('目标账户不存在')
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(CURRENT_ACCOUNT_SETTING_KEY, String(id), Date.now())
    return account
  }

  delete(id: number): AccountRecord {
    const accounts = this.list()
    if (accounts.length <= 1) throw new Error('OrigRead 至少需要保留一个账户')
    const account = this.get(id)
    if (!account) throw new Error('账户不存在')
    this.database.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    this.secrets.delete(passwordKey(id))
    this.secrets.delete(clientCertificateKey(id))
    this.secrets.delete(clientCertificatePassphraseKey(id))
    if (this.currentIdUnsafe() === id) this.switchTo(this.list()[0]!.id)
    return account
  }

  password(id: number): string { return this.secrets.get(passwordKey(id)) }

  clientCertificate(id:number):{pfx:Buffer;passphrase:string}|null {
    const base64=this.secrets.get(clientCertificateKey(id))
    if(!base64)return null
    return { pfx:Buffer.from(base64,'base64'), passphrase:this.secrets.get(clientCertificatePassphraseKey(id)) }
  }

  setClientCertificate(id:number,pfx:Buffer,passphrase=''):AccountRecord {
    const account=this.get(id)
    if(!account)throw new Error('账户不存在')
    if(account.type==='local')throw new Error('Local 账户不使用客户端证书')
    if(pfx.length===0||pfx.length>10*1024*1024)throw new Error('客户端证书文件无效或过大')
    this.secrets.put(clientCertificateKey(id),pfx.toString('base64'))
    this.secrets.put(clientCertificatePassphraseKey(id),passphrase)
    return this.get(id)!
  }

  clearClientCertificate(id:number):AccountRecord {
    const account=this.get(id)
    if(!account)throw new Error('账户不存在')
    this.secrets.delete(clientCertificateKey(id))
    this.secrets.delete(clientCertificatePassphraseKey(id))
    return this.get(id)!
  }

  private currentIdUnsafe(): number {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(CURRENT_ACCOUNT_SETTING_KEY) as {value:string}|undefined
    return Number(row?.value ?? DEFAULT_LOCAL_ACCOUNT_ID)
  }

  private toRecord(row: AccountRow): AccountRecord {
    let blockList: string[] = []
    try { const parsed=JSON.parse(row.sync_block_list);if(Array.isArray(parsed))blockList=parsed.map(String) } catch { blockList=[] }
    return {
      id: row.id, name: row.name, type: row.type, updatedAt: row.updated_at,
      lastArticleId: row.last_article_id, syncIntervalMinutes: row.sync_interval_minutes,
      syncOnStart: row.sync_on_start===1, syncOnlyOnWiFi: row.sync_only_on_wifi===1,
      syncOnlyWhenCharging: row.sync_only_when_charging===1, keepArchivedMillis: row.keep_archived_millis,
      syncBlockList: blockList, serverUrl: row.server_url, username: row.username,
      hasPassword: row.type !== 'local' && this.secrets.contains(passwordKey(row.id)),
      hasClientCertificate: row.type !== 'local' && this.secrets.contains(clientCertificateKey(row.id))
    }
  }
}

export function passwordKey(id:number):string { return `account:${id}:password` }
export function clientCertificateKey(id:number):string { return `account:${id}:client-certificate-pfx` }
export function clientCertificatePassphraseKey(id:number):string { return `account:${id}:client-certificate-passphrase` }
export function remoteDbId(accountId:number,remoteId:string|number):string { return `${accountId}$${remoteId}` }
export function remoteId(value:string):string { const index=value.indexOf('$');return index>=0?value.slice(index+1):value }

function bool(value:boolean):number{return value?1:0}
function normalizeAccountType(value:AccountType):AccountType{
  if(!['local','fever','google_reader','fresh_rss'].includes(value))throw new Error('不支持的账户类型')
  return value
}
function defaultAccountName(type:AccountType):string{return type==='local'?'OrigRead':type==='fresh_rss'?'FreshRSS':type==='google_reader'?'Google Reader':'Fever'}
function requiredText(value:string|undefined,label:string):string{const normalized=value?.trim()??'';if(!normalized)throw new Error(`${label}不能为空`);return normalized}
function normalizeServerUrl(value:string|undefined,trailingSlash:boolean):string{
  const text=requiredText(value,'服务器地址');const url=new URL(text);if(!['http:','https:'].includes(url.protocol))throw new Error('服务器地址仅支持 HTTP(S)')
  if(!trailingSlash)return text
  return text.endsWith('/')?text:`${text}/`
}
function normalizeSyncInterval(value:number):number{if(![0,15,30,60,120,180,360,720,1440].includes(value))throw new Error('无效的同步间隔');return value}
function normalizeKeepArchived(value:number):number{if(!Number.isFinite(value)||value<0)throw new Error('无效的归档保留时间');return Math.trunc(value)}
function normalizeBlockList(value:string[]):string[]{return [...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]}
