import type { AiCapabilityOverrideMode, AiOutputTokenLimitStyle, AiSummaryLength } from './ai'
import type { TranslationDisplayMode, TranslationProviderType, TranslationTarget } from './translation'
import type { LlmCustomizationSettings } from './llm-customization'
import type { McpRemoteAuthMode } from './mcp'
import type { PersistentWebSearchMode, WebSearchProviderKind } from './web-search'

export interface ConfigurationBackup {
  schemaVersion: 1
  appName: 'OrigRead'
  sourceVersion: string
  createdAtEpochMillis: number
  preferences: Record<string, unknown>
  accountSettings: AccountSettingsBackup
  subscriptions: SubscriptionBackup
  websiteRules: unknown
  jsonRules: unknown
  articleFilters: unknown
  websiteParsePreferences: unknown
  rssHub: RssHubBackup
  rssHubSourceUrls: Record<string, string>
  translation: TranslationBackup
  ai: AiBackup
  llm?: LlmBackup
  webSearch?: WebSearchBackup
  mcp?: McpBackup
  encryptedSecrets: EncryptedBackupSecrets | null
}

export interface LlmBackup {
  customization: LlmCustomizationSettings
  skills: unknown
  quickMessages: unknown
}

export interface WebSearchBackup {
  mode: PersistentWebSearchMode
  providers: Array<{id:string;kind:WebSearchProviderKind;name:string;endpoint:string;enabled:boolean}>
  defaultProviderId: string | null
  maxResults: number
}

export interface McpBackup {
  remote: {
    servers: Array<{
      id: string
      name: string
      url: string
      enabled: boolean
      transport: 'STREAMABLE_HTTP'
      authMode: McpRemoteAuthMode
      oauthScopes: string
    }>
  }
  local: {
    servers: Array<{
      id: string
      name: string
      enabled: boolean
      command: string
      args: string[]
      cwd: string
    }>
  }
}

export interface McpRemoteOAuthBackupSecrets {
  client?: string
  tokens?: string
  discovery?: string
}

export interface AccountSettingsBackup {
  syncIntervalMinutes: number
  syncOnStart: boolean
  syncOnlyOnWiFi: boolean
  syncOnlyWhenCharging: boolean
  keepArchivedMillis: number
  syncBlockList: string[]
}
export interface SubscriptionBackup { sourceAccountId:number; groups:BackupGroup[]; feeds:BackupFeed[] }
export interface BackupGroup { id:string;name:string;isDefault:boolean }
export interface BackupFeed { id:string;name:string;icon:string|null;url:string;groupId:string;isNotification:boolean;isFullContent:boolean;isBrowser:boolean;sourceType:string }
export interface RssHubBackup { enabled:boolean;instances:Array<{id:string;url:string;location:string;maintainer:string;enabled:boolean;builtIn:boolean}> }
export interface TranslationBackup {
  defaultProvider:string
  defaultTarget:{type:'traditional'|'ai';provider?:string;providerId?:string;providerName?:string;model?:string}
  targetLanguage:string
  displayMode:TranslationDisplayMode
  providers:Array<{type:string;enabled:boolean;endpoint:string;region:string}>
}
export interface AiBackup {
  enabled:boolean;defaultProviderId:string;outputLanguage:string;summaryLength:AiSummaryLength
  providers:Array<{
    id:string;name:string;enabled:boolean;endpoint:string;defaultModel:string;models:string[]
    streamingCapabilityOverride?:AiCapabilityOverrideMode
    toolCallingCapabilityOverride?:AiCapabilityOverrideMode
    reasoningCapabilityOverride?:AiCapabilityOverrideMode
    outputTokenLimitStyle?:AiOutputTokenLimitStyle
    contextWindowTokens?:number
    strictStreamTermination?:boolean
  }>
}
export interface EncryptedBackupSecrets { kdf:'PBKDF2WithHmacSHA256';cipher:'AES-256-GCM';iterations:number;saltBase64:string;ivBase64:string;ciphertextBase64:string }
export interface ConfigurationBackupSecrets {
  translationApiKeys:Partial<Record<TranslationProviderType,string>>
  aiApiKeys:Record<string,string>
  /** Optional so encrypted backups created before D5 remain readable. */
  webSearchApiKeys?:Record<string,string>
  /** Optional so encrypted backups created before D6 remain readable. */
  mcpRemoteCredentials?:Record<string,string>
  /** Transient PKCE verifier/state are intentionally never backed up. */
  mcpRemoteOAuth?:Record<string,McpRemoteOAuthBackupSecrets>
  /** Local stdio environment values are encrypted separately from portable process profiles. */
  mcpLocalEnvironments?:Record<string,string>
}
export interface ConfigurationRestoreResult { groupsAdded:number;feedsAdded:number;feedsUpdated:number;filterRulesRestored:number;credentialsRestored:boolean }
export interface ConfigurationBackupFileResult { ok:boolean;cancelled:boolean;path:string|null;restoreResult?:ConfigurationRestoreResult;error:string|null }

export function backupTargetToTranslationTarget(value: TranslationBackup['defaultTarget'], fallback: TranslationProviderType): TranslationTarget {
  if (value.type === 'ai' && value.providerId && value.model) return { type:'ai',providerId:value.providerId,providerName:value.providerName??'AI',model:value.model }
  return { type:'traditional',provider:(value.provider as TranslationProviderType) ?? fallback }
}

