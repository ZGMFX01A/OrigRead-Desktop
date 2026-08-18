export type AccountType = 'local' | 'fever' | 'google_reader' | 'fresh_rss'

export interface AccountRecord {
  id: number
  name: string
  type: AccountType
  updatedAt: number | null
  lastArticleId: string | null
  syncIntervalMinutes: number
  syncOnStart: boolean
  syncOnlyOnWiFi: boolean
  syncOnlyWhenCharging: boolean
  keepArchivedMillis: number
  syncBlockList: string[]
  serverUrl: string | null
  username: string | null
  hasPassword: boolean
  hasClientCertificate: boolean
}

export interface AccountSnapshot {
  currentAccountId: number
  accounts: AccountRecord[]
}

export interface AccountCreateInput {
  type: AccountType
  name?: string
  serverUrl?: string
  username?: string
  password?: string
  useClientCertificate?: boolean
  clientCertificatePassphrase?: string
  /** 仅 main 进程在文件选择后注入；Renderer 传入的该字段会被忽略。 */
  clientCertificateBase64?: string
}

export interface AccountPatch {
  id: number
  name?: string
  serverUrl?: string
  username?: string
  password?: string
  syncIntervalMinutes?: number
  syncOnStart?: boolean
  syncOnlyOnWiFi?: boolean
  syncOnlyWhenCharging?: boolean
  keepArchivedMillis?: number
  syncBlockList?: string[]
}

export interface AccountCapabilities {
  importSubscription: boolean
  addSubscription: boolean
  moveSubscription: boolean
  deleteSubscription: boolean
  updateSubscription: boolean
  localOnlySourceTypes: boolean
}

export interface AccountConnectionTestResult {
  ok: boolean
  error: string | null
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  local: 'Local',
  fever: 'Fever',
  google_reader: 'Google Reader',
  fresh_rss: 'FreshRSS'
}

export function accountCapabilities(type: AccountType): AccountCapabilities {
  if (type === 'fever') {
    return {
      importSubscription: false,
      addSubscription: false,
      moveSubscription: false,
      deleteSubscription: false,
      updateSubscription: false,
      localOnlySourceTypes: false
    }
  }
  if (type === 'google_reader' || type === 'fresh_rss') {
    return {
      importSubscription: false,
      addSubscription: true,
      moveSubscription: true,
      deleteSubscription: true,
      updateSubscription: true,
      localOnlySourceTypes: false
    }
  }
  return {
    importSubscription: true,
    addSubscription: true,
    moveSubscription: true,
    deleteSubscription: true,
    updateSubscription: true,
    localOnlySourceTypes: true
  }
}
