import { ArrowDown, ArrowRight, ArrowUp, BookOpenText, Bot, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clock3, Copy, DatabaseBackup, FileJson2, Filter, Globe2, Languages, Link2, ListChecks, MessageSquareText, Pencil, Plus, RefreshCw, Settings2, Trash2, Upload, Download, CircleHelp, Sparkles, FileText, Search, RadioTower, RotateCcw, X, Eye, EyeOff, Save, ExternalLink, Monitor, Smartphone, Keyboard, MessageSquareWarning, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiProviderProfile, AiSettings } from '../../shared/ai'
import type { AppInfo } from '../../shared/contracts'
import type { ArticleFilterSnapshot, ArticleFilterRuleType } from '../../shared/filter-rules'
import { SYNC_INTERVAL_OPTIONS, type DesktopSettings, type DesktopSettingsPatch, type SyncIntervalMinutes } from '../../shared/settings'
import type { SyncRuntimeState } from '../../shared/sync-runtime'
import type { TranslationProviderSettings, TranslationProviderType, TranslationSettings } from '../../shared/translation'
import type { WebsiteRule } from '../../shared/website'
import type { JsonRule } from '../../shared/json-source'
import { formatRssHubLocation, type RssHubSettings, type RssHubUiLanguage } from '../../shared/rsshub'
import type { AiGeneratedRuleKind, AiGeneratedRulePreview, AiRuleGenerationProgress } from '../../shared/ai-rule'
import { BUILTIN_READER_FONTS, type ReaderFontEntry } from '../../shared/reader-font'
import type { UpdateCheckResult } from '../../shared/update'
import type { AccountCreateInput, AccountPatch, AccountRecord, AccountSnapshot, AccountType } from '../../shared/account'
import type { LlmCustomizationSettings } from '../../shared/llm-customization'
import type { LlmQuickMessage } from '../../shared/llm-quick-message'
import { llmSkillBindingId, type LlmSkillManagementSnapshot, type LlmSkillPreview, type LlmSkillTask } from '../../shared/llm-skill'
import { WEB_SEARCH_PROVIDER_KINDS, webSearchProviderDefinition, type WebSearchProviderKind, type WebSearchProviderProfile, type WebSearchSettings } from '../../shared/web-search'
import type {
  McpConnectionSnapshot,
  McpLocalServerProfile,
  McpLocalSettings,
  McpProtocolEra,
  McpRemoteAuthMode,
  McpRemoteServerProfile,
  McpRemoteSettings,
  McpToolCatalogSnapshot
} from '../../shared/mcp'

export type SettingsPage = 'general' | 'accounts' | 'translation' | 'ai' | 'filters' | 'jsonRules' | 'websiteRules' | 'rsshub' | 'backup' | 'about' | 'update'
const INTERNAL_ITHOME_RULE_ID = 'ithome-home'
const DESKTOP_REPOSITORY_URL = 'https://github.com/ZGMFX01A/OrigRead-Desktop'
const ANDROID_REPOSITORY_URL = 'https://github.com/ZGMFX01A/OrigRead'
const DESKTOP_RELEASES_URL = `${DESKTOP_REPOSITORY_URL}/releases`
const DESKTOP_ISSUES_URL = `${DESKTOP_REPOSITORY_URL}/issues`

interface SettingsPanelProps {
  settings: DesktopSettings
  appInfo: AppInfo | null
  syncState: SyncRuntimeState | null
  initialPage?: SettingsPage
  onChange(patch: DesktopSettingsPatch): void
  onConfigurationRestored?(): void
  onAccountChanged?(): void
  onUnsavedChange?(dirty: boolean): void
}

export function SettingsPanel({ settings, appInfo, syncState, initialPage = 'general', onChange, onConfigurationRestored, onAccountChanged, onUnsavedChange }: SettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [aiUnsaved,setAiUnsaved]=useState(false)
  useEffect(()=>setPage(initialPage),[initialPage])
  useEffect(()=>{onUnsavedChange?.(page==='ai'&&aiUnsaved)},[aiUnsaved,onUnsavedChange,page])
  const navigate=(next:SettingsPage)=>{
    if(next===page)return
    if(page==='ai'&&aiUnsaved&&!window.confirm(t('customInstructionsDiscardConfirm')))return
    if(page==='ai')setAiUnsaved(false)
    setPage(next)
  }
  return <div className="settings-layout">
    <aside className="settings-nav">
      <div className="settings-nav-title"><Settings2 size={18}/><span>{t('settings')}</span></div>
      <SettingsNavButton active={page==='general'} icon={<Globe2 size={16}/>} label={t('settingsGeneral')} onClick={()=>navigate('general')}/>
      <SettingsNavButton active={page==='accounts'} icon={<UserRound size={16}/>} label={t('accountsTitle')} onClick={()=>navigate('accounts')}/>
      <SettingsNavButton active={page==='ai'} icon={<Bot size={16}/>} label={t('aiSettingsTitle')} onClick={()=>navigate('ai')}/>
      <SettingsNavButton active={page==='translation'} icon={<Languages size={16}/>} label={t('translationSettingsTitle')} onClick={()=>navigate('translation')}/>
      <SettingsNavButton active={page==='filters'} icon={<Filter size={16}/>} label={t('articleFilters')} onClick={()=>navigate('filters')}/>
      <SettingsNavButton active={page==='jsonRules'} icon={<FileJson2 size={16}/>} label={t('jsonRules')} onClick={()=>navigate('jsonRules')}/>
      <SettingsNavButton active={page==='websiteRules'} icon={<Globe2 size={16}/>} label={t('websiteRules')} onClick={()=>navigate('websiteRules')}/>
      <SettingsNavButton active={page==='rsshub'} icon={<RadioTower size={16}/>} label={t('rssHubSettings')} onClick={()=>navigate('rsshub')}/>
      <SettingsNavButton active={page==='backup'} icon={<DatabaseBackup size={16}/>} label={t('backupRestore')} onClick={()=>navigate('backup')}/>
      <SettingsNavButton active={page==='about'} icon={<CircleHelp size={16}/>} label={t('aboutAndSupport')} onClick={()=>navigate('about')}/>
      <SettingsNavButton active={page==='update'} icon={<RefreshCw size={16}/>} label={t('softwareUpdate')} onClick={()=>navigate('update')}/>
      <div className="settings-nav-spacer" />
      <small>{appInfo ? `v${appInfo.version} · ${appInfo.platform}` : '—'}</small>
    </aside>
    <div className="settings-page settings-subpage">
      <div key={page} className="settings-page-motion" data-settings-page={page}>
        {page==='general' && <GeneralSettings settings={settings} onChange={onChange}/>}
        {page==='accounts' && <AccountsSettingsPage syncState={syncState} onChanged={onAccountChanged}/>}
        {page==='update' && <UpdateSettingsPage settings={settings} appInfo={appInfo} onChange={onChange}/>}
        {page==='translation' && <TranslationSettingsPage/>}
        {page==='ai' && <AiSettingsPage onUnsavedChange={setAiUnsaved}/>}
        {page==='filters' && <ArticleFilterSettingsPage/>}
        {page==='jsonRules' && <JsonRulesSettingsPage/>}
        {page==='websiteRules' && <WebsiteRulesSettingsPage/>}
        {page==='rsshub' && <RssHubSettingsPage/>}
        {page==='backup' && <BackupSettingsPage onRestored={onConfigurationRestored}/>}
        {page==='about' && <AboutAndSupportPage appInfo={appInfo} onOpenUpdate={()=>setPage('update')}/>}
      </div>
    </div>
  </div>
}

function GeneralSettings({settings,onChange}:{settings:DesktopSettings;onChange:(patch:DesktopSettingsPatch)=>void}):React.JSX.Element{
  const {t}=useTranslation()
  const [customFonts,setCustomFonts]=useState<ReaderFontEntry[]>([])
  const [fontStatus,setFontStatus]=useState('')
  useEffect(()=>{let cancelled=false;void window.origread.listReaderFonts().then((fonts)=>{if(!cancelled)setCustomFonts(fonts)}).catch((error)=>{if(!cancelled)setFontStatus(errorText(error))});return()=>{cancelled=true}},[])
  const importFont=async()=>{setFontStatus('');const result=await window.origread.importReaderFont();if(result.cancelled)return;if(!result.ok||!result.font){setFontStatus(result.error??t('readerFontImportFailed'));return}const fonts=await window.origread.listReaderFonts();setCustomFonts(fonts);onChange({readerFontId:result.font.id});setFontStatus(t('readerFontImported',{name:result.font.name}))}
  const deleteSelectedFont=async()=>{if(!settings.readerFontId.startsWith('custom:'))return;try{setCustomFonts(await window.origread.deleteReaderFont(settings.readerFontId));onChange({readerFontId:'system'});setFontStatus(t('readerFontDeleted'))}catch(error){setFontStatus(errorText(error))}}
  return <>
    <PageIntro icon={<Settings2 size={22}/>} title={t('settingsGeneral')} description={t('settingsDescription')}/>
    <SettingsSection icon={<Globe2 size={17}/>} title={t('settingsGeneral')}>
      <SettingRow title={t('language')} description={t('languageDescription')}><select aria-label={t('language')} className="language-select" value={settings.language} onChange={(e)=>onChange({language:e.target.value as DesktopSettings['language']})}><option value="system">{t('languageSystem')}</option><option value="zh">简体中文</option><option value="en">English</option></select></SettingRow>
      <SettingRow title={t('appearanceTheme')} description={t('appearanceThemeDescription')}><select aria-label={t('appearanceTheme')} className="theme-select" value={settings.theme} onChange={(e)=>onChange({theme:e.target.value as DesktopSettings['theme']})}><option value="system">{t('themeSystem')}</option><option value="light">{t('themeLight')}</option><option value="dark">{t('themeDark')}</option></select></SettingRow>
      <SettingRow className="layout-mode-setting-row" title={t('layoutMode')} description={t('layoutModeDescription')}>
        <div className="layout-mode-segmented" role="group" aria-label={t('layoutMode')}>
          {([
            ['two-pane', 'layoutModeTwoPane'],
            ['three-pane', 'layoutModeThreePane']
          ] as const).map(([mode, labelKey]) => (
            <button
              key={mode}
              type="button"
              className={`layout-mode-option ${settings.layoutMode === mode ? 'selected' : ''}`}
              data-layout-mode={mode}
              aria-pressed={settings.layoutMode === mode}
              onClick={() => onChange({ layoutMode: mode })}
            >
              <span className={`layout-mode-preview ${mode}`} aria-hidden="true"><span/><span/><span/></span>
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </div>
      </SettingRow>
    </SettingsSection>
    <SettingsSection icon={<BookOpenText size={17}/>} title={t('settingsReading')}>
      <SettingRow title={t('readerFont')} description={t('readerFontDescription')}><div className="reader-font-setting"><select aria-label={t('readerFont')} className="reader-font-select" value={settings.readerFontId} onChange={(e)=>onChange({readerFontId:e.target.value})}>{BUILTIN_READER_FONTS.map((font)=><option key={font.id} value={font.id}>{t(font.nameKey)}</option>)}{customFonts.map((font)=><option key={font.id} value={font.id}>{font.name}</option>)}</select><button type="button" className="mini-action" onClick={()=>void importFont()}><Upload size={13}/>{t('importFont')}</button>{settings.readerFontId.startsWith('custom:')&&<button type="button" className="mini-action danger" onClick={()=>void deleteSelectedFont()}><Trash2 size={13}/>{t('delete')}</button>}</div>{fontStatus&&<div className="setting-inline-status">{fontStatus}</div>}</SettingRow>
      <SettingRow className="reader-background-setting-row" title={t('readerBackground')} description={t('readerBackgroundDescription')}><div className="reader-background-options">{([
        ['theme','readerBackgroundTheme'],['paper','readerBackgroundPaper'],['warm','readerBackgroundWarm'],['sepia','readerBackgroundSepia'],['mint','readerBackgroundMint']
      ] as const).map(([value,label])=><button key={value} type="button" className={`reader-background-option bg-${value} ${settings.readerBackground===value?'selected':''}`} onClick={()=>onChange({readerBackground:value})}><span className="reader-background-swatch"/><strong>{t(label)}</strong></button>)}</div></SettingRow>
      <SettingRow title={t('readerBackgroundCustom')} description={t('readerBackgroundCustomDescription')}><div className="reader-background-custom"><button type="button" className={`reader-background-option bg-custom ${settings.readerBackground==='custom'?'selected':''}`} onClick={()=>onChange({readerBackground:'custom'})}><span className="reader-background-swatch" style={{background:settings.readerBackgroundCustom}}/><strong>{t('readerBackgroundCustomUse')}</strong></button><label className="reader-color-picker"><input type="color" value={settings.readerBackgroundCustom} onChange={(event)=>onChange({readerBackground:'custom',readerBackgroundCustom:event.target.value})}/><span>{settings.readerBackgroundCustom.toUpperCase()}</span></label></div></SettingRow>
      <SettingRow title={t('readerFontSize')} description={t('readerFontSizeDescription')}><select aria-label={t('readerFontSize')} className="reader-font-size-select" value={settings.readerFontSize} onChange={(e)=>onChange({readerFontSize:Number(e.target.value)})}><option value={15}>{t('readerFontSmall')}</option><option value={17}>{t('readerFontStandard')}</option><option value={19}>{t('readerFontLarge')}</option><option value={21}>{t('readerFontExtraLarge')}</option></select></SettingRow>
      <SettingRow title={t('readerLineHeight')} description={t('readerLineHeightDescription')}><select aria-label={t('readerLineHeight')} className="reader-line-height-select" value={settings.readerLineHeight} onChange={(e)=>onChange({readerLineHeight:Number(e.target.value)})}><option value={1.65}>{t('readerCompact')}</option><option value={1.85}>{t('readerStandard')}</option><option value={2.05}>{t('readerRelaxed')}</option></select></SettingRow>
      <SettingRow title={t('readerContentWidth')} description={t('readerContentWidthDescription')}><select aria-label={t('readerContentWidth')} className="reader-content-width-select" value={settings.readerContentWidth} onChange={(e)=>onChange({readerContentWidth:Number(e.target.value)})}><option value={680}>{t('readerWidthNarrow')}</option><option value={760}>{t('readerWidthStandard')}</option><option value={900}>{t('readerWidthWide')}</option></select></SettingRow>
    </SettingsSection>
  </>
}

function AccountsSettingsPage({syncState,onChanged}:{syncState:SyncRuntimeState|null;onChanged?:()=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation()
  const locale=i18n.resolvedLanguage?.startsWith('zh')?'zh-CN':'en-US'
  const [snapshot,setSnapshot]=useState<AccountSnapshot|null>(null)
  const [selectedId,setSelectedId]=useState<number|null>(null)
  const [status,setStatus]=useState('')
  const [adding,setAdding]=useState(false)
  const [addType,setAddType]=useState<AccountType>('local')
  const [addName,setAddName]=useState('')
  const [addServer,setAddServer]=useState('')
  const [addUsername,setAddUsername]=useState('')
  const [addPassword,setAddPassword]=useState('')
  const [addUseClientCertificate,setAddUseClientCertificate]=useState(false)
  const [addClientCertificatePassphrase,setAddClientCertificatePassphrase]=useState('')
  const reload=async()=>{
    const next=await window.origread.getAccounts()
    setSnapshot(next)
    setSelectedId((current)=>current&&next.accounts.some((item)=>item.id===current)?current:next.currentAccountId)
  }
  useEffect(()=>{void reload().catch((error)=>setStatus(errorText(error)))},[])
  const switchTo=async(id:number)=>{setStatus('');try{await window.origread.switchAccount(id);await reload();onChanged?.()}catch(error){setStatus(errorText(error))}}
  const add=async()=>{
    setAdding(true);setStatus('')
    const input:AccountCreateInput={type:addType}
    if(addName.trim())input.name=addName.trim()
    if(addType!=='local'){
      input.serverUrl=addServer.trim();input.username=addUsername.trim();input.password=addPassword
      input.useClientCertificate=addUseClientCertificate
      if(addUseClientCertificate)input.clientCertificatePassphrase=addClientCertificatePassphrase
    }
    try{
      const account=await window.origread.addAccount(input)
      await reload();setSelectedId(account.id);onChanged?.()
      setStatus(account.type==='local'?t('accountAdded'):t('accountAddedSyncing'))
      setAddName('');setAddServer('');setAddUsername('');setAddPassword('');setAddUseClientCertificate(false);setAddClientCertificatePassphrase('')
    }catch(error){setStatus(`${t('accountAddFailed')}: ${errorText(error)}`)}finally{setAdding(false)}
  }
  const selected=snapshot?.accounts.find((item)=>item.id===selectedId)??null
  return <>
    <PageIntro icon={<UserRound size={22}/>} title={t('accountsTitle')} description={t('accountsDescription')}/>
    <SettingsSection icon={<UserRound size={17}/>} title={t('accountsTitle')}>
      <div className="account-list">
        {snapshot?.accounts.map((account)=><button type="button" key={account.id} className={`account-row ${selectedId===account.id?'selected':''}`} onClick={()=>setSelectedId(account.id)}>
          <div className="settings-action-icon"><UserRound size={16}/></div>
          <div className="account-row-copy"><strong>{account.name}</strong><span>{t(accountTypeLabelKey(account.type))}{snapshot.currentAccountId===account.id?` · ${t('currentAccount')}`:''}</span></div>
          {snapshot.currentAccountId!==account.id&&<span className="mini-action" onClick={(event)=>{event.stopPropagation();void switchTo(account.id)}}>{t('switchAccount')}</span>}
          {snapshot.currentAccountId===account.id&&<span className="account-current-badge">{t('currentAccount')}</span>}
        </button>)}
      </div>
    </SettingsSection>

    {selected&&<AccountDetailsEditor key={selected.id} account={selected} isCurrent={snapshot?.currentAccountId===selected.id} accountCount={snapshot?.accounts.length??1} syncState={syncState} locale={locale} onReload={async()=>{await reload();onChanged?.()}} onStatus={setStatus}/>}

    <SettingsSection icon={<Plus size={17}/>} title={t('addAccount')}>
      <SettingRow title={t('accountType')} description={t('accountTypeDescription')}><select aria-label={t('accountType')} value={addType} onChange={(event)=>setAddType(event.target.value as AccountType)}><option value="local">Local</option><option value="fresh_rss">FreshRSS</option><option value="google_reader">Google Reader</option><option value="fever">Fever</option></select></SettingRow>
      <SettingRow title={t('accountName')} description={t('accountNameDescription')}><input aria-label={t('accountName')} value={addName} placeholder={t(accountTypeLabelKey(addType))} onChange={(event)=>setAddName(event.target.value)}/></SettingRow>
      {addType!=='local'&&<>
        <SettingRow title={t('serverUrl')} description={t('accountServerDescription')}><input aria-label={t('serverUrl')} value={addServer} placeholder={addType==='fever'?'https://example.com/api/fever.php':'https://example.com/api/greader.php/'} onChange={(event)=>setAddServer(event.target.value)}/></SettingRow>
        <SettingRow title={t('username')} description=""><input aria-label={t('username')} value={addUsername} onChange={(event)=>setAddUsername(event.target.value)}/></SettingRow>
        <SettingRow title={t('password')} description=""><input aria-label={t('password')} type="password" value={addPassword} onChange={(event)=>setAddPassword(event.target.value)}/></SettingRow>
        <SettingRow title={t('clientCertificate')} description={t('clientCertificateAddDescription')}><Toggle ariaLabel={t('clientCertificate')} checked={addUseClientCertificate} onChange={setAddUseClientCertificate}/></SettingRow>
        {addUseClientCertificate&&<SettingRow title={t('clientCertificatePassphrase')} description={t('clientCertificatePassphraseDescription')}><input aria-label={t('clientCertificatePassphrase')} type="password" value={addClientCertificatePassphrase} onChange={(event)=>setAddClientCertificatePassphrase(event.target.value)}/></SettingRow>}
      </>}
      <div className="settings-inline-actions"><button type="button" className="mini-action" disabled={adding} onClick={()=>void add()}>{adding&&<RefreshCw size={13} className="spinning"/>}{adding?t('accountValidating'):t('addAccount')}</button></div>
    </SettingsSection>
    {status&&<StatusText text={status}/>}
  </>
}

function AccountDetailsEditor({account,isCurrent,accountCount,syncState,locale,onReload,onStatus}:{account:AccountRecord;isCurrent:boolean;accountCount:number;syncState:SyncRuntimeState|null;locale:string;onReload:()=>Promise<void>;onStatus:(value:string)=>void}):React.JSX.Element{
  const {t}=useTranslation()
  const [name,setName]=useState(account.name)
  const [serverUrl,setServerUrl]=useState(account.serverUrl??'')
  const [username,setUsername]=useState(account.username??'')
  const [password,setPassword]=useState('')
  const [clientCertificatePassphrase,setClientCertificatePassphrase]=useState('')
  const [busy,setBusy]=useState<'save'|'test'|'certificate'|'clear'|'delete'|null>(null)
  const update=async(patch:AccountPatch,message?:string)=>{const next=await window.origread.updateAccount(patch);if(message)onStatus(message);await onReload();return next}
  const save=async()=>{
    setBusy('save');onStatus('')
    const patch:AccountPatch={id:account.id,name:name.trim()}
    if(account.type!=='local'){patch.serverUrl=serverUrl.trim();patch.username=username.trim();if(password)patch.password=password}
    try{await update(patch,t('accountSaved'));setPassword('')}catch(error){onStatus(`${t('accountSaveFailed')}: ${errorText(error)}`)}finally{setBusy(null)}
  }
  const test=async()=>{setBusy('test');onStatus(t('accountTesting'));try{const result=await window.origread.testAccountConnection(account.id);onStatus(result.ok?t('connectionOk'):`${t('connectionFailed')}: ${result.error??'Error'}`)}catch(error){onStatus(`${t('connectionFailed')}: ${errorText(error)}`)}finally{setBusy(null)}}
  const importCertificate=async()=>{setBusy('certificate');onStatus('');try{const result=await window.origread.importAccountClientCertificate(account.id,clientCertificatePassphrase);if(result){setClientCertificatePassphrase('');onStatus(t('clientCertificateImported'));await onReload()}}catch(error){onStatus(`${t('clientCertificateImportFailed')}: ${errorText(error)}`)}finally{setBusy(null)}}
  const clearCertificate=async()=>{setBusy('certificate');onStatus('');try{await window.origread.clearAccountClientCertificate(account.id);setClientCertificatePassphrase('');onStatus(t('clientCertificateCleared'));await onReload()}catch(error){onStatus(errorText(error))}finally{setBusy(null)}}
  const clear=async()=>{if(!window.confirm(t('confirmClearAccountArticles')))return;setBusy('clear');try{await window.origread.clearAccountArticles(account.id);onStatus(t('accountArticlesCleared'));await onReload()}catch(error){onStatus(errorText(error))}finally{setBusy(null)}}
  const remove=async()=>{if(!window.confirm(t('confirmDeleteAccount')))return;setBusy('delete');try{await window.origread.deleteAccount(account.id);onStatus(t('accountDeleted'));await onReload()}catch(error){onStatus(errorText(error))}finally{setBusy(null)}}
  return <SettingsSection icon={<Settings2 size={17}/>} title={`${t('accountDetails')} · ${account.name}`}>
    <SettingRow title={t('accountName')} description=""><input aria-label={t('accountName')} value={name} onChange={(event)=>setName(event.target.value)}/></SettingRow>
    <SettingRow title={t('accountType')} description=""><span className="setting-value">{t(accountTypeLabelKey(account.type))}</span></SettingRow>
    {account.type!=='local'&&<>
      <SettingRow title={t('serverUrl')} description=""><input aria-label={t('serverUrl')} value={serverUrl} onChange={(event)=>setServerUrl(event.target.value)}/></SettingRow>
      <SettingRow title={t('username')} description=""><input aria-label={t('username')} value={username} onChange={(event)=>setUsername(event.target.value)}/></SettingRow>
      <SettingRow title={t('password')} description={account.hasPassword?t('accountPasswordSaved'):t('accountPasswordMissing')}><input aria-label={t('password')} type="password" value={password} placeholder={t('accountPasswordKeep')} onChange={(event)=>setPassword(event.target.value)}/></SettingRow>
      <SettingRow title={t('clientCertificate')} description={account.hasClientCertificate?t('clientCertificateConfigured'):t('clientCertificateOptional')}><div className="inline-controls"><input aria-label={t('clientCertificatePassphrase')} type="password" value={clientCertificatePassphrase} placeholder={t('clientCertificatePassphrasePlaceholder')} onChange={(event)=>setClientCertificatePassphrase(event.target.value)}/><button type="button" className="mini-action" disabled={busy!==null} onClick={()=>void importCertificate()}>{busy==='certificate'&&<RefreshCw size={13} className="spinning"/>}{account.hasClientCertificate?t('replaceClientCertificate'):t('importClientCertificate')}</button>{account.hasClientCertificate&&<button type="button" className="mini-action danger" disabled={busy!==null} onClick={()=>void clearCertificate()}>{t('removeClientCertificate')}</button>}</div></SettingRow>
      <SettingRow title={t('connection')} description={t('accountConnectionDescription')}><button type="button" className="mini-action" disabled={busy!==null} onClick={()=>void test()}>{busy==='test'&&<RefreshCw size={13} className="spinning"/>}{busy==='test'?t('connectionTestingShort'):t('testConnection')}</button></SettingRow>
    </>}
    <SettingRow title={t('syncInterval')} description={t('syncIntervalDescription')}><select aria-label={t('syncInterval')} className="account-sync-interval-select" value={account.syncIntervalMinutes} onChange={(event)=>void update({id:account.id,syncIntervalMinutes:Number(event.target.value)},t('accountSaved'))}>{SYNC_INTERVAL_OPTIONS.map((minutes)=><option key={minutes} value={minutes}>{syncIntervalLabel(minutes,t)}</option>)}</select></SettingRow>
    <SettingRow title={t('syncOnStart')} description={t('syncOnStartDescription')}><Toggle ariaLabel={t('syncOnStart')} checked={account.syncOnStart} onChange={(value)=>void update({id:account.id,syncOnStart:value},t('accountSaved'))}/></SettingRow>
    <SettingRow title={t('syncOnlyOnWiFi')} description={t('desktopWifiConstraintDescription')}><Toggle ariaLabel={t('syncOnlyOnWiFi')} checked={account.syncOnlyOnWiFi} onChange={(value)=>void update({id:account.id,syncOnlyOnWiFi:value},t('accountSaved'))}/></SettingRow>
    <SettingRow title={t('syncOnlyWhenCharging')} description={t('desktopChargingConstraintDescription')}><Toggle ariaLabel={t('syncOnlyWhenCharging')} checked={account.syncOnlyWhenCharging} onChange={(value)=>void update({id:account.id,syncOnlyWhenCharging:value},t('accountSaved'))}/></SettingRow>
    <SettingRow title={t('keepArchivedArticles')} description={t('keepArchivedDescription')}><select aria-label={t('keepArchivedArticles')} value={account.keepArchivedMillis} onChange={(event)=>void update({id:account.id,keepArchivedMillis:Number(event.target.value)},t('accountSaved'))}>{KEEP_ARCHIVED_OPTIONS.map((option)=><option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}</select></SettingRow>
    {isCurrent&&<div className="sync-runtime-card"><div><span>{t('syncStatus')}</span><strong>{syncState?.running?t('syncRunning'):t('syncIdle')}</strong></div><div><span>{t('lastSync')}</span><strong>{formatDate(account.updatedAt??syncState?.lastFinishedAt,t('never'),locale)}</strong></div><div><span>{t('nextSync')}</span><strong>{formatDate(syncState?.nextRunAt,t('manualOnly'),locale)}</strong></div></div>}
    <div className="settings-inline-actions"><button type="button" className="mini-action" disabled={busy!==null} onClick={()=>void save()}>{busy==='save'&&<RefreshCw size={13} className="spinning"/>}<Save size={13}/>{t('save')}</button><button type="button" className="mini-action danger" disabled={busy!==null} onClick={()=>void clear()}>{t('clearAccountArticles')}</button>{accountCount>1&&<button type="button" className="mini-action danger" disabled={busy!==null} onClick={()=>void remove()}><Trash2 size={13}/>{t('deleteAccount')}</button>}</div>
  </SettingsSection>
}

function accountTypeLabelKey(type:AccountType):string{return type==='local'?'accountTypeLocal':type==='fresh_rss'?'accountTypeFreshRSS':type==='google_reader'?'accountTypeGoogleReader':'accountTypeFever'}

const KEEP_ARCHIVED_OPTIONS = [
  { value: 0, labelKey: 'keepArchivedAlways' },
  { value: 86_400_000, labelKey: 'keepArchived1Day' },
  { value: 172_800_000, labelKey: 'keepArchived2Days' },
  { value: 259_200_000, labelKey: 'keepArchived3Days' },
  { value: 604_800_000, labelKey: 'keepArchived1Week' },
  { value: 1_209_600_000, labelKey: 'keepArchived2Weeks' },
  { value: 2_592_000_000, labelKey: 'keepArchived1Month' }
] as const

function UpdateSettingsPage({settings,appInfo,onChange}:{settings:DesktopSettings;appInfo:AppInfo|null;onChange:(patch:DesktopSettingsPatch)=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation()
  const [result,setResult]=useState<UpdateCheckResult|null>(null)
  const [checking,setChecking]=useState(false)
  const [downloading,setDownloading]=useState(false)
  const [downloadPath,setDownloadPath]=useState<string|null>(null)
  const [status,setStatus]=useState('')
  const language:i18nLanguage=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  useEffect(()=>{let cancelled=false;void window.origread.getUpdateState().then((value)=>{if(!cancelled)setResult(value)}).catch((error)=>{if(!cancelled)setStatus(errorText(error))});return()=>{cancelled=true}},[])
  const check=async()=>{setChecking(true);setStatus('');try{setResult(await window.origread.checkForUpdates(language))}catch(error){setStatus(errorText(error))}finally{setChecking(false)}}
  const download=async()=>{const asset=result?.release?.asset;if(!asset)return;setDownloading(true);setStatus('');try{const value=await window.origread.downloadUpdateAsset(asset.id);if(value.error){setStatus(`${t('updateDownloadFailed')}: ${value.error}`);return}if(value.path){setDownloadPath(value.path);setStatus(`${t('downloadUpdateSuccess')}: ${value.path}`)}}catch(error){setStatus(`${t('updateDownloadFailed')}: ${errorText(error)}`)}finally{setDownloading(false)}}
  const install=async()=>{setStatus('');try{await window.origread.launchDownloadedUpdate()}catch(error){setStatus(errorText(error))}}
  const release=result?.release
  return <>
    <PageIntro icon={<RefreshCw size={22}/>} title={t('softwareUpdate')} description={t('softwareUpdateDescription')}/>
    <SettingsSection icon={<RefreshCw size={17}/>} title={t('softwareUpdate')}>
      <SettingRow title={t('autoCheckUpdates')} description={t('autoCheckUpdatesDescription')}><Toggle ariaLabel={t('autoCheckUpdates')} checked={settings.autoCheckUpdates} onChange={(value)=>onChange({autoCheckUpdates:value})}/></SettingRow>
      <SettingRow title={t('checkUpdatesNow')} description={`${t('currentVersion')}: v${appInfo?.version??'—'}`}><button type="button" className="mini-action update-check-button" disabled={checking} onClick={()=>void check()}>{checking&&<RefreshCw size={13} className="spinning"/>}{checking?t('checkingUpdates'):t('checkUpdatesNow')}</button></SettingRow>
      <SettingRow title={t('mainlandUpdateOptimization')} description={t('mainlandUpdateOptimizationDescription')}><span className="setting-value">{t('automatic')}</span></SettingRow>
    </SettingsSection>
    {(result||status)&&<SettingsSection icon={<FileText size={17}/>} title={t('softwareUpdate')}>
      {result&&<div className={`update-status-card status-${result.status}`}>
        <div className="update-status-heading"><strong>{updateStatusTitle(result,t)}</strong><span>{result.checkedAt?new Date(result.checkedAt).toLocaleString():''}</span></div>
        {result.errorCode&&<p>{updateErrorDescription(result,t)}</p>}
        {release&&<>
          <div className="update-release-meta"><span><b>v{release.version}</b>{release.title&&release.title!==release.tagName?` · ${release.title}`:''}</span><span>{t('releaseDate')}: {release.publishedDate||'—'}</span></div>
          {release.notes&&<div className="update-release-notes"><strong>{t('releaseNotes')}</strong><div className="update-release-notes-surface"><MarkdownContent text={release.notes}/></div></div>}
          <div className="update-release-asset"><strong>{t('releaseAsset')}</strong>{release.asset?<span>{release.asset.name} · {formatBytes(release.asset.size)}</span>:<span>{t('noPlatformAsset')}</span>}</div>
          <div className="update-release-actions">
            {release.asset&&result.status==='available'&&<button type="button" className="dialog-submit" disabled={downloading} onClick={()=>void download()}>{downloading&&<RefreshCw size={14} className="spinning"/>}{downloading?t('downloadingUpdate'):t('downloadUpdate')}</button>}
            {downloadPath&&<button type="button" className="mini-action" onClick={()=>void install()}>{t('installUpdate')}</button>}
            <button type="button" className="mini-action" onClick={()=>void window.origread.openExternalUrl(release.releasePageUrl)}>{t('openReleasePage')}</button>
          </div>
        </>}
      </div>}
      {status&&<StatusText text={status}/>}
    </SettingsSection>}
  </>
}

function AboutAndSupportPage({appInfo,onOpenUpdate}:{appInfo:AppInfo|null;onOpenUpdate:()=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation()
  const [userGuide,setUserGuide]=useState<string|null>(null)
  const language:'zh'|'en'=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  const shortcuts=[
    ['← / K',t('shortcutPreviousArticle')],
    ['→ / J',t('shortcutNextArticle')],
    ['↑',t('shortcutScrollUp')],
    ['↓',t('shortcutScrollDown')],
    ['M',t('shortcutToggleRead')],
    ['S',t('shortcutToggleStar')],
    ['U',t('shortcutOriginal')],
    ['A',t('shortcutAiAssistant')],
    ['[',t('shortcutSidebar')],
    ['<',t('shortcutSummaryPlacementPrevious')],
    ['>',t('shortcutSummaryPlacementNext')],
    ['-',t('shortcutSummarySizeDecrease')],
    ['+',t('shortcutSummarySizeIncrease')],
    ['Ctrl / Cmd + F',t('findInArticle')],
    ['Ctrl / Cmd + Shift + F',t('globalSearchTitle')]
  ] as const
  return <div className="about-page">
    <PageIntro icon={<img className="about-brand-logo" src="./logo.png" alt=""/>} title={t('aboutPageTitle')} description={t('aboutPageDescription')}/>

    <section className="about-client-card" aria-label={t('currentDesktopClient')}>
      <div className="about-client-main">
        <img className="about-client-logo" src="./logo.png" alt=""/>
        <div>
          <strong>OrigRead Desktop</strong>
          <span>{t('desktopClientDescription')}</span>
        </div>
      </div>
      <div className="about-client-meta">
        <span className="about-badge">v{appInfo?.version??'—'}</span>
        <span className="about-badge subtle">{appInfo?.platform??'—'}</span>
      </div>
      <div className="about-client-actions">
        <button type="button" className="mini-action" onClick={onOpenUpdate}><RefreshCw size={13}/>{t('checkUpdatesNow')}</button>
        <button type="button" className="mini-action secondary" onClick={()=>void window.origread.openExternalUrl(DESKTOP_RELEASES_URL)}><ExternalLink size={13}/>{t('viewReleases')}</button>
      </div>
    </section>

    <SettingsSection icon={<Globe2 size={17}/>} title={t('projectRepositories')}>
      <AboutLinkRow icon={<Monitor size={16}/>} title={t('desktopProject')} description={t('desktopProjectDescription')} actionLabel={t('visitRepository')} onClick={()=>void window.origread.openExternalUrl(DESKTOP_REPOSITORY_URL)}/>
      <AboutLinkRow icon={<Smartphone size={16}/>} title={t('androidProject')} description={t('androidProjectDescription')} actionLabel={t('visitRepository')} onClick={()=>void window.origread.openExternalUrl(ANDROID_REPOSITORY_URL)}/>
    </SettingsSection>

    <SettingsSection icon={<CircleHelp size={17}/>} title={t('supportAndHelp')}>
      <div className="about-shortcuts">
        <div className="about-shortcuts-heading"><div className="settings-action-icon"><Keyboard size={16}/></div><div><strong>{t('keyboardShortcuts')}</strong><span>{t('keyboardShortcutsDescription')}</span></div></div>
        <div className="about-shortcut-grid">{shortcuts.map(([key,label])=><div className="about-shortcut" key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div>
      </div>
      <AboutLinkRow icon={<BookOpenText size={16}/>} title={t('userGuide')} description={t('userGuideDescription')} actionLabel={t('openGuide')} onClick={()=>void window.origread.getUserGuide(language).then(setUserGuide).catch((error)=>window.alert(errorText(error)))}/>
      <AboutLinkRow icon={<MessageSquareWarning size={16}/>} title={t('feedbackAndIssues')} description={t('feedbackAndIssuesDescription')} actionLabel={t('submitIssue')} onClick={()=>void window.origread.openExternalUrl(DESKTOP_ISSUES_URL)}/>
    </SettingsSection>
    {userGuide!==null&&<RuleModal title={t('userGuide')} onClose={()=>setUserGuide(null)}><MarkdownContent text={userGuide}/></RuleModal>}
  </div>
}

function AboutLinkRow({icon,title,description,actionLabel,onClick}:{icon:React.ReactNode;title:string;description:string;actionLabel:string;onClick:()=>void}):React.JSX.Element{
  return <div className="about-link-row">
    <div className="settings-action-icon">{icon}</div>
    <div className="about-link-copy"><strong>{title}</strong><span>{description}</span></div>
    <button type="button" className="mini-action about-link-action" onClick={onClick}><ExternalLink size={13}/>{actionLabel}</button>
  </div>
}

type i18nLanguage='zh'|'en'
function updateStatusTitle(result:UpdateCheckResult,t:(key:string)=>string):string{return result.status==='available'?t('updateAvailable'):result.status==='latest'?t('latestVersion'):result.status==='unavailable'?t('updateUnavailable'):t('updateNetworkError')}
function updateErrorDescription(result:UpdateCheckResult,t:(key:string)=>string):string{switch(result.errorCode){case'REPOSITORY_UNAVAILABLE':return t('updateRepositoryPrivate');case'RATE_LIMITED':return t('updateRateLimited');case'INVALID_RESPONSE':return t('updateInvalidResponse');case'DISABLED':return t('updateDisabledForTest');default:return t('updateNetworkError')}}
function formatBytes(value:number):string{if(value<1024)return`${value} B`;if(value<1024*1024)return`${(value/1024).toFixed(1)} KB`;return`${(value/1024/1024).toFixed(1)} MB`}

function AiSettingsPage({onUnsavedChange}:{onUnsavedChange?:(dirty:boolean)=>void}):React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<AiSettings|null>(null)
  const [view,setView]=useState<'reading'|'providers'|'search'|'behavior'>('reading')
  const [selectedProviderId,setSelectedProviderId]=useState<string|null>(null)
  const [keys,setKeys]=useState<Record<string,string>>({})
  const [dirtyKeys,setDirtyKeys]=useState<Record<string,boolean>>({})
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({})
  const [status,setStatus]=useState('')
  const [providerStatus,setProviderStatus]=useState<Record<string,string>>({})
  const [testingProviders,setTestingProviders]=useState<Record<string,boolean>>({})

  useEffect(()=>{
    let cancelled=false
    void (async()=>{
      try{
        const loaded=await window.origread.getAiSettings()
        if(cancelled)return
        setSettings(loaded)
        setSelectedProviderId(loaded.defaultProviderId||loaded.providers[0]?.id||null)
      }catch(error){if(!cancelled)setStatus(errorText(error))}
    })()
    return()=>{cancelled=true}
  },[])

  const updateGlobal=async(patch:Parameters<typeof window.origread.updateAiSettings>[0])=>{setSettings(await window.origread.updateAiSettings(patch))}
  const updateProvider=async(provider:AiProviderProfile,patch:Record<string,unknown>)=>{setSettings(await window.origread.updateAiProvider({id:provider.id,...patch}))}
  const clearTransientKeys=()=>{setKeys({});setDirtyKeys({});setVisibleKeys({})}
  const toggleKey=async(provider:AiProviderProfile)=>{
    const id=provider.id
    if(visibleKeys[id]){
      setVisibleKeys((current)=>({...current,[id]:false}))
      if(!dirtyKeys[id])setKeys((current)=>withoutKey(current,id))
      return
    }
    if(dirtyKeys[id]){
      setVisibleKeys((current)=>({...current,[id]:true}))
      return
    }
    if(!provider.hasApiKey)return
    try{
      const revealed=await window.origread.revealAiApiKey(id)
      setKeys((current)=>({...current,[id]:revealed}))
      setVisibleKeys((current)=>({...current,[id]:true}))
    }catch(error){
      setProviderStatus((current)=>({...current,[id]:errorText(error)}))
    }
  }
  const saveKey=async(provider:AiProviderProfile)=>{
    try{
      const draft=keys[provider.id]??''
      const next=await window.origread.updateAiProvider({id:provider.id,apiKey:draft})
      const saved=next.providers.find((item)=>item.id===provider.id)
      setSettings(next)
      setKeys((value)=>withoutKey(value,provider.id))
      setDirtyKeys((value)=>withoutKey(value,provider.id))
      setVisibleKeys((value)=>withoutKey(value,provider.id))
      setProviderStatus((value)=>({...value,[provider.id]:saved?.hasApiKey?t('credentialSaved',{count:saved.apiKeyLength}):t('credentialRemoved')}))
    }catch(error){setProviderStatus((value)=>({...value,[provider.id]:`${t('credentialSaveFailed')}: ${errorText(error)}`}))}
  }
  const testProvider=async(providerId:string)=>{
    setTestingProviders((value)=>({...value,[providerId]:true}))
    setProviderStatus((value)=>({...value,[providerId]:t('connectionTesting')}))
    try{
      const result=await window.origread.testAiProvider(providerId)
      setProviderStatus((value)=>({...value,[providerId]:result.ok?t('connectionOk'):`${t('connectionFailed')}: ${result.error??'Error'}`}))
    }catch(error){
      setProviderStatus((value)=>({...value,[providerId]:`${t('connectionFailed')}: ${errorText(error)}`}))
    }finally{
      setTestingProviders((value)=>({...value,[providerId]:false}))
    }
  }
  if(!settings)return <LoadingSettings/>
  const defaultProvider=settings.providers.find((provider)=>provider.id===settings.defaultProviderId)??settings.providers[0]??null
  const selectedProvider=settings.providers.find((provider)=>provider.id===selectedProviderId)??defaultProvider
  const tabs=[
    ['reading','aiTabReading',<BookOpenText size={15}/>],
    ['providers','aiTabProviders',<Bot size={15}/>],
    ['search','aiTabSearch',<Search size={15}/>],
    ['behavior','aiTabBehavior',<Sparkles size={15}/>]
  ] as const
  const addProvider=async()=>{
    const before=new Set(settings.providers.map((provider)=>provider.id))
    const next=await window.origread.addAiProvider()
    setSettings(next)
    const added=next.providers.find((provider)=>!before.has(provider.id))??next.providers.at(-1)??null
    setSelectedProviderId(added?.id??null)
  }
  const removeProvider=async(provider:AiProviderProfile)=>{
    if(!window.confirm(t('aiProviderDeleteConfirm',{name:provider.name})))return
    const next=await window.origread.removeAiProvider(provider.id)
    setSettings(next)
    setSelectedProviderId(next.defaultProviderId||next.providers[0]?.id||null)
    setKeys((value)=>withoutKey(value,provider.id));setDirtyKeys((value)=>withoutKey(value,provider.id));setVisibleKeys((value)=>withoutKey(value,provider.id))
  }
  return <div className="ai-settings-page"><PageIntro icon={<Bot size={22}/>} title={t('aiSettingsTitle')} description={t('aiSettingsDescription')}/>
    <div className="ai-settings-tabs" role="tablist" aria-label={t('aiSettingsTitle')}>{tabs.map(([id,label,icon])=><button type="button" role="tab" aria-selected={view===id} className={view===id?'active':''} key={id} onClick={()=>setView(id)}>{icon}<span>{t(label)}</span></button>)}</div>
    {view==='reading'&&<><div className="ai-settings-summary-card"><div className="ai-settings-summary-icon"><Sparkles size={18}/></div><div><span>{t('aiCurrentDefault')}</span><strong>{defaultProvider?`${defaultProvider.name}${defaultProvider.defaultModel?` · ${defaultProvider.defaultModel}`:''}`:t('notConfigured')}</strong></div><button type="button" className="mini-action" onClick={()=>{setSelectedProviderId(defaultProvider?.id??null);setView('providers')}}>{t('aiManage')}</button></div>
    <SettingsSection icon={<BookOpenText size={17}/>} title={t('aiReadingDefaults')}>
      <SettingRow title={t('aiEnabled')} description={t('aiEnabledDescription')}><Toggle ariaLabel={t('aiEnabled')} checked={settings.enabled} onChange={(v)=>void updateGlobal({enabled:v})}/></SettingRow>
      <SettingRow title={t('aiDefaultModel')} description={t('aiDefaultModelDescription')}><div className="ai-default-model-picker"><select aria-label={t('aiDefaultProvider')} value={defaultProvider?.id??''} onChange={(e)=>{clearTransientKeys();setSelectedProviderId(e.target.value);void updateGlobal({defaultProviderId:e.target.value})}}>{settings.providers.filter((provider)=>provider.enabled).map((provider)=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><select aria-label={t('aiModel')} value={defaultProvider?.defaultModel??''} disabled={!defaultProvider} onChange={(e)=>{if(defaultProvider)void updateProvider(defaultProvider,{defaultModel:e.target.value})}}><option value="">{t('selectModel')}</option>{defaultProvider?.models.map((model)=><option key={model} value={model}>{model}</option>)}</select></div></SettingRow>
      <SettingRow title={t('aiOutputLanguage')} description={t('aiOutputLanguageDescription')}><input aria-label={t('aiOutputLanguage')} value={settings.outputLanguage} onChange={(e)=>void updateGlobal({outputLanguage:e.target.value})}/></SettingRow>
      <SettingRow title={t('aiSummaryLength')} description={t('aiSummaryLengthDescription')}><div className="summary-mode-selector compact">{([
        ['BRIEF','summaryModeQuick'],['STANDARD','summaryModeBalanced'],['DETAILED','summaryModeDeep']
      ] as const).map(([value,labelKey])=><button type="button" key={value} title={t(summaryLengthDescriptionKey(value))} className={`summary-mode-option ${settings.summaryLength===value?'selected':''}`} onClick={()=>void updateGlobal({summaryLength:value})}><strong>{t(labelKey)}</strong></button>)}</div></SettingRow>
    </SettingsSection>
    </>}
    {view==='behavior'&&<><LlmCustomizationSettingsSections onUnsavedChange={onUnsavedChange}/><RemoteMcpSettingsSection/><LocalMcpSettingsSection/></>}
    {view==='search'&&<WebSearchSettingsSection/>}
    {view==='providers'&&<section className="ai-provider-workspace">
      <header className="ai-provider-workspace-head"><div><h2>{t('aiProviders')}</h2><p>{t('aiProvidersDescription')}</p></div><button type="button" className="mini-action icon-only" title={`${t('add')}: ${t('aiProviders')}`} aria-label={`${t('add')}: ${t('aiProviders')}`} onClick={()=>void addProvider()}><Plus size={14}/></button></header>
      <div className="ai-provider-workspace-body">
        <div className="ai-provider-list" role="listbox" aria-label={t('aiProviders')}>
          {settings.providers.map((provider)=><button type="button" role="option" aria-selected={selectedProvider?.id===provider.id} className={`ai-provider-list-item ${selectedProvider?.id===provider.id?'selected':''}`} key={provider.id} onClick={()=>setSelectedProviderId(provider.id)}><span className={`ai-provider-state-dot ${provider.enabled?'enabled':''}`}/><span className="ai-provider-list-copy"><strong>{provider.name}</strong><small>{provider.defaultModel||t('aiNoModelSelected')}</small></span>{settings.defaultProviderId===provider.id&&<span className="ai-provider-default-badge">{t('aiDefaultBadge')}</span>}</button>)}
        </div>
        {selectedProvider&&(()=>{const provider=selectedProvider;const dirty=dirtyKeys[provider.id]===true;const testing=testingProviders[provider.id]===true;return <div className="ai-provider-detail">
          <div className="ai-provider-detail-head"><div><input className="provider-name ai-provider-detail-name" value={provider.name} aria-label={t('aiProviderName')} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((item)=>item.id===provider.id?{...item,name:e.target.value}:item)})} onBlur={()=>void updateProvider(provider,{name:settings.providers.find((item)=>item.id===provider.id)!.name})}/><span>{provider.enabled?t('aiProviderEnabled'):t('aiProviderDisabled')}</span></div><div className="inline-controls">{settings.defaultProviderId!==provider.id&&<button type="button" className="mini-action secondary" disabled={!provider.enabled} onClick={()=>void updateGlobal({defaultProviderId:provider.id})}>{t('aiSetDefault')}</button>}<Toggle ariaLabel={provider.name} checked={provider.enabled} onChange={(v)=>void updateProvider(provider,{enabled:v})}/>{settings.providers.length>1&&<button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void removeProvider(provider)}><Trash2 size={15}/></button>}</div></div>
          <div className="ai-provider-form">
            <label className="ai-provider-form-field"><span><strong>{t('aiProviderEndpoint')}</strong><small>{t('aiProviderEndpointDescription')}</small></span><input value={provider.endpoint} spellCheck={false} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((item)=>item.id===provider.id?{...item,endpoint:e.target.value}:item)})} onBlur={()=>void updateProvider(provider,{endpoint:settings.providers.find((item)=>item.id===provider.id)!.endpoint})}/></label>
            <label className="ai-provider-form-field"><span><strong>API Key</strong><small>{t('aiProviderKeyDescription')}</small></span><AiSecretKeyEditor value={keys[provider.id]??''} hasStoredValue={provider.hasApiKey} storedLength={provider.apiKeyLength} dirty={dirty} visible={visibleKeys[provider.id]===true} onChange={(value)=>{setKeys((current)=>({...current,[provider.id]:value}));setDirtyKeys((current)=>({...current,[provider.id]:true}))}} onToggle={()=>void toggleKey(provider)} onSave={()=>void saveKey(provider)}/></label>
            <label className="ai-provider-form-field"><span><strong>{t('aiModel')}</strong><small>{t('aiProviderModelDescription')}</small></span><div className="inline-controls ai-provider-model-row"><select value={provider.defaultModel} onChange={(e)=>void updateProvider(provider,{defaultModel:e.target.value})}><option value="">{t('selectModel')}</option>{provider.models.map((model)=><option key={model} value={model}>{model}</option>)}</select><button type="button" className="mini-action" onClick={async()=>{try{const models=await window.origread.refreshAiModels(provider.id,dirty?keys[provider.id]:undefined);setSettings(await window.origread.getAiSettings());setProviderStatus((value)=>({...value,[provider.id]:t('modelsLoaded',{count:models.length})}))}catch(error){setProviderStatus((value)=>({...value,[provider.id]:errorText(error)}))}}}><RefreshCw size={13}/>{t('loadModels')}</button></div></label>
          </div>
          <div className="ai-provider-detail-actions"><button type="button" className="mini-action" disabled={dirty||testing||!provider.enabled} title={dirty?t('saveCredentialFirst'):undefined} onClick={()=>void testProvider(provider.id)}>{testing&&<RefreshCw size={13} className="spinning"/>}{testing?t('connectionTestingShort'):t('testConnection')}</button><span>{provider.hasApiKey?t('aiProviderCredentialReady'):t('aiProviderCredentialMissing')}</span></div>
          {providerStatus[provider.id]&&<StatusText text={providerStatus[provider.id]!}/>}
        </div>})()}
      </div>
    </section>}
    {status&&<StatusText text={status}/>} </div>
}

function WebSearchSettingsSection():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<WebSearchSettings|null>(null)
  const [addKind,setAddKind]=useState<WebSearchProviderKind>('TAVILY')
  const [keys,setKeys]=useState<Record<string,string>>({})
  const [dirtyKeys,setDirtyKeys]=useState<Record<string,boolean>>({})
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({})
  const [providerStatus,setProviderStatus]=useState<Record<string,string>>({})
  const [testingProviders,setTestingProviders]=useState<Record<string,boolean>>({})
  const [status,setStatus]=useState('')

  useEffect(()=>{
    let cancelled=false
    void window.origread.getWebSearchSettings()
      .then((value)=>{if(!cancelled)setSettings(value)})
      .catch((error)=>{if(!cancelled)setStatus(errorText(error))})
    return()=>{cancelled=true}
  },[])

  const updateSettings=async(patch:Parameters<typeof window.origread.updateWebSearchSettings>[0])=>{
    try{setSettings(await window.origread.updateWebSearchSettings(patch));setStatus('')}catch(error){setStatus(errorText(error))}
  }
  const updateProvider=async(provider:WebSearchProviderProfile,patch:Omit<Parameters<typeof window.origread.updateWebSearchProvider>[0],'id'>)=>{
    try{setSettings(await window.origread.updateWebSearchProvider({id:provider.id,...patch}));setProviderStatus((current)=>({...current,[provider.id]:''}))}catch(error){setProviderStatus((current)=>({...current,[provider.id]:errorText(error)}))}
  }
  const addProvider=async()=>{
    try{setSettings(await window.origread.addWebSearchProvider(addKind));setStatus('')}catch(error){setStatus(errorText(error))}
  }
  const removeProvider=async(providerId:string)=>{
    if(!window.confirm(t('webSearchDeleteProviderConfirm')))return
    try{
      setSettings(await window.origread.removeWebSearchProvider(providerId))
      setKeys((current)=>withoutKey(current,providerId));setDirtyKeys((current)=>withoutKey(current,providerId));setVisibleKeys((current)=>withoutKey(current,providerId));setProviderStatus((current)=>withoutKey(current,providerId))
    }catch(error){setStatus(errorText(error))}
  }
  const toggleKey=async(provider:WebSearchProviderProfile)=>{
    const id=provider.id
    if(visibleKeys[id]){
      setVisibleKeys((current)=>({...current,[id]:false}))
      if(!dirtyKeys[id])setKeys((current)=>withoutKey(current,id))
      return
    }
    if(dirtyKeys[id]){setVisibleKeys((current)=>({...current,[id]:true}));return}
    if(!provider.hasApiKey)return
    try{
      const revealed=await window.origread.revealWebSearchApiKey(id)
      setKeys((current)=>({...current,[id]:revealed}));setVisibleKeys((current)=>({...current,[id]:true}))
    }catch(error){setProviderStatus((current)=>({...current,[id]:errorText(error)}))}
  }
  const saveKey=async(provider:WebSearchProviderProfile)=>{
    try{
      const next=await window.origread.updateWebSearchProvider({id:provider.id,apiKey:keys[provider.id]??''})
      const saved=next.providers.find((item)=>item.id===provider.id)
      setSettings(next);setKeys((current)=>withoutKey(current,provider.id));setDirtyKeys((current)=>withoutKey(current,provider.id));setVisibleKeys((current)=>withoutKey(current,provider.id))
      setProviderStatus((current)=>({...current,[provider.id]:saved?.hasApiKey?t('credentialSaved',{count:saved.apiKeyLength}):t('credentialRemoved')}))
    }catch(error){setProviderStatus((current)=>({...current,[provider.id]:`${t('credentialSaveFailed')}: ${errorText(error)}`}))}
  }
  const testProvider=async(provider:WebSearchProviderProfile)=>{
    setTestingProviders((current)=>({...current,[provider.id]:true}));setProviderStatus((current)=>({...current,[provider.id]:t('webSearchTesting')}))
    try{
      const result=await window.origread.testWebSearchProvider(provider.id)
      setProviderStatus((current)=>({...current,[provider.id]:result.ok&&result.result?t('webSearchHealthOk',{latency:result.result.latencyMs,count:result.result.resultCount}):`${t('connectionFailed')}: ${result.error??'Error'}`}))
    }catch(error){setProviderStatus((current)=>({...current,[provider.id]:`${t('connectionFailed')}: ${errorText(error)}`}))}finally{setTestingProviders((current)=>({...current,[provider.id]:false}))}
  }

  if(!settings)return <SettingsSection icon={<Search size={17}/>} title={t('webSearchTitle')}><LoadingSettings/></SettingsSection>
  const enabledProviders=settings.providers.filter((provider)=>provider.enabled)
  return <SettingsSection icon={<Search size={17}/>} title={t('webSearchTitle')}>
    <SettingRow title={t('webSearchMode')} description={t('webSearchModeDescription')}><select aria-label={t('webSearchMode')} value={settings.mode} onChange={(event)=>void updateSettings({mode:event.target.value as WebSearchSettings['mode']})}><option value="AUTO">{t('webSearchModeAuto')}</option><option value="OFF">{t('webSearchModeOff')}</option></select></SettingRow>
    <SettingRow title={t('webSearchDefaultProvider')} description={t('webSearchDefaultProviderDescription')}><select aria-label={t('webSearchDefaultProvider')} value={settings.defaultProviderId??''} disabled={enabledProviders.length===0} onChange={(event)=>void updateSettings({defaultProviderId:event.target.value||null})}><option value="">{t('webSearchNoProvider')}</option>{enabledProviders.map((provider)=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></SettingRow>
    <SettingRow title={t('webSearchResultLimit')} description={t('webSearchResultLimitDescription')}><select aria-label={t('webSearchResultLimit')} value={settings.maxResults} onChange={(event)=>void updateSettings({maxResults:Number(event.target.value)})}>{[3,5,8,10,15,20].map((value)=><option key={value} value={value}>{value}</option>)}</select></SettingRow>
    <div className="llm-settings-toolbar web-search-toolbar"><div><strong>{t('webSearchProviders')}</strong><span>{t('webSearchProvidersDescription')}</span></div><div className="inline-controls"><select aria-label={t('webSearchProvider')} className="web-search-kind-select" value={addKind} onChange={(event)=>setAddKind(event.target.value as WebSearchProviderKind)}>{WEB_SEARCH_PROVIDER_KINDS.map((kind)=><option key={kind} value={kind}>{webSearchProviderDefinition(kind).defaultName}</option>)}</select><button type="button" className="mini-action icon-only" title={`${t('add')}: ${webSearchProviderDefinition(addKind).defaultName}`} aria-label={`${t('add')}: ${webSearchProviderDefinition(addKind).defaultName}`} onClick={()=>void addProvider()}><Plus size={13}/></button></div></div>
    <div className="web-search-provider-list">
      {settings.providers.length?settings.providers.map((provider)=>{const dirty=dirtyKeys[provider.id]===true;const testing=testingProviders[provider.id]===true;const definition=webSearchProviderDefinition(provider.kind);return <section className="provider-card web-search-provider-card" key={provider.id}>
        <div className="provider-card-head"><label className="provider-default-radio" title={t('webSearchSetDefault')}><input type="radio" name="web-search-default-provider" aria-label={`${t('webSearchSetDefault')}: ${provider.name}`} checked={settings.defaultProviderId===provider.id} disabled={!provider.enabled} onChange={()=>void updateSettings({defaultProviderId:provider.id})}/><span/></label><div className="provider-card-title"><input className="provider-name" value={provider.name} onChange={(event)=>setSettings({...settings,providers:settings.providers.map((item)=>item.id===provider.id?{...item,name:event.target.value}:item)})} onBlur={()=>void updateProvider(provider,{name:settings.providers.find((item)=>item.id===provider.id)!.name})}/><span>{definition.defaultName}</span></div><Toggle ariaLabel={provider.name} checked={provider.enabled} onChange={(value)=>void updateProvider(provider,{enabled:value})}/><button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void removeProvider(provider.id)}><Trash2 size={14}/></button></div>
        <Field label="Endpoint"><input value={provider.endpoint} onChange={(event)=>setSettings({...settings,providers:settings.providers.map((item)=>item.id===provider.id?{...item,endpoint:event.target.value}:item)})} onBlur={()=>void updateProvider(provider,{endpoint:settings.providers.find((item)=>item.id===provider.id)!.endpoint})}/></Field>
        {definition.supportsApiKey&&<Field label={definition.requiresApiKey?'API Key':`API Key · ${t('optional')}`}><AiSecretKeyEditor value={keys[provider.id]??''} hasStoredValue={provider.hasApiKey} storedLength={provider.apiKeyLength} dirty={dirty} visible={visibleKeys[provider.id]===true} onChange={(value)=>{setKeys((current)=>({...current,[provider.id]:value}));setDirtyKeys((current)=>({...current,[provider.id]:true}))}} onToggle={()=>void toggleKey(provider)} onSave={()=>void saveKey(provider)}/></Field>}
        <div className="web-search-provider-actions"><button type="button" className="mini-action" disabled={dirty||testing||!provider.enabled} title={dirty?t('saveCredentialFirst'):undefined} onClick={()=>void testProvider(provider)}>{testing&&<RefreshCw size={13} className="spinning"/>}{testing?t('connectionTestingShort'):t('testConnection')}</button></div>
        {providerStatus[provider.id]&&<StatusText text={providerStatus[provider.id]!}/>}
      </section>}):<div className="llm-settings-empty">{t('webSearchProvidersEmpty')}</div>}
    </div>
    {status&&<StatusText text={status}/>}
  </SettingsSection>
}

function RemoteMcpSettingsSection():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<McpRemoteSettings|null>(null)
  const [catalog,setCatalog]=useState<McpToolCatalogSnapshot>({servers:[]})
  const [connections,setConnections]=useState<Record<string,McpConnectionSnapshot>>({})
  const [credentials,setCredentials]=useState<Record<string,string>>({})
  const [dirtyCredentials,setDirtyCredentials]=useState<Record<string,boolean>>({})
  const [visibleCredentials,setVisibleCredentials]=useState<Record<string,boolean>>({})
  const [busyServers,setBusyServers]=useState<Record<string,boolean>>({})
  const [serverStatus,setServerStatus]=useState<Record<string,string>>({})
  const [status,setStatus]=useState('')

  const reloadConnections=async()=>{
    const states=await window.origread.getMcpConnectionStates()
    setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
  }

  useEffect(()=>{
    let cancelled=false
    void Promise.all([window.origread.getMcpRemoteSettings(),window.origread.getMcpConnectionStates(),window.origread.getMcpToolCatalog()])
      .then(([loaded,states,loadedCatalog])=>{
        if(cancelled)return
        setSettings(loaded)
        setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
        setCatalog(loadedCatalog)
      })
      .catch((error)=>{if(!cancelled)setStatus(errorText(error))})
    return()=>{cancelled=true}
  },[])

  const addServer=async()=>{
    try{setSettings(await window.origread.addMcpRemoteServer());setStatus('')}catch(error){setStatus(errorText(error))}
  }
  const updateServer=async(server:McpRemoteServerProfile,patch:Omit<Parameters<typeof window.origread.updateMcpRemoteServer>[0],'id'>)=>{
    try{
      setSettings(await window.origread.updateMcpRemoteServer({id:server.id,...patch}))
      const [states,nextCatalog]=await Promise.all([window.origread.getMcpConnectionStates(),window.origread.getMcpToolCatalog()])
      setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
      setCatalog(nextCatalog)
      setStatus('')
    }catch(error){setStatus(errorText(error))}
  }
  const removeServer=async(server:McpRemoteServerProfile)=>{
    if(!window.confirm(t('mcpDeleteConfirm',{name:server.name})))return
    try{
      setSettings(await window.origread.removeMcpRemoteServer(server.id))
      setConnections((current)=>withoutKey(current,server.id))
      setServerStatus((current)=>withoutKey(current,server.id))
      setCredentials((current)=>withoutKey(current,server.id))
      setDirtyCredentials((current)=>withoutKey(current,server.id))
      setVisibleCredentials((current)=>withoutKey(current,server.id))
      setCatalog(await window.origread.getMcpToolCatalog())
    }catch(error){setStatus(errorText(error))}
  }
  const toggleCredential=async(server:McpRemoteServerProfile)=>{
    if(visibleCredentials[server.id]){
      setVisibleCredentials((current)=>({...current,[server.id]:false}))
      if(!dirtyCredentials[server.id])setCredentials((current)=>withoutKey(current,server.id))
      return
    }
    if(dirtyCredentials[server.id]){setVisibleCredentials((current)=>({...current,[server.id]:true}));return}
    if(!server.hasCredential){setVisibleCredentials((current)=>({...current,[server.id]:true}));return}
    try{
      const value=await window.origread.revealMcpRemoteCredential(server.id)
      setCredentials((current)=>({...current,[server.id]:value}))
      setVisibleCredentials((current)=>({...current,[server.id]:true}))
    }catch(error){setServerStatus((current)=>({...current,[server.id]:errorText(error)}))}
  }
  const saveCredential=async(server:McpRemoteServerProfile)=>{
    try{
      const next=await window.origread.updateMcpRemoteServer({id:server.id,credential:credentials[server.id]??''})
      setSettings(next)
      setCredentials((current)=>withoutKey(current,server.id))
      setDirtyCredentials((current)=>withoutKey(current,server.id))
      setVisibleCredentials((current)=>withoutKey(current,server.id))
      const saved=next.servers.find((item)=>item.id===server.id)
      setServerStatus((current)=>({...current,[server.id]:saved?.hasCredential?t('credentialSaved',{count:saved.credentialLength}):t('credentialRemoved')}))
      await reloadConnections()
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('credentialSaveFailed')}: ${errorText(error)}`}))}
  }
  const testServer=async(server:McpRemoteServerProfile)=>{
    setBusyServers((current)=>({...current,[server.id]:true}))
    setServerStatus((current)=>({...current,[server.id]:t('mcpTesting')}))
    try{
      const result=await window.origread.testMcpRemoteServer(server.id)
      setServerStatus((current)=>({...current,[server.id]:result.ok&&result.result
        ?t('mcpHealthOk',{latency:result.result.latencyMs,count:result.result.toolCount,protocol:formatMcpProtocol(result.result.protocolEra,result.result.protocolVersion)})
        :`${t('connectionFailed')}: ${result.error??'Error'}`}))
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('connectionFailed')}: ${errorText(error)}`}))}finally{
      setBusyServers((current)=>({...current,[server.id]:false}))
    }
  }
  const toggleConnection=async(server:McpRemoteServerProfile)=>{
    const connected=connections[server.id]?.status==='CONNECTED'
    setBusyServers((current)=>({...current,[server.id]:true}))
    try{
      if(connected)await window.origread.disconnectMcpRemoteServer(server.id)
      else await window.origread.connectMcpRemoteServer(server.id)
      await reloadConnections()
      setServerStatus((current)=>({...current,[server.id]:connected?t('mcpDisconnected'):t('mcpConnected')}))
    }catch(error){
      await reloadConnections().catch(()=>undefined)
      setServerStatus((current)=>({...current,[server.id]:`${t('connectionFailed')}: ${errorText(error)}`}))
    }finally{setBusyServers((current)=>({...current,[server.id]:false}))}
  }
  const authorizeOAuth=async(server:McpRemoteServerProfile)=>{
    setBusyServers((current)=>({...current,[server.id]:true}))
    setServerStatus((current)=>({...current,[server.id]:t('mcpOAuthWaiting')}))
    try{
      await window.origread.authorizeMcpRemoteServer(server.id)
      const [nextSettings,states,nextCatalog]=await Promise.all([window.origread.getMcpRemoteSettings(),window.origread.getMcpConnectionStates(),window.origread.getMcpToolCatalog()])
      setSettings(nextSettings)
      setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
      setCatalog(nextCatalog)
      setServerStatus((current)=>({...current,[server.id]:t('mcpOAuthAuthorized')}))
    }catch(error){
      await reloadConnections().catch(()=>undefined)
      setServerStatus((current)=>({...current,[server.id]:`${t('mcpOAuthFailed')}: ${errorText(error)}`}))
    }finally{setBusyServers((current)=>({...current,[server.id]:false}))}
  }
  const refreshTools=async(server:McpRemoteServerProfile)=>{
    setBusyServers((current)=>({...current,[server.id]:true}))
    setServerStatus((current)=>({...current,[server.id]:t('mcpToolsRefreshing')}))
    try{
      const next=await window.origread.refreshMcpToolCatalog(server.id)
      setCatalog(next)
      const serverCatalog=next.servers.find((item)=>item.serverId===server.id)
      setServerStatus((current)=>({...current,[server.id]:t('mcpToolsRefreshed',{count:serverCatalog?.tools.length??0})}))
      await reloadConnections()
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('mcpToolsRefreshFailed')}: ${errorText(error)}`}))}finally{
      setBusyServers((current)=>({...current,[server.id]:false}))
    }
  }

  if(!settings)return <SettingsSection icon={<Link2 size={17}/>} title={t('mcpTitle')}><LoadingSettings/></SettingsSection>
  return <SettingsSection icon={<Link2 size={17}/>} title={t('mcpTitle')}>
    <div className="llm-settings-toolbar mcp-remote-toolbar"><div><strong>{t('mcpServers')}</strong><span>{t('mcpDescription')}</span></div><button type="button" className="mini-action icon-only" title={`${t('add')}: ${t('mcpServers')}`} aria-label={`${t('add')}: ${t('mcpServers')}`} onClick={()=>void addServer()}><Plus size={13}/></button></div>
    <div className="mcp-remote-list">
      {settings.servers.length?settings.servers.map((server)=>{
        const connection=connections[server.id]
        const serverCatalog=catalog.servers.find((item)=>item.serverId===server.id)
        const busy=busyServers[server.id]===true
        const connected=connection?.status==='CONNECTED'
        const authReady=server.authMode==='NONE'||((server.authMode==='BEARER'||server.authMode==='CUSTOM_HEADERS')&&server.hasCredential)||(server.authMode==='OAUTH'&&server.oauthAuthorized)
        return <section className="provider-card mcp-remote-card" key={server.id}>
          <div className="provider-card-head">
            <div className="provider-card-title"><input className="provider-name" aria-label={t('mcpServerName')} value={server.name} onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,name:event.target.value}:item)})} onBlur={()=>void updateServer(server,{name:settings.servers.find((item)=>item.id===server.id)!.name})}/><span>{t('mcpTransportStreamableHttp')}</span></div>
            <span className={`mcp-connection-badge ${connection?.status?.toLowerCase()??'disconnected'}`}>{t(mcpConnectionLabelKey(connection?.status))}</span>
            <Toggle ariaLabel={server.name} checked={server.enabled} onChange={(value)=>void updateServer(server,{enabled:value})}/>
            <button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void removeServer(server)}><Trash2 size={14}/></button>
          </div>
          <Field label={t('mcpServerUrl')}><input value={server.url} spellCheck={false} placeholder="https://example.com/mcp" onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,url:event.target.value}:item)})} onBlur={()=>void updateServer(server,{url:settings.servers.find((item)=>item.id===server.id)!.url})}/></Field>
          <Field label={t('mcpAuthMode')}><select value={server.authMode} onChange={(event)=>void updateServer(server,{authMode:event.target.value as McpRemoteAuthMode})}><option value="NONE">{t('mcpAuthNone')}</option><option value="BEARER">{t('mcpAuthBearer')}</option><option value="CUSTOM_HEADERS">{t('mcpAuthCustomHeaders')}</option><option value="OAUTH">{t('mcpAuthOAuth')}</option></select></Field>
          {server.authMode==='BEARER'&&<Field label={t('mcpBearerToken')}><AiSecretKeyEditor value={credentials[server.id]??''} hasStoredValue={server.hasCredential} storedLength={server.credentialLength} dirty={dirtyCredentials[server.id]===true} visible={visibleCredentials[server.id]===true} onChange={(value)=>{setCredentials((current)=>({...current,[server.id]:value}));setDirtyCredentials((current)=>({...current,[server.id]:true}))}} onToggle={()=>void toggleCredential(server)} onSave={()=>void saveCredential(server)}/></Field>}
          {server.authMode==='CUSTOM_HEADERS'&&<div className="mcp-custom-headers-field"><div><strong>{t('mcpCustomHeaders')}</strong><span>{t('mcpCustomHeadersDescription')}</span></div><div className="mcp-custom-headers-editor"><textarea rows={4} disabled={server.hasCredential&&!visibleCredentials[server.id]&&!dirtyCredentials[server.id]} value={credentials[server.id]??''} placeholder={server.hasCredential&&!visibleCredentials[server.id]?t('credentialStored',{count:server.credentialLength}):'X-Api-Key: value'} onChange={(event)=>{setCredentials((current)=>({...current,[server.id]:event.target.value}));setDirtyCredentials((current)=>({...current,[server.id]:true}));setVisibleCredentials((current)=>({...current,[server.id]:true}))}}/><div className="inline-controls"><button type="button" className="mini-action secondary" onClick={()=>void toggleCredential(server)}>{visibleCredentials[server.id]?<EyeOff size={13}/>:<Eye size={13}/>} {visibleCredentials[server.id]?t('hideCredential'):t('showCredential')}</button><button type="button" className="mini-action" disabled={!dirtyCredentials[server.id]} onClick={()=>void saveCredential(server)}><Save size={13}/>{t('saveCredential')}</button></div></div></div>}
          {server.authMode==='OAUTH'&&<div className="mcp-oauth-field"><div><strong>{server.oauthAuthorized?t('mcpOAuthAuthorizedState'):t('mcpOAuthNotAuthorized')}</strong><span>{t('mcpOAuthDescription')}</span></div><button type="button" className="mini-action" disabled={busy||!server.enabled||!server.url} onClick={()=>void authorizeOAuth(server)}>{busy&&<RefreshCw size={13} className="spinning"/>}{server.oauthAuthorized?t('mcpOAuthReauthorize'):t('mcpOAuthAuthorize')}</button></div>}
          <div className="mcp-remote-meta"><span>{t('mcpProtocol')}: {connection?.protocolEra?formatMcpProtocol(connection.protocolEra,connection.protocolVersion):t('mcpProtocolAuto')}</span>{connection?.serverInfo&&<span>{connection.serverInfo.title||connection.serverInfo.name} · {connection.serverInfo.version}</span>}{serverCatalog&&<span className={serverCatalog.stale?'warning':''}>{serverCatalog.stale?t('mcpCatalogStale'):t('mcpCatalogCached',{count:serverCatalog.tools.length})}</span>}</div>
          {serverCatalog&&serverCatalog.tools.length>0&&<div className="mcp-tool-list">{serverCatalog.tools.map((tool)=><div className="mcp-tool-row" key={tool.id}><div><strong>{tool.title||tool.rawName}</strong>{tool.title&&<code>{tool.rawName}</code>}<span>{tool.description||t('mcpToolNoDescription')}</span></div><div className="mcp-tool-hints">{tool.annotations.readOnlyHint===true&&<span>{t('mcpToolReadOnlyHint')}</span>}{tool.annotations.destructiveHint===true&&<span className="warning">{t('mcpToolDestructiveHint')}</span>}{tool.annotations.openWorldHint===true&&<span>{t('mcpToolOpenWorldHint')}</span>}</div></div>)}</div>}
          <div className="mcp-remote-actions"><button type="button" className="mini-action secondary" disabled={busy||!server.enabled||!server.url||!authReady||dirtyCredentials[server.id]===true} onClick={()=>void testServer(server)}>{busy&&<RefreshCw size={13} className="spinning"/>}{t('testConnection')}</button><button type="button" className="mini-action secondary" disabled={busy||!server.enabled||!server.url||!authReady||dirtyCredentials[server.id]===true} onClick={()=>void refreshTools(server)}><RefreshCw size={13}/>{t('mcpRefreshTools')}</button><button type="button" className="mini-action" disabled={busy||!server.enabled||!server.url||!authReady||dirtyCredentials[server.id]===true} onClick={()=>void toggleConnection(server)}>{connected?t('mcpDisconnect'):t('mcpConnect')}</button></div>
          {serverStatus[server.id]&&<StatusText text={serverStatus[server.id]!}/>}
          {connection?.status==='ERROR'&&connection.errorMessage&&<StatusText text={`${t('connectionFailed')}: ${connection.errorMessage}`}/>} 
        </section>
      }):<div className="llm-settings-empty mcp-remote-empty">{t('mcpEmpty')}</div>}
    </div>
    <div className="mcp-remote-footnote"><CircleHelp size={13}/><span>{t('mcpAuthLater')}</span></div>
    {status&&<StatusText text={status}/>}
  </SettingsSection>
}

function LocalMcpSettingsSection():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<McpLocalSettings|null>(null)
  const [catalog,setCatalog]=useState<McpToolCatalogSnapshot>({servers:[]})
  const [connections,setConnections]=useState<Record<string,McpConnectionSnapshot>>({})
  const [environments,setEnvironments]=useState<Record<string,string>>({})
  const [dirtyEnvironments,setDirtyEnvironments]=useState<Record<string,boolean>>({})
  const [visibleEnvironments,setVisibleEnvironments]=useState<Record<string,boolean>>({})
  const [busyServers,setBusyServers]=useState<Record<string,boolean>>({})
  const [serverStatus,setServerStatus]=useState<Record<string,string>>({})
  const [status,setStatus]=useState('')

  const reloadConnections=async()=>{
    const states=await window.origread.getMcpLocalConnectionStates()
    setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
  }

  useEffect(()=>{
    let cancelled=false
    void Promise.all([window.origread.getMcpLocalSettings(),window.origread.getMcpLocalConnectionStates(),window.origread.getMcpToolCatalog()])
      .then(([loaded,states,loadedCatalog])=>{
        if(cancelled)return
        setSettings(loaded)
        setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
        setCatalog(loadedCatalog)
      })
      .catch((error)=>{if(!cancelled)setStatus(errorText(error))})
    return()=>{cancelled=true}
  },[])

  const addServer=async()=>{
    try{setSettings(await window.origread.addMcpLocalServer());setStatus('')}catch(error){setStatus(errorText(error))}
  }
  const updateServer=async(server:McpLocalServerProfile,patch:Omit<Parameters<typeof window.origread.updateMcpLocalServer>[0],'id'>)=>{
    try{
      setSettings(await window.origread.updateMcpLocalServer({id:server.id,...patch}))
      const [states,nextCatalog]=await Promise.all([window.origread.getMcpLocalConnectionStates(),window.origread.getMcpToolCatalog()])
      setConnections(Object.fromEntries(states.map((state)=>[state.serverId,state])))
      setCatalog(nextCatalog)
      setStatus('')
    }catch(error){setServerStatus((current)=>({...current,[server.id]:errorText(error)}))}
  }
  const toggleEnabled=async(server:McpLocalServerProfile,value:boolean)=>{
    if(value&&!server.command.trim()){
      setServerStatus((current)=>({...current,[server.id]:t('mcpLocalEnableRequiresCommand')}))
      return
    }
    await updateServer(server,{enabled:value})
  }
  const removeServer=async(server:McpLocalServerProfile)=>{
    if(!window.confirm(t('mcpLocalDeleteConfirm',{name:server.name})))return
    try{
      setSettings(await window.origread.removeMcpLocalServer(server.id))
      setConnections((current)=>withoutKey(current,server.id))
      setServerStatus((current)=>withoutKey(current,server.id))
      setEnvironments((current)=>withoutKey(current,server.id))
      setDirtyEnvironments((current)=>withoutKey(current,server.id))
      setVisibleEnvironments((current)=>withoutKey(current,server.id))
      setCatalog(await window.origread.getMcpToolCatalog())
    }catch(error){setStatus(errorText(error))}
  }
  const toggleEnvironment=async(server:McpLocalServerProfile)=>{
    if(visibleEnvironments[server.id]){
      setVisibleEnvironments((current)=>({...current,[server.id]:false}))
      if(!dirtyEnvironments[server.id])setEnvironments((current)=>withoutKey(current,server.id))
      return
    }
    if(dirtyEnvironments[server.id]){setVisibleEnvironments((current)=>({...current,[server.id]:true}));return}
    if(!server.hasEnvironment){setVisibleEnvironments((current)=>({...current,[server.id]:true}));return}
    try{
      const value=await window.origread.revealMcpLocalEnvironment(server.id)
      setEnvironments((current)=>({...current,[server.id]:value}))
      setVisibleEnvironments((current)=>({...current,[server.id]:true}))
    }catch(error){setServerStatus((current)=>({...current,[server.id]:errorText(error)}))}
  }
  const saveEnvironment=async(server:McpLocalServerProfile)=>{
    try{
      const next=await window.origread.updateMcpLocalServer({id:server.id,environment:environments[server.id]??''})
      setSettings(next)
      setEnvironments((current)=>withoutKey(current,server.id))
      setDirtyEnvironments((current)=>withoutKey(current,server.id))
      setVisibleEnvironments((current)=>withoutKey(current,server.id))
      const saved=next.servers.find((item)=>item.id===server.id)
      setServerStatus((current)=>({...current,[server.id]:saved?.hasEnvironment?t('mcpLocalEnvironmentSaved'):t('mcpLocalEnvironmentRemoved')}))
      await reloadConnections()
      setCatalog(await window.origread.getMcpToolCatalog())
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('mcpLocalEnvironmentSaveFailed')}: ${errorText(error)}`}))}
  }
  const testServer=async(server:McpLocalServerProfile)=>{
    setBusyServers((current)=>({...current,[server.id]:true}))
    setServerStatus((current)=>({...current,[server.id]:t('mcpTesting')}))
    try{
      const result=await window.origread.testMcpLocalServer(server.id)
      setServerStatus((current)=>({...current,[server.id]:result.ok&&result.result
        ?t('mcpHealthOk',{latency:result.result.latencyMs,count:result.result.toolCount,protocol:formatMcpProtocol(result.result.protocolEra,result.result.protocolVersion)})
        :`${t('connectionFailed')}: ${result.error??'Error'}`}))
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('connectionFailed')}: ${errorText(error)}`}))}finally{
      setBusyServers((current)=>({...current,[server.id]:false}))
    }
  }
  const toggleConnection=async(server:McpLocalServerProfile)=>{
    const connected=connections[server.id]?.status==='CONNECTED'
    setBusyServers((current)=>({...current,[server.id]:true}))
    try{
      if(connected)await window.origread.disconnectMcpLocalServer(server.id)
      else await window.origread.connectMcpLocalServer(server.id)
      await reloadConnections()
      setServerStatus((current)=>({...current,[server.id]:connected?t('mcpDisconnected'):t('mcpConnected')}))
    }catch(error){
      await reloadConnections().catch(()=>undefined)
      setServerStatus((current)=>({...current,[server.id]:`${t('connectionFailed')}: ${errorText(error)}`}))
    }finally{setBusyServers((current)=>({...current,[server.id]:false}))}
  }
  const refreshTools=async(server:McpLocalServerProfile)=>{
    setBusyServers((current)=>({...current,[server.id]:true}))
    setServerStatus((current)=>({...current,[server.id]:t('mcpToolsRefreshing')}))
    try{
      const next=await window.origread.refreshMcpToolCatalog(server.id)
      setCatalog(next)
      const serverCatalog=next.servers.find((item)=>item.serverId===server.id)
      setServerStatus((current)=>({...current,[server.id]:t('mcpToolsRefreshed',{count:serverCatalog?.tools.length??0})}))
      await reloadConnections()
    }catch(error){setServerStatus((current)=>({...current,[server.id]:`${t('mcpToolsRefreshFailed')}: ${errorText(error)}`}))}finally{
      setBusyServers((current)=>({...current,[server.id]:false}))
    }
  }

  if(!settings)return <SettingsSection icon={<Monitor size={17}/>} title={t('mcpLocalTitle')}><LoadingSettings/></SettingsSection>
  return <SettingsSection icon={<Monitor size={17}/>} title={t('mcpLocalTitle')}>
    <div className="llm-settings-toolbar mcp-remote-toolbar"><div><strong>{t('mcpLocalServers')}</strong><span>{t('mcpLocalDescription')}</span></div><button type="button" className="mini-action icon-only" title={`${t('add')}: ${t('mcpLocalServers')}`} aria-label={`${t('add')}: ${t('mcpLocalServers')}`} onClick={()=>void addServer()}><Plus size={13}/></button></div>
    <div className="mcp-remote-list mcp-local-list">
      {settings.servers.length?settings.servers.map((server)=>{
        const connection=connections[server.id]
        const serverCatalog=catalog.servers.find((item)=>item.serverId===server.id)
        const busy=busyServers[server.id]===true
        const connected=connection?.status==='CONNECTED'
        const ready=server.enabled&&Boolean(server.command.trim())&&dirtyEnvironments[server.id]!==true
        return <section className="provider-card mcp-remote-card mcp-local-card" key={server.id}>
          <div className="provider-card-head">
            <div className="provider-card-title"><input className="provider-name" aria-label={t('mcpServerName')} value={server.name} onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,name:event.target.value}:item)})} onBlur={()=>void updateServer(server,{name:settings.servers.find((item)=>item.id===server.id)!.name})}/><span>{t('mcpLocalTransport')}</span></div>
            <span className={`mcp-connection-badge ${connection?.status?.toLowerCase()??'disconnected'}`}>{t(mcpConnectionLabelKey(connection?.status))}</span>
            <Toggle ariaLabel={server.name} checked={server.enabled} onChange={(value)=>void toggleEnabled(server,value)}/>
            <button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void removeServer(server)}><Trash2 size={14}/></button>
          </div>
          <Field label={t('mcpLocalCommand')}><input value={server.command} spellCheck={false} placeholder={t('mcpLocalCommandPlaceholder')} onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,command:event.target.value}:item)})} onBlur={()=>void updateServer(server,{command:settings.servers.find((item)=>item.id===server.id)!.command})}/></Field>
          <div className="mcp-custom-headers-field mcp-local-args-field"><div><strong>{t('mcpLocalArgs')}</strong><span>{t('mcpLocalArgsDescription')}</span></div><textarea rows={4} spellCheck={false} value={server.args.join('\n')} onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,args:event.target.value.replace(/\r\n/g,'\n').split('\n').filter((line)=>line.length>0)}:item)})} onBlur={()=>void updateServer(server,{args:settings.servers.find((item)=>item.id===server.id)!.args})}/></div>
          <div className="mcp-custom-headers-field mcp-local-cwd-field"><div><strong>{t('mcpLocalCwd')}</strong><span>{t('mcpLocalCwdDescription')}</span></div><input value={server.cwd} spellCheck={false} placeholder="C:\\path\\to\\server" onChange={(event)=>setSettings({...settings,servers:settings.servers.map((item)=>item.id===server.id?{...item,cwd:event.target.value}:item)})} onBlur={()=>void updateServer(server,{cwd:settings.servers.find((item)=>item.id===server.id)!.cwd})}/></div>
          <div className="mcp-custom-headers-field mcp-local-environment-field"><div><strong>{t('mcpLocalEnvironment')}</strong><span>{t('mcpLocalEnvironmentDescription')}</span></div><div className="mcp-custom-headers-editor"><textarea rows={4} disabled={server.hasEnvironment&&!visibleEnvironments[server.id]&&!dirtyEnvironments[server.id]} value={environments[server.id]??''} placeholder={server.hasEnvironment&&!visibleEnvironments[server.id]?t('credentialStored',{count:server.environmentLength}):'API_TOKEN=value'} onChange={(event)=>{setEnvironments((current)=>({...current,[server.id]:event.target.value}));setDirtyEnvironments((current)=>({...current,[server.id]:true}));setVisibleEnvironments((current)=>({...current,[server.id]:true}))}}/><div className="inline-controls"><button type="button" className="mini-action secondary" onClick={()=>void toggleEnvironment(server)}>{visibleEnvironments[server.id]?<EyeOff size={13}/>:<Eye size={13}/>} {visibleEnvironments[server.id]?t('mcpLocalHideEnvironment'):t('mcpLocalShowEnvironment')}</button><button type="button" className="mini-action" disabled={!dirtyEnvironments[server.id]} onClick={()=>void saveEnvironment(server)}><Save size={13}/>{t('mcpLocalSaveEnvironment')}</button></div></div></div>
          <div className="mcp-remote-meta"><span>{t('mcpProtocol')}: {connection?.protocolEra?formatMcpProtocol(connection.protocolEra,connection.protocolVersion):t('mcpProtocolAuto')}</span>{connection?.serverInfo&&<span>{connection.serverInfo.title||connection.serverInfo.name} · {connection.serverInfo.version}</span>}{serverCatalog&&<span className={serverCatalog.stale?'warning':''}>{serverCatalog.stale?t('mcpCatalogStale'):t('mcpCatalogCached',{count:serverCatalog.tools.length})}</span>}</div>
          {serverCatalog&&serverCatalog.tools.length>0&&<div className="mcp-tool-list">{serverCatalog.tools.map((tool)=><div className="mcp-tool-row" key={tool.id}><div><strong>{tool.title||tool.rawName}</strong>{tool.title&&<code>{tool.rawName}</code>}<span>{tool.description||t('mcpToolNoDescription')}</span></div><div className="mcp-tool-hints">{tool.annotations.readOnlyHint===true&&<span>{t('mcpToolReadOnlyHint')}</span>}{tool.annotations.destructiveHint===true&&<span className="warning">{t('mcpToolDestructiveHint')}</span>}{tool.annotations.openWorldHint===true&&<span>{t('mcpToolOpenWorldHint')}</span>}</div></div>)}</div>}
          <div className="mcp-remote-actions"><button type="button" className="mini-action secondary" disabled={busy||!ready} onClick={()=>void testServer(server)}>{busy&&<RefreshCw size={13} className="spinning"/>}{t('testConnection')}</button><button type="button" className="mini-action secondary" disabled={busy||!ready} onClick={()=>void refreshTools(server)}><RefreshCw size={13}/>{t('mcpRefreshTools')}</button><button type="button" className="mini-action" disabled={busy||!ready} onClick={()=>void toggleConnection(server)}>{connected?t('mcpDisconnect'):t('mcpConnect')}</button></div>
          {serverStatus[server.id]&&<StatusText text={serverStatus[server.id]!}/>} 
          {connection?.status==='ERROR'&&connection.errorMessage&&<StatusText text={`${t('connectionFailed')}: ${connection.errorMessage}`}/>} 
        </section>
      }):<div className="llm-settings-empty mcp-remote-empty">{t('mcpLocalEmpty')}</div>}
    </div>
    <div className="mcp-remote-footnote"><CircleHelp size={13}/><span>{t('mcpLocalSafety')}</span></div>
    {status&&<StatusText text={status}/>} 
  </SettingsSection>
}

function mcpConnectionLabelKey(status:McpConnectionSnapshot['status']|undefined):string{
  return status==='CONNECTED'?'mcpStateConnected':status==='CONNECTING'?'mcpStateConnecting':status==='ERROR'?'mcpStateError':'mcpStateDisconnected'
}

function formatMcpProtocol(era:McpProtocolEra,version:string|null):string{
  const label=era==='MODERN'?'Modern':'Legacy'
  return version?`${label} · ${version}`:label
}

function LlmCustomizationSettingsSections({onUnsavedChange}:{onUnsavedChange?:(dirty:boolean)=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation()
  const language:i18nLanguage=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  const [customization,setCustomization]=useState<LlmCustomizationSettings|null>(null)
  const [skills,setSkills]=useState<LlmSkillManagementSnapshot|null>(null)
  const [quickMessages,setQuickMessages]=useState<LlmQuickMessage[]>([])
  const [customInstructionsDraft,setCustomInstructionsDraft]=useState('')
  const [editingQuickId,setEditingQuickId]=useState<string|null>(null)
  const [quickTitle,setQuickTitle]=useState('')
  const [quickContent,setQuickContent]=useState('')
  const [creatingSkill,setCreatingSkill]=useState(false)
  const [skillCreateId,setSkillCreateId]=useState('')
  const [skillCreateDescription,setSkillCreateDescription]=useState('')
  const [skillCreateTriggers,setSkillCreateTriggers]=useState('')
  const [skillCreateInstructions,setSkillCreateInstructions]=useState('')
  const [skillPreview,setSkillPreview]=useState<LlmSkillPreview|null>(null)
  const [skillPreviewLoadingId,setSkillPreviewLoadingId]=useState<string|null>(null)
  const [status,setStatus]=useState('')
  const customInstructionsDirty=Boolean(customization&&customInstructionsDraft.trim()!==customization.customInstructions)

  useEffect(()=>{onUnsavedChange?.(customInstructionsDirty)},[customInstructionsDirty,onUnsavedChange])

  useEffect(()=>{
    let cancelled=false
    void Promise.all([window.origread.getLlmCustomizationSettings(),window.origread.getLlmSkills()])
      .then(([nextCustomization,nextSkills])=>{if(cancelled)return;setCustomization(nextCustomization);setCustomInstructionsDraft(nextCustomization.customInstructions);setSkills(nextSkills)})
      .catch((error)=>{if(!cancelled)setStatus(errorText(error))})
    return()=>{cancelled=true}
  },[])
  useEffect(()=>{
    let cancelled=false
    void window.origread.getLlmQuickMessages(language).then((items)=>{if(!cancelled)setQuickMessages(items)}).catch((error)=>{if(!cancelled)setStatus(errorText(error))})
    return()=>{cancelled=true}
  },[language])

  const saveInstructions=async()=>{
    setStatus('')
    try{
      const next=await window.origread.updateLlmCustomizationSettings({customInstructions:customInstructionsDraft})
      setCustomization(next);setCustomInstructionsDraft(next.customInstructions);setStatus(t('customInstructionsSaved'))
    }catch(error){setStatus(errorText(error))}
  }
  const setSkillsEnabled=async(enabled:boolean)=>{
    try{setCustomization(await window.origread.updateLlmCustomizationSettings({skillsEnabled:enabled}))}catch(error){setStatus(errorText(error))}
  }
  const importSkill=async()=>{
    setStatus('')
    const result=await window.origread.importLlmSkill()
    setSkills(result.snapshot)
    if(result.cancelled)return
    setStatus(result.ok?t(result.replaced?'skillReplaced':'skillImported',{name:result.skillId??''}):result.error??t('skillImportFailed'))
  }
  const resetSkillCreate=()=>{setCreatingSkill(false);setSkillCreateId('');setSkillCreateDescription('');setSkillCreateTriggers('');setSkillCreateInstructions('')}
  const createSkill=async()=>{
    const id=skillCreateId.trim()
    if(!id||!skillCreateDescription.trim()||!skillCreateInstructions.trim())return
    const replacing=Boolean(skills?.skills.some((skill)=>skill.id===id))
    if(replacing&&!window.confirm(t('skillReplaceConfirm',{name:id})))return
    setStatus('')
    try{
      const result=await window.origread.createLlmSkill({
        id,
        description:skillCreateDescription,
        instructions:skillCreateInstructions,
        triggers:skillCreateTriggers
      })
      setSkills(result.snapshot)
      if(!result.ok){setStatus(result.error??t('skillCreateFailed'));return}
      resetSkillCreate()
      setStatus(t(result.replaced?'skillReplaced':'skillCreated',{name:result.skillId??id}))
    }catch(error){setStatus(errorText(error))}
  }
  const previewSkill=async(id:string)=>{
    setStatus('');setSkillPreviewLoadingId(id)
    try{setSkillPreview(await window.origread.getLlmSkillPreview(id))}catch(error){setStatus(errorText(error))}finally{setSkillPreviewLoadingId(null)}
  }
  const updateSkillEnabled=async(id:string,enabled:boolean)=>{
    try{setSkills(await window.origread.setLlmSkillEnabled(id,enabled))}catch(error){setStatus(errorText(error))}
  }
  const deleteSkill=async(id:string)=>{
    if(!window.confirm(t('skillDeleteConfirm',{name:id})))return
    try{setSkills(await window.origread.deleteLlmSkill(id));if(skillPreview?.id===id)setSkillPreview(null);setStatus(t('skillDeleted',{name:id}))}catch(error){setStatus(errorText(error))}
  }
  const bindSkill=async(task:LlmSkillTask,id:string)=>{
    try{setSkills(await window.origread.setLlmSkillBinding(task,id||null))}catch(error){setStatus(errorText(error))}
  }
  const beginQuickEdit=(message?:LlmQuickMessage)=>{
    setEditingQuickId(message?.id??'__new__');setQuickTitle(message?.title??'');setQuickContent(message?.content??'');setStatus('')
  }
  const closeQuickEdit=()=>{setEditingQuickId(null);setQuickTitle('');setQuickContent('')}
  const saveQuickMessage=async()=>{
    setStatus('')
    try{
      const next=editingQuickId==='__new__'
        ? await window.origread.createLlmQuickMessage(quickTitle,quickContent,language)
        : await window.origread.updateLlmQuickMessage(editingQuickId!,quickTitle,quickContent,language)
      setQuickMessages(next);closeQuickEdit();setStatus(t('quickMessageSaved'))
    }catch(error){setStatus(errorText(error))}
  }
  const setQuickEnabled=async(id:string,enabled:boolean)=>{
    try{setQuickMessages(await window.origread.setLlmQuickMessageEnabled(id,enabled,language))}catch(error){setStatus(errorText(error))}
  }
  const deleteQuickMessage=async(id:string)=>{
    if(!window.confirm(t('quickMessageDeleteConfirm')))return
    try{setQuickMessages(await window.origread.deleteLlmQuickMessage(id,language));if(editingQuickId===id)closeQuickEdit()}catch(error){setStatus(errorText(error))}
  }
  const moveQuickMessage=async(id:string,direction:-1|1)=>{
    try{setQuickMessages(await window.origread.moveLlmQuickMessage(id,direction,language))}catch(error){setStatus(errorText(error))}
  }

  const enabledSkills=skills?.skills.filter((skill)=>skill.enabled)??[]
  const taskBindings:[LlmSkillTask,string,string][]=[
    ['SUMMARY','skillTaskSummary','skillTaskSummaryDescription'],
    ['TRANSLATION','skillTaskTranslation','skillTaskTranslationDescription'],
    ['ARTICLE_ANALYSIS','skillTaskAnalysis','skillTaskAnalysisDescription']
  ]
  return <>
    <SettingsSection icon={<FileText size={17}/>} title={t('customInstructions')}>
      <SettingRow className="llm-custom-instructions-row" title={t('customInstructions')} description={t('customInstructionsDescription')}>
        <div className="llm-custom-instructions-editor">
          <textarea aria-label={t('customInstructions')} rows={5} maxLength={8000} value={customInstructionsDraft} placeholder={t('customInstructionsPlaceholder')} onChange={(event)=>setCustomInstructionsDraft(event.target.value)}/>
          <div className="llm-editor-footer"><span>{customInstructionsDraft.length}/8000</span><button type="button" className="mini-action" disabled={!customization||customInstructionsDraft.trim()===customization.customInstructions} onClick={()=>void saveInstructions()}><Save size={13}/>{t('save')}</button></div>
        </div>
      </SettingRow>
    </SettingsSection>

    <SettingsSection icon={<Sparkles size={17}/>} title={t('skillsTitle')}>
      <SettingRow title={t('skillsEnabled')} description={t('skillsEnabledDescription')}><Toggle ariaLabel={t('skillsEnabled')} checked={customization?.skillsEnabled!==false} onChange={(value)=>void setSkillsEnabled(value)}/></SettingRow>
      {skills&&taskBindings.map(([task,titleKey,descriptionKey])=><SettingRow key={task} title={t(titleKey)} description={t(descriptionKey)}><select aria-label={t(titleKey)} value={llmSkillBindingId(skills.bindings,task)??''} onChange={(event)=>void bindSkill(task,event.target.value)}><option value="">{t('skillBindingNone')}</option>{enabledSkills.map((skill)=><option key={skill.id} value={skill.id}>{skill.metadata['origread-display-name']?.trim()||skill.id}</option>)}</select></SettingRow>)}
      <div className="llm-settings-toolbar"><div><strong>{t('installedSkills')}</strong><span>{t('skillsAutoRoutingDescription')}</span></div><div className="inline-controls"><button type="button" className="mini-action icon-only" title={t('createSkill')} aria-label={t('createSkill')} onClick={()=>{setCreatingSkill(true);setStatus('')}}><Plus size={13}/></button><button type="button" className="mini-action" onClick={()=>void importSkill()}><Upload size={13}/>{t('importSkill')}</button></div></div>
      {creatingSkill&&<div className="llm-skill-create-editor">
        <div className="llm-skill-create-grid">
          <label><span>{t('skillId')}</span><input maxLength={64} spellCheck={false} value={skillCreateId} placeholder="reading-review" onChange={(event)=>setSkillCreateId(event.target.value.toLowerCase())}/></label>
          <label><span>{t('skillDescription')}</span><input maxLength={1024} value={skillCreateDescription} placeholder={t('skillDescriptionPlaceholder')} onChange={(event)=>setSkillCreateDescription(event.target.value)}/></label>
        </div>
        <label><span>{t('skillTriggers')}</span><input maxLength={2000} value={skillCreateTriggers} placeholder={t('skillTriggersPlaceholder')} onChange={(event)=>setSkillCreateTriggers(event.target.value)}/></label>
        <label><span>{t('skillInstructions')}</span><textarea rows={7} maxLength={500000} value={skillCreateInstructions} placeholder={t('skillInstructionsPlaceholder')} onChange={(event)=>setSkillCreateInstructions(event.target.value)}/></label>
        <div className="llm-editor-footer"><span>{t('skillCreateHint')}</span><div className="inline-controls"><button type="button" className="mini-action" onClick={resetSkillCreate}><X size={13}/>{t('cancel')}</button><button type="button" className="mini-action" disabled={!skillCreateId.trim()||!skillCreateDescription.trim()||!skillCreateInstructions.trim()} onClick={()=>void createSkill()}><Save size={13}/>{t('save')}</button></div></div>
      </div>}
      <div className="llm-skill-list">
        {skills?.skills.length?skills.skills.map((skill)=>{const displayName=skill.metadata['origread-display-name']?.trim()||skill.id;return <div className="llm-skill-card" key={skill.id}>
          <div className="llm-skill-card-head"><div><strong>{displayName}</strong>{displayName!==skill.id&&<span>{skill.id}</span>}</div><div className="llm-item-actions"><Toggle ariaLabel={displayName} checked={skill.enabled} onChange={(value)=>void updateSkillEnabled(skill.id,value)}/><button type="button" className="icon-button" disabled={skillPreviewLoadingId===skill.id} title={t('previewSkill')} aria-label={t('previewSkill')} onClick={()=>void previewSkill(skill.id)}>{skillPreviewLoadingId===skill.id?<RefreshCw size={14} className="spinning"/>:<Eye size={14}/>}</button><button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void deleteSkill(skill.id)}><Trash2 size={14}/></button></div></div>
          <p>{skill.description}</p>
          <div className="llm-skill-meta"><span>{t('skillResources',{count:skill.resourceCount})}</span>{skill.hasScripts&&<span className="warning">{t('skillScriptsIgnored')}</span>}{skill.allowedTools&&<span title={skill.allowedTools}>{t('skillDeclaredTools')}</span>}</div>
        </div>}):<div className="llm-settings-empty">{t('skillsEmpty')}</div>}
      </div>
    </SettingsSection>

    {skillPreview&&<RuleModal title={skillPreview.id} description={skillPreview.description} wide onClose={()=>setSkillPreview(null)}>
      <div className="llm-skill-preview">
        <div className="llm-skill-preview-meta">
          {skillPreview.compatibility&&<div><span>{t('skillCompatibility')}</span><strong>{skillPreview.compatibility}</strong></div>}
          {skillPreview.license&&<div><span>{t('skillLicense')}</span><strong>{skillPreview.license}</strong></div>}
          {skillPreview.allowedTools&&<div><span>{t('skillAllowedTools')}</span><strong>{skillPreview.allowedTools}</strong></div>}
          {skillPreview.resourcePaths.length>0&&<div><span>{t('skillResourceFiles')}</span><strong>{skillPreview.resourcePaths.join(', ')}</strong></div>}
          {skillPreview.hasScripts&&<div className="warning"><span>{t('skillScripts')}</span><strong>{t('skillScriptsIgnored')}</strong></div>}
        </div>
        <section><h3>{t('skillInstructions')}</h3><pre>{skillPreview.instructions}</pre></section>
      </div>
    </RuleModal>}

    <SettingsSection icon={<MessageSquareText size={17}/>} title={t('quickMessagesTitle')}>
      <div className="llm-settings-toolbar"><div><strong>{t('quickMessagesTitle')}</strong><span>{t('quickMessagesDescription')}</span></div><button type="button" className="mini-action icon-only" title={`${t('add')}: ${t('quickMessagesTitle')}`} aria-label={`${t('add')}: ${t('quickMessagesTitle')}`} onClick={()=>beginQuickEdit()}><Plus size={13}/></button></div>
      <div className="quick-variable-hint"><span>{t('quickMessageVariables')}</span>{['article_title','article_url','selection','summary'].map((item)=><code key={item}>{`{{${item}}}`}</code>)}</div>
      {editingQuickId&&<div className="quick-message-editor">
        <input aria-label={t('quickMessageTitlePlaceholder')} maxLength={80} value={quickTitle} placeholder={t('quickMessageTitlePlaceholder')} onChange={(event)=>setQuickTitle(event.target.value)}/>
        <textarea aria-label={t('quickMessageContentPlaceholder')} rows={4} maxLength={4000} value={quickContent} placeholder={t('quickMessageContentPlaceholder')} onChange={(event)=>setQuickContent(event.target.value)}/>
        <div className="llm-editor-footer"><span>{quickContent.length}/4000</span><div className="inline-controls"><button type="button" className="mini-action" onClick={closeQuickEdit}><X size={13}/>{t('cancel')}</button><button type="button" className="mini-action" disabled={!quickTitle.trim()||!quickContent.trim()} onClick={()=>void saveQuickMessage()}><Save size={13}/>{t('save')}</button></div></div>
      </div>}
      <div className="quick-message-list">
        {quickMessages.length?quickMessages.map((message,index)=><div className="quick-message-row" key={message.id}>
          <div className="quick-message-copy"><div><strong>{message.title}</strong>{message.builtin&&<span className="llm-badge">{t('builtIn')}</span>}</div><span>{message.content}</span></div>
          <div className="llm-item-actions"><Toggle ariaLabel={message.title} checked={message.enabled} onChange={(value)=>void setQuickEnabled(message.id,value)}/><button type="button" className="icon-button" disabled={index===0} title={t('moveUp')} aria-label={t('moveUp')} onClick={()=>void moveQuickMessage(message.id,-1)}><ArrowUp size={14}/></button><button type="button" className="icon-button" disabled={index===quickMessages.length-1} title={t('moveDown')} aria-label={t('moveDown')} onClick={()=>void moveQuickMessage(message.id,1)}><ArrowDown size={14}/></button><button type="button" className="icon-button" title={t('editQuickMessage')} aria-label={t('editQuickMessage')} onClick={()=>beginQuickEdit(message)}><Pencil size={14}/></button><button type="button" className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>void deleteQuickMessage(message.id)}><Trash2 size={14}/></button></div>
        </div>):<div className="llm-settings-empty">{t('quickMessagesEmpty')}</div>}
      </div>
    </SettingsSection>
    {status&&<StatusText text={status}/>}
  </>
}

function TranslationSettingsPage():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<TranslationSettings|null>(null)
  const [targetLanguageDraft,setTargetLanguageDraft]=useState('zh-CN')
  const [keys,setKeys]=useState<Record<string,string>>({})
  const [savedKeys,setSavedKeys]=useState<Record<string,string>>({})
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({})
  const [status,setStatus]=useState('')
  const [providerStatus,setProviderStatus]=useState<Record<string,string>>({})
  const [deepLUsageStatus,setDeepLUsageStatus]=useState('')
  const [loadingDeepLUsage,setLoadingDeepLUsage]=useState(false)

  useEffect(()=>{
    let cancelled=false
    void (async()=>{
      try{
        const loaded=await window.origread.getTranslationSettings()
        const desktop=loaded.providers.filter((provider)=>provider.type!=='ML_KIT')
        const entries=await Promise.all(desktop.map(async(provider)=>[provider.type,await window.origread.getTranslationApiKey(provider.type)] as const))
        if(cancelled)return
        const loadedKeys=Object.fromEntries(entries)
        setSettings(loaded);setTargetLanguageDraft(loaded.targetLanguage);setKeys(loadedKeys);setSavedKeys(loadedKeys)
      }catch(error){if(!cancelled)setStatus(errorText(error))}
    })()
    return()=>{cancelled=true}
  },[])

  if(!settings)return <LoadingSettings/>
  const desktopProviders=settings.providers.filter((provider)=>provider.type!=='ML_KIT')
  const update=async(patch:Parameters<typeof window.origread.updateTranslationSettings>[0])=>setSettings(await window.origread.updateTranslationSettings(patch))
  const updateProvider=async(provider:TranslationProviderSettings,patch:Record<string,unknown>)=>{setSettings(await window.origread.updateTranslationProvider({type:provider.type,...patch}))}
  const saveKey=async(provider:TranslationProviderSettings)=>{
    try{
      const draft=keys[provider.type]??''
      setSettings(await window.origread.updateTranslationProvider({type:provider.type,apiKey:draft}))
      const saved=await window.origread.getTranslationApiKey(provider.type)
      setKeys((value)=>({...value,[provider.type]:saved}));setSavedKeys((value)=>({...value,[provider.type]:saved}))
      setProviderStatus((value)=>({...value,[provider.type]:saved?t('credentialSaved',{count:saved.length}):t('credentialRemoved')}))
    }catch(error){setProviderStatus((value)=>({...value,[provider.type]:`${t('credentialSaveFailed')}: ${errorText(error)}`}))}
  }
  return <><PageIntro icon={<Languages size={22}/>} title={t('translationSettingsTitle')} description={t('translationSettingsDescription')}/>
    <SettingsSection icon={<Languages size={17}/>} title={t('translationGlobal')}>
      <SettingRow title={t('translationTargetLanguage')} description={t('translationTargetLanguageDescription')}><input aria-label={t('translationTargetLanguage')} className="translation-target-language-input" value={targetLanguageDraft} onChange={(e)=>setTargetLanguageDraft(e.target.value)} onBlur={()=>void update({targetLanguage:targetLanguageDraft})} onKeyDown={(e)=>{if(e.key==='Enter')e.currentTarget.blur()}}/></SettingRow>
      <SettingRow title={t('translationDisplayMode')} description={t('translationDisplayModeDescription')}><select aria-label={t('translationDisplayMode')} value={settings.displayMode} onChange={(e)=>void update({displayMode:e.target.value as TranslationSettings['displayMode']})}><option value="TRANSLATED">{t('translatedOnly')}</option><option value="BILINGUAL">{t('bilingual')}</option></select></SettingRow>
    </SettingsSection>
    <div className="settings-section-title standalone-settings-section-title"><Languages size={17}/><span>{t('translationDefaultTarget')}</span></div>
    <p className="settings-section-description">{t('translationDefaultTargetDescription')}</p>
    {desktopProviders.map((provider)=>{const selected=settings.defaultTarget.type==='traditional'&&settings.defaultTarget.provider===provider.type;const dirty=(keys[provider.type]??'')!==(savedKeys[provider.type]??'');const displayName=providerName(provider.type)||provider.type;return <section className="provider-card" key={provider.type}><div className="provider-card-head"><label className="provider-default-radio"><input type="radio" name="translation-default-provider" aria-label={`${t('translationDefaultTarget')}: ${displayName}`} checked={selected} disabled={!provider.enabled} onChange={()=>void update({defaultTarget:{type:'traditional',provider:provider.type}})}/><span/></label><div className="provider-card-title"><strong>{displayName}</strong><span>{t(translationProviderDescriptionKey(provider.type))}</span></div><Toggle ariaLabel={displayName} checked={provider.enabled} onChange={(v)=>void updateProvider(provider,{enabled:v})}/></div><>
      <Field label="Endpoint"><input disabled={!provider.enabled} value={provider.endpoint} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.type===provider.type?{...p,endpoint:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{endpoint:settings.providers.find((p)=>p.type===provider.type)!.endpoint})}/></Field>
      {provider.type==='MICROSOFT'&&<Field label="Region"><input disabled={!provider.enabled} value={provider.region} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.type===provider.type?{...p,region:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{region:settings.providers.find((p)=>p.type===provider.type)!.region})}/></Field>}
      <Field label="API Key"><SecretKeyEditor disabled={!provider.enabled} value={keys[provider.type]??''} savedValue={savedKeys[provider.type]??''} visible={visibleKeys[provider.type]===true} optional={provider.type==='DLX'} onChange={(value)=>setKeys((current)=>({...current,[provider.type]:value}))} onToggle={()=>setVisibleKeys((current)=>({...current,[provider.type]:!current[provider.type]}))} onSave={()=>void saveKey(provider)}/></Field>
      <div className="inline-controls">
        <button className="mini-action" disabled={!provider.enabled||dirty} title={dirty?t('saveCredentialFirst'):undefined} onClick={async()=>{const r=await window.origread.testTranslationProvider(provider.type);setProviderStatus((value)=>({...value,[provider.type]:r.ok?`${t('connectionOk')}: ${r.value}`:r.error??'Error'}))}}>{t('testConnection')}</button>
        {provider.type==='DEEPL'&&<button className="mini-action" disabled={!provider.enabled||dirty||loadingDeepLUsage} title={dirty?t('saveCredentialFirst'):undefined} onClick={async()=>{setLoadingDeepLUsage(true);setDeepLUsageStatus('');try{const usage=await window.origread.getDeepLUsage();setDeepLUsageStatus(t('deepLQuotaValue',{used:usage.characterCount.toLocaleString(),limit:usage.characterLimit.toLocaleString(),remaining:usage.remainingCharacters.toLocaleString(),percent:usage.usagePercent.toFixed(1)}))}catch(error){setDeepLUsageStatus(`${t('deepLQuotaFailed')}: ${errorText(error)}`)}finally{setLoadingDeepLUsage(false)}}}>{loadingDeepLUsage&&<RefreshCw size={13} className="spinning"/>}{t('checkDeepLQuota')}</button>}
      </div>
      {providerStatus[provider.type]&&<StatusText text={providerStatus[provider.type]!}/>}
      {provider.type==='DEEPL'&&deepLUsageStatus&&<StatusText text={deepLUsageStatus}/>}
    </></section>})}{status&&<StatusText text={status}/>}</>
}

function ArticleFilterSettingsPage():React.JSX.Element{
  const {t}=useTranslation();const [filters,setFilters]=useState<ArticleFilterSnapshot|null>(null);const [keyword,setKeyword]=useState('');const [ruleType,setRuleType]=useState<ArticleFilterRuleType>('KEYWORD');const [status,setStatus]=useState('')
  const reload=async()=>setFilters(await window.origread.getArticleFilters());useEffect(()=>{void reload()},[])
  if(!filters)return <LoadingSettings/>
  return <><PageIntro icon={<Filter size={22}/>} title={t('articleFilters')} description={t('articleFiltersDescription')}/>
    <SettingsSection icon={<Filter size={17}/>} title={t('filterStatsTitle')}>
      <SettingRow title={t('filterStatsTitle')} description={t('filterStatsDescription',{count:filters.stats.totalFiltered})}><span className="setting-value">{filters.stats.totalFiltered}</span></SettingRow>
    </SettingsSection>
    <SettingsSection icon={<Plus size={17}/>} title={t('addFilterRule')}>
      <p className="settings-card-description">{t('addFilterRuleDescription')}</p>
      <div className="rule-add-row filter-rule-add-row"><input aria-label={t('filterKeywordPlaceholder')} value={keyword} placeholder={t('filterKeywordPlaceholder')} onChange={(e)=>setKeyword(e.target.value)}/><select aria-label={t('filterRuleType')} value={ruleType} onChange={(e)=>setRuleType(e.target.value as ArticleFilterRuleType)}><option value="KEYWORD">{t('filterTypeKeyword')}</option><option value="REGEX">{t('filterTypeRegex')}</option></select><button className="mini-action icon-only" title={t('addFilterRule')} aria-label={t('addFilterRule')} disabled={!keyword.trim()} onClick={async()=>{try{setFilters(await window.origread.addArticleFilter(keyword,ruleType,null));setKeyword('')}catch(e){setStatus(errorText(e))}}}><Plus size={13}/></button></div>
    </SettingsSection>
    <SettingsSection icon={<Filter size={17}/>} title={t('articleFilters')}>
      <RuleFileActions kind="filter" onDone={(s)=>{setStatus(s);void reload()}}/>
      {filters.rules.length>0?<div className="rule-list">{filters.rules.map((rule)=><div className="rule-row" key={rule.id}><Toggle ariaLabel={rule.keyword} checked={rule.enabled} onChange={async(v)=>setFilters(await window.origread.setArticleFilterEnabled(rule.id,v))}/><div><strong>{rule.keyword}</strong><span>{rule.type==='KEYWORD'?t('filterTypeKeyword'):t('filterTypeRegex')} · {rule.feedId?rule.feedName??t('sourceFilterRule'):t('globalFilterRule')}</span></div><button className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={async()=>setFilters(await window.origread.deleteArticleFilter(rule.id))}><Trash2 size={14}/></button></div>)}</div>:<div className="settings-empty"><strong>{t('noFilterRules')}</strong><span>{t('noFilterRulesDescription')}</span></div>}
    </SettingsSection>
    {status&&<StatusText text={status}/>}</>
}

function JsonRulesSettingsPage():React.JSX.Element{
  const {t}=useTranslation();const [rules,setRules]=useState<JsonRule[]>([]);const [status,setStatus]=useState('')
  const reload=async()=>setRules(await window.origread.listJsonRules());useEffect(()=>{void reload()},[])
  return <><PageIntro icon={<FileJson2 size={22}/>} title={t('jsonRules')} description={t('jsonRulesDescription')}/>
    <SettingsSection icon={<FileJson2 size={17}/>} title={t('jsonRules')}>
      <RuleHeaderActions kind="json" onDone={setStatus} onSaved={()=>void reload()}/>
      <RuleRepositoryList rules={rules} describe={(rule)=>`${rule.hosts.join(', ')} · ${rule.sourceKind} · v${rule.version}`} onToggle={async(id,v)=>{await window.origread.setJsonRuleEnabled(id,v);await reload()}} onDelete={async(id)=>{await window.origread.deleteJsonRule(id);await reload()}}/>
    </SettingsSection>{status&&<StatusText text={status}/>}</>
}

function WebsiteRulesSettingsPage():React.JSX.Element{
  const {t}=useTranslation();const [rules,setRules]=useState<WebsiteRule[]>([]);const [status,setStatus]=useState('')
  const reload=async()=>setRules((await window.origread.listWebsiteRules()).filter((rule)=>rule.id!==INTERNAL_ITHOME_RULE_ID));useEffect(()=>{void reload()},[])
  return <><PageIntro icon={<Globe2 size={22}/>} title={t('websiteRules')} description={t('websiteRulesDescription')}/>
    <SettingsSection icon={<Globe2 size={17}/>} title={t('websiteRules')}>
      <RuleHeaderActions kind="website" onDone={setStatus} onSaved={()=>void reload()}/>
      <RuleRepositoryList rules={rules} describe={(rule)=>`${rule.hosts.join(', ')} · v${rule.version}`} onToggle={async(id,v)=>{await window.origread.setWebsiteRuleEnabled(id,v);await reload()}} onDelete={async(id)=>{await window.origread.deleteWebsiteRule(id);await reload()}}/>
      {status&&<StatusText text={status}/>}
    </SettingsSection></>
}

function RuleHeaderActions({kind,onDone,onSaved}:{kind:'json'|'website';onDone:(value:string)=>void;onSaved:()=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation();const[guide,setGuide]=useState<string|null>(null);const[dialog,setDialog]=useState<'ai'|'test'|null>(null);const[url,setUrl]=useState('');const[busy,setBusy]=useState(false);const[preview,setPreview]=useState<AiGeneratedRulePreview|null>(null);const[error,setError]=useState('');const[aiSettings,setAiSettings]=useState<AiSettings|null>(null);const[selectedProviderId,setSelectedProviderId]=useState('');const[selectedModel,setSelectedModel]=useState('');const[requestId,setRequestId]=useState('');const[progress,setProgress]=useState<AiRuleGenerationProgress|null>(null);const[showJson,setShowJson]=useState(false);const[copied,setCopied]=useState(false)
  const language:'zh'|'en'=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  const enabledProviders=aiSettings?.providers.filter((provider)=>provider.enabled)??[]
  const selectedProvider=enabledProviders.find((provider)=>provider.id===selectedProviderId)??enabledProviders[0]??null
  const showGuide=async()=>{try{setGuide(await window.origread.getRuleGuide(kind,language))}catch(e){onDone(errorText(e))}}
  const exportTemplate=async()=>{const r=await window.origread.exportRuleTemplateFile(kind);if(!r.cancelled)onDone(r.ok?t('ruleTemplateExported'):r.error??'Error')}
  const openAiDialog=async()=>{setDialog('ai');setUrl('');setError('');setProgress(null);setPreview(null);setShowJson(false);setCopied(false);try{const loaded=await window.origread.getAiSettings();const providers=loaded.providers.filter((provider)=>provider.enabled);const provider=providers.find((item)=>item.id===loaded.defaultProviderId)??providers[0];setAiSettings(loaded);setSelectedProviderId(provider?.id??'');setSelectedModel(provider?.defaultModel??provider?.models[0]??'')}catch(e){setError(errorText(e))}}
  useEffect(()=>window.origread.onAiRuleProgress((value)=>{if(value.requestId===requestId)setProgress(value)}),[requestId])
  const runDialog=async()=>{if(!url.trim()||!dialog)return;setBusy(true);setError('');try{if(dialog==='test'){const r=await window.origread.testWebsiteRule(url);if(r.ok){onDone(t('websiteRuleTestSuccess',{count:r.articleCount}));setDialog(null);setUrl('')}else setError(t('websiteRuleTestFailed',{error:r.error??''}))}else{const id=globalThis.crypto.randomUUID();setRequestId(id);setProgress({requestId:id,stage:'PREPARING',attempt:1,detail:null,at:Date.now()});setPreview(await window.origread.generateAiRule(kind==='website'?'WEBSITE':'JSON',url,{providerId:selectedProvider?.id,model:selectedModel.trim()||undefined,requestId:id}));setDialog(null)}}catch(e){setProgress((current)=>current?.requestId===requestId?{...current,stage:'FAILED',detail:errorText(e)}:current);setError(errorText(e))}finally{setBusy(false)}}
  const savePreview=async()=>{if(!preview)return;setBusy(true);setError('');try{await window.origread.saveAiGeneratedRule(preview.previewId);setPreview(null);setUrl('');onDone(t('aiRuleSaved'));onSaved()}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  const copyJson=async()=>{if(!preview)return;try{await navigator.clipboard.writeText(preview.ruleJson);setCopied(true);window.setTimeout(()=>setCopied(false),1600)}catch(e){setError(errorText(e))}}
  return <>
    <RuleActionRow icon={<CircleHelp size={16}/>} title={kind==='website'?t('websiteRuleTutorial'):t('rulesTutorial')} description={kind==='json'?t('jsonRulesTutorialDescription'):undefined} onClick={()=>void showGuide()}/>
    <RuleActionRow icon={<Sparkles size={16}/>} title={kind==='website'?t('aiGenerateWebsiteRule'):t('aiGenerateJsonRule')} description={t('aiGenerateRuleDescription')} onClick={()=>void openAiDialog()}/>
    <RuleActionRow icon={<FileText size={16}/>} title={kind==='website'?t('exportWebsiteRuleTemplate'):t('exportJsonRuleTemplate')} onClick={()=>void exportTemplate()}/>
    <RuleFileActions kind={kind} onDone={(s)=>{onDone(s);onSaved()}}/>
    {kind==='website'&&<RuleActionRow icon={<Search size={16}/>} title={t('testWebsiteRule')} onClick={()=>{setDialog('test');setUrl('');setError('')}}/>}
    {guide!==null&&<RuleModal title={kind==='website'?t('websiteRuleTutorial'):t('rulesTutorial')} onClose={()=>setGuide(null)}><MarkdownContent text={guide}/></RuleModal>}
    {dialog==='ai'&&<RuleModal wide title={kind==='website'?t('aiGenerateWebsiteRule'):t('aiGenerateJsonRule')} description={t('aiRuleDialogDescription')} onClose={()=>!busy&&setDialog(null)}>
      <div className="ai-rule-dialog">
        <div className="ai-rule-steps"><AiRuleStep active={progress===null} number="1" label={t('aiRuleStepTarget')}/><ArrowRight size={14}/><AiRuleStep active={false} number="2" label={t('aiRuleStepService')}/><ArrowRight size={14}/><AiRuleStep active={progress!==null} number="3" label={t('aiRuleStepGenerate')}/></div>
        <div className="ai-rule-card ai-rule-target-card"><div className="ai-rule-card-heading"><span className="ai-rule-card-icon"><Link2 size={15}/></span><div><strong>{t('aiRuleStepTarget')}</strong><span>{t('aiRuleTargetHint')}</span></div></div><label className="rule-dialog-field"><span>{t('targetUrl')}</span><input autoFocus value={url} placeholder={kind==='website'?'https://www.example.com/news/':'https://api.example.com/posts'} disabled={busy} onChange={(e)=>setUrl(e.target.value)}/></label></div>
        <div className="ai-rule-card"><div className="ai-rule-card-heading"><span className="ai-rule-card-icon"><Bot size={15}/></span><div><strong>{t('aiRuleStepService')}</strong><span>{t('aiRuleProviderHint')}</span></div></div>{enabledProviders.length===0?<div className="ai-rule-empty"><CircleAlert size={16}/><span>{t('aiRuleNoProvider')}</span></div>:<div className="ai-rule-provider-grid">{enabledProviders.map((provider)=><button type="button" key={provider.id} className={`ai-rule-provider-option ${provider.id===selectedProvider?.id?'selected':''}`} disabled={busy} onClick={()=>{setSelectedProviderId(provider.id);setSelectedModel(provider.defaultModel||provider.models[0]||'')}}><span className="ai-rule-provider-mark"><Bot size={15}/></span><span className="ai-rule-provider-copy"><strong>{provider.name}</strong><small>{t('aiRuleModelChoices',{count:provider.models.length+(provider.defaultModel?1:0)})}</small></span>{provider.id===aiSettings?.defaultProviderId&&<em>{t('aiRuleDefault')}</em>}{provider.id===selectedProvider?.id&&<CheckCircle2 size={16}/>}</button>)}</div>}</div>
        {selectedProvider&&<div className="ai-rule-card"><div className="ai-rule-card-heading"><span className="ai-rule-card-icon"><ListChecks size={15}/></span><div><strong>{t('aiRuleModel')}</strong><span>{t('aiRuleModelHint')}</span></div></div><AiRuleModelPicker provider={selectedProvider} value={selectedModel} disabled={busy} onChange={setSelectedModel}/></div>}
        {progress&&<AiRuleProgressPanel progress={progress} busy={busy}/>} {error&&<div className="rule-dialog-error"><CircleAlert size={15}/><span>{error}</span></div>}
        <div className="rule-dialog-actions"><button className="mini-action secondary" disabled={busy} onClick={()=>setDialog(null)}>{t('cancel')}</button><button className="dialog-submit" disabled={busy||!url.trim()||!selectedModel.trim()||!selectedProvider} onClick={()=>void runDialog()}><Sparkles size={14}/>{busy?t('working'):t('generate')}</button></div>
      </div>
    </RuleModal>}
    {dialog==='test'&&<RuleModal title={t('testWebsiteRule')} onClose={()=>!busy&&setDialog(null)}><label className="rule-dialog-field"><span>{t('targetUrl')}</span><input autoFocus value={url} placeholder="https://www.example.com/news/" disabled={busy} onChange={(e)=>setUrl(e.target.value)}/></label>{error&&<div className="rule-dialog-error">{error}</div>}<div className="rule-dialog-actions"><button className="mini-action secondary" disabled={busy} onClick={()=>setDialog(null)}>{t('cancel')}</button><button className="mini-action" disabled={busy||!url.trim()} onClick={()=>void runDialog()}>{busy?t('working'):t('testWebsiteRule')}</button></div></RuleModal>}
    {preview&&<RuleModal wide title={t('aiRulePreviewTitle')} description={t('aiRulePreviewSubtitle')} onClose={()=>!busy&&setPreview(null)}><div className="ai-rule-preview"><div className="ai-rule-validation"><div><strong><CheckCircle2 size={16}/>{t('aiRuleLocalValidationPassed')}</strong><span>{t('aiRuleValidationHint')}</span></div><span className="ai-rule-score-badge">{preview.score}</span></div><div className={`ai-rule-content-status ${preview.contentStatus.toLowerCase()}`}><strong>{preview.contentStatus==='VERIFIED'?t('aiRuleContentVerified'):preview.contentStatus==='FAILED'?t('aiRuleContentFailed'):t('aiRuleContentSkipped')}</strong><span>{preview.contentMessage??t('aiRuleContentNoMessage')}{preview.contentSampleCount>0?` · ${t('aiRuleContentSamples',{count:preview.contentSampleCount})}`:''}</span></div><div className="ai-rule-metrics"><AiRuleMetric value={String(preview.articleCount)} label={t('aiRuleArticles')}/><AiRuleMetric value={String(preview.score)} label={t('aiRuleScore')}/><AiRuleMetric value={String(preview.attempts)} label={t('aiRuleAttempts')}/></div><div className="ai-rule-runtime"><span>{t('aiRulePreviewRuntime',{provider:preview.providerName,model:preview.model,attempts:preview.attempts})}</span>{preview.finalUrl!==preview.targetUrl&&<span>{t('aiRulePreviewFinalUrl',{url:preview.finalUrl})}</span>}{preview.sourceKind&&<span>{t('aiRulePreviewSourceKind',{kind:preview.sourceKind})}</span>}</div>{preview.sampleTitles.length>0&&<div className="ai-rule-samples"><strong>{t('aiRuleSampleArticles')}</strong>{preview.sampleTitles.map((title,index)=><span key={index}><CheckCircle2 size={13}/>{title}</span>)}</div>}<div className="ai-rule-json-heading"><strong>{t('aiRuleJsonPreview')}</strong><button className="mini-action secondary" onClick={()=>void copyJson()}><Copy size={13}/>{copied?t('aiRuleCopied'):t('aiRuleCopyJson')}</button></div><button type="button" className="ai-rule-json-toggle" onClick={()=>setShowJson((value)=>!value)}>{showJson?<ChevronUp size={14}/>:<ChevronDown size={14}/>}<span>{showJson?t('aiRuleHideJson'):t('aiRuleShowJson')}</span></button>{showJson&&<pre className="rule-json-preview">{preview.ruleJson}</pre>}{error&&<div className="rule-dialog-error">{error}</div>}<div className="rule-dialog-actions"><button className="mini-action secondary" disabled={busy} onClick={()=>setPreview(null)}>{t('cancel')}</button><button className="dialog-submit" disabled={busy} onClick={()=>void savePreview()}><CheckCircle2 size={14}/>{t('aiRuleSave')}</button></div></div></RuleModal>}
  </>
}

function AiRuleStep({active,number,label}:{active:boolean;number:string;label:string}){return <span className={`ai-rule-step ${active?'active':''}`}><b>{number}</b>{label}</span>}
function AiRuleMetric({value,label}:{value:string;label:string}){return <div><strong>{value}</strong><span>{label}</span></div>}
function AiRuleModelPicker({provider,value,disabled,onChange}:{provider:AiProviderProfile;value:string;disabled:boolean;onChange:(value:string)=>void}){
  const {t}=useTranslation();const models=useMemo(()=>Array.from(new Set([provider.defaultModel,...provider.models].map((value)=>value.trim()).filter(Boolean))),[provider]);const[open,setOpen]=useState(false);const[custom,setCustom]=useState(false);const[query,setQuery]=useState('')
  useEffect(()=>{setOpen(false);setCustom(false);setQuery('')},[provider.id])
  const filtered=models.filter((model)=>!query.trim()||model.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="ai-rule-model-picker"><div className="ai-rule-model-control"><Search size={14}/><input value={custom?query:value} readOnly={!custom} disabled={disabled} placeholder={t('aiRuleModelSelectHint')} onFocus={()=>{if(!custom){setQuery('');setOpen(true)}}} onChange={(e)=>{setQuery(e.target.value);onChange(e.target.value)}}/><button type="button" disabled={disabled} onClick={()=>{if(custom){setCustom(false);setQuery('')}else{setQuery('');setOpen(true)}}}>{custom?<ChevronUp size={14}/>:<ChevronDown size={14}/>}</button></div>{open&&!custom&&<div className="ai-rule-model-menu"><label><Search size={13}/><input autoFocus value={query} placeholder={t('aiRuleSearchModel')} onChange={(e)=>setQuery(e.target.value)}/></label><div className="ai-rule-model-options">{filtered.length>0?filtered.map((model)=><button type="button" key={model} className={model===value?'selected':''} onClick={()=>{onChange(model);setOpen(false);setQuery('')}}><span>{model}</span>{model===provider.defaultModel&&<em>{t('aiRuleDefault')}</em>}{model===value&&<CheckCircle2 size={14}/>}</button>):<span className="ai-rule-no-match">{t('aiRuleNoModelMatch')}</span>}</div><button type="button" className="ai-rule-custom-model" onClick={()=>{setCustom(true);setQuery(value);setOpen(false)}}>{t('aiRuleUseCustomModel')}</button></div>}<small>{custom?t('aiRuleModelCustomHint'):t('aiRuleModelChoices',{count:models.length})}</small></div>
}
function AiRuleProgressPanel({progress,busy}:{progress:AiRuleGenerationProgress;busy:boolean}){const{t}=useTranslation();const stages:AiRuleGenerationProgress['stage'][]=['PREPARING','FETCHING_SOURCE','ANALYZING_SOURCE','GENERATING_CANDIDATE','VALIDATING_CANDIDATE','REPAIRING_CANDIDATE','FETCHING_CONTENT','GENERATING_CONTENT','VALIDATING_CONTENT','COMPLETED'];const index=Math.max(0,stages.indexOf(progress.stage));const failed=progress.stage==='FAILED';return <div className={`ai-rule-progress-panel ${failed?'failed':''}`} role="status"><div className="ai-rule-progress-heading">{failed?<CircleAlert size={16}/>:progress.stage==='COMPLETED'?<CheckCircle2 size={16}/>:<Sparkles size={16}/>}<div><strong>{t(aiRuleProgressLabelKey(progress.stage))}</strong><span>{progress.attempt>1?t('aiRuleAttempt',{count:progress.attempt}):t('aiRuleProgressHint')}</span></div>{busy&&<RefreshCw size={14} className="spinning"/>}</div><div className="ai-rule-progress-track"><span style={{width:`${failed?100:Math.max(8,((index+1)/stages.length)*100)}%`}}/></div><div className="ai-rule-progress-stages">{stages.map((stage,stageIndex)=><span className={stageIndex<=index?'done':''} key={stage}>{stageIndex<index?'✓':stageIndex===index?'●':'○'} {t(aiRuleProgressLabelKey(stage))}</span>)}</div>{progress.detail&&<small>{progress.detail}</small>}</div>}

function aiRuleProgressLabelKey(stage: AiRuleGenerationProgress['stage']): string {
  switch(stage){
    case 'PREPARING': return 'aiRuleStagePreparing'
    case 'FETCHING_SOURCE': return 'aiRuleStageFetching'
    case 'ANALYZING_SOURCE': return 'aiRuleStageAnalyzing'
    case 'GENERATING_CANDIDATE': return 'aiRuleStageGenerating'
    case 'VALIDATING_CANDIDATE': return 'aiRuleStageValidating'
    case 'REPAIRING_CANDIDATE': return 'aiRuleStageRepairing'
    case 'FETCHING_CONTENT': return 'aiRuleStageFetchingContent'
    case 'GENERATING_CONTENT': return 'aiRuleStageGeneratingContent'
    case 'VALIDATING_CONTENT': return 'aiRuleStageValidatingContent'
    case 'COMPLETED': return 'aiRuleStageCompleted'
    case 'FAILED': return 'aiRuleStageFailed'
  }
}

function RssHubSettingsPage():React.JSX.Element{
  const{t,i18n}=useTranslation();const[settings,setSettings]=useState<RssHubSettings|null>(null);const[url,setUrl]=useState('');const[testing,setTesting]=useState<string|null>(null);const[results,setResults]=useState<Record<string,string>>({});const[status,setStatus]=useState('')
  const language:RssHubUiLanguage=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  const reload=()=>void window.origread.getRssHubSettings().then(setSettings);useEffect(reload,[])
  if(!settings)return <LoadingSettings/>
  const test=async(instanceUrl:string,addOnSuccess=false)=>{if(testing)return;setTesting(instanceUrl);try{const result=await window.origread.testRssHubInstance(instanceUrl);if(result.ok){setResults((value)=>({...value,[instanceUrl]:t('rssHubTestSuccess')}));if(addOnSuccess){setSettings(await window.origread.addRssHubInstance(instanceUrl));setUrl('')}}else setResults((value)=>({...value,[instanceUrl]:`${t('rssHubTestFailed')}${result.error??''}`}))}finally{setTesting(null)}}
  return <><PageIntro icon={<RadioTower size={22}/>} title={t('rssHubSettings')} description={t('rssHubSettingsDescription')}/>
    <SettingsSection icon={<RadioTower size={17}/>} title={t('rssHubEnable')}><SettingRow title={t('rssHubEnable')} description={t('rssHubEnableDescription')}><Toggle ariaLabel={t('rssHubEnable')} checked={settings.enabled} onChange={async(v)=>setSettings(await window.origread.setRssHubEnabled(v))}/></SettingRow></SettingsSection>
    <SettingsSection icon={<RadioTower size={17}/>} title={t('rssHubInstanceList')}><p className="settings-card-description rsshub-list-description">{t('rssHubInstanceListDescription')}</p><div className="rsshub-instance-list">{settings.instances.map((instance)=>{const location=formatRssHubLocation(instance.location,language);return <div className="rsshub-instance-row" key={instance.id}><div className="rsshub-instance-head"><div><strong>{instance.url}</strong>{[location,instance.maintainer].filter(Boolean).length>0&&<span>{[location,instance.maintainer].filter(Boolean).join(' · ')}</span>}</div><Toggle ariaLabel={instance.url} checked={instance.enabled} disabled={!settings.enabled} onChange={async(v)=>setSettings(await window.origread.setRssHubInstanceEnabled(instance.id,v))}/></div><div className="rsshub-instance-actions"><button className="mini-action secondary" disabled={!settings.enabled||testing!==null} onClick={()=>void test(instance.url)}>{testing===instance.url?t('working'):t('rssHubTestInstance')}</button>{results[instance.url]&&<span>{results[instance.url]}</span>}<button className="icon-button danger" disabled={!settings.enabled} title={t('rssHubDeleteInstance')} aria-label={t('rssHubDeleteInstance')} onClick={async()=>setSettings(await window.origread.deleteRssHubInstance(instance.id))}><Trash2 size={14}/></button></div></div>})}</div></SettingsSection>
    <SettingsSection icon={<Plus size={17}/>} title={t('rssHubAddInstance')}><div className="rsshub-add-row"><label><span>{t('rssHubInstanceUrl')}</span><input disabled={!settings.enabled} value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://rsshub.example.com"/><small>{t('rssHubInstanceDescription')}</small></label><button className="mini-action" disabled={!settings.enabled||!url.trim()||testing!==null} onClick={()=>void test(url,true)}>{testing!==null?t('working'):t('rssHubSaveAndTest')}</button></div><button className="mini-action secondary rsshub-restore" onClick={async()=>{setSettings(await window.origread.restoreDefaultRssHubSettings());setResults({});setUrl('');setStatus(t('restoreDefaultsDone'))}}><RotateCcw size={13}/>{t('restoreDefaults')}</button></SettingsSection>{status&&<StatusText text={status}/>}</>
}

function BackupSettingsPage({onRestored}:{onRestored?:()=>void}):React.JSX.Element{
  const {t}=useTranslation();const[includeSecrets,setIncludeSecrets]=useState(false);const[password,setPassword]=useState('');const[status,setStatus]=useState('');const[busy,setBusy]=useState(false)
  return <><PageIntro icon={<DatabaseBackup size={22}/>} title={t('backupRestore')} description={t('backupRestoreDescription')}/>
    <SettingsSection icon={<DatabaseBackup size={17}/>} title={t('backupScopeTitle')}>
      <div className="settings-banner"><strong>{t('backupScopeTitle')}</strong><span>{t('backupScopeDescription')}</span></div>
      <SettingRow title={t('backupIncludeSecrets')} description={t('backupIncludeSecretsDescription')}><Toggle ariaLabel={t('backupIncludeSecrets')} checked={includeSecrets} onChange={(value)=>{setIncludeSecrets(value);if(!value)setPassword('')}}/></SettingRow>
      {includeSecrets&&<SettingRow title={t('backupPassword')} description={t('backupPasswordDescription')}><input aria-label={t('backupPassword')} type="password" value={password} onChange={(e)=>setPassword(e.target.value)}/></SettingRow>}
      <SettingsActionRow icon={<Download size={16}/>} title={t('exportBackup')} description={t('exportBackupDescription')} disabled={busy||(includeSecrets&&password.length<6)} onClick={async()=>{setBusy(true);const r=await window.origread.exportConfigurationBackup(includeSecrets?password:'');setBusy(false);if(!r.cancelled)setStatus(r.ok?`${t('backupSaved')}: ${r.path}`:r.error??'Error')}}/>
      <SettingsActionRow icon={<Upload size={16}/>} title={t('restoreBackup')} description={t('restoreBackupDescription')} disabled={busy} onClick={async()=>{setBusy(true);const r=await window.origread.restoreConfigurationBackup(password);setBusy(false);if(!r.cancelled){setStatus(r.ok?t('restoreSuccess',{feeds:r.restoreResult?.feedsAdded??0,updated:r.restoreResult?.feedsUpdated??0}):r.error??'Error');if(r.ok)onRestored?.()}}}/>
    </SettingsSection>{status&&<StatusText text={status}/>}</>
}

function RuleRepositoryList<T extends {id:string;name:string;enabled:boolean}>({rules,describe,onToggle,onDelete}:{rules:T[];describe:(rule:T)=>string;onToggle:(id:string,value:boolean)=>void;onDelete:(id:string)=>void}){const{t}=useTranslation();return <div className="rule-list">{rules.map((rule)=><div className="rule-row" key={rule.id}><Toggle ariaLabel={rule.name} checked={rule.enabled} onChange={(v)=>onToggle(rule.id,v)}/><div><strong>{rule.name}</strong><span>{describe(rule)}</span></div><button className="icon-button danger" title={t('delete')} aria-label={t('delete')} onClick={()=>onDelete(rule.id)}><Trash2 size={14}/></button></div>)}</div>}
function RuleFileActions({kind,onDone}:{kind:'website'|'json'|'filter';onDone:(status:string)=>void}){const{t}=useTranslation();return <div className="rule-file-actions"><button className="mini-action" onClick={async()=>{const r=await window.origread.importRuleFile(kind);if(!r.cancelled)onDone(r.ok?t('rulesImported',{count:r.count}):r.error??'Error')}}><Upload size={13}/>{t('importRules')}</button><button className="mini-action" onClick={async()=>{const r=await window.origread.exportRuleFile(kind);if(!r.cancelled)onDone(r.ok?t('rulesExported'):r.error??'Error')}}><Download size={13}/>{t('exportRules')}</button></div>}

function providerName(type:TranslationProviderType):string{return{ML_KIT:'',MICROSOFT:'Microsoft Translator',DEEPL:'DeepL',GOOGLE_CLOUD:'Google Cloud Translation',DLX:'DeepLX / DLX'}[type]}
function translationProviderDescriptionKey(type:TranslationProviderType):string{return{ML_KIT:'',MICROSOFT:'translationProviderMicrosoftDescription',DEEPL:'translationProviderDeepLDescription',GOOGLE_CLOUD:'translationProviderGoogleCloudDescription',DLX:'translationProviderDlxDescription'}[type]}
function SettingsNavButton({active,icon,label,onClick}:{active:boolean;icon:React.ReactNode;label:string;onClick:()=>void}){return <button className={`settings-nav-button ${active?'active':''}`} onClick={onClick}>{icon}<span>{label}</span></button>}
function PageIntro({icon,title,description}:{icon:React.ReactNode;title:string;description:string}){return <div className="settings-intro"><div className="settings-intro-icon">{icon}</div><div><h1>{title}</h1><p>{description}</p></div></div>}
function SettingsSection({icon,title,children}:{icon:React.ReactNode;title:string;children:React.ReactNode}){return <section className="settings-section"><div className="settings-section-title">{icon}<span>{title}</span></div><div className="settings-card">{children}</div></section>}
function SettingRow({title,description,children,className=''}:{title:string;description:string;children:React.ReactNode;className?:string}){return <div className={`setting-row ${className}`.trim()}><div className="setting-copy"><strong>{title}</strong><span>{description}</span></div><div className="setting-control">{children}</div></div>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="provider-field"><span>{label}</span>{children}</label>}
function AiSecretKeyEditor({value,hasStoredValue,storedLength,dirty,visible,onChange,onToggle,onSave}:{value:string;hasStoredValue:boolean;storedLength:number;dirty:boolean;visible:boolean;onChange:(value:string)=>void;onToggle:()=>void;onSave:()=>void}){const{t}=useTranslation();const placeholder=hasStoredValue&&!dirty?t('credentialStored',{count:storedLength}):t('notConfigured');return <div className="secret-key-editor"><div className="secret-key-input-wrap"><input className="secret-key-input" type={visible?'text':'password'} value={value} autoComplete="off" spellCheck={false} placeholder={placeholder} onChange={(e)=>onChange(e.target.value)}/><button type="button" className="secret-key-eye" disabled={!value&&!hasStoredValue} title={visible?t('hideCredential'):t('showCredential')} aria-label={visible?t('hideCredential'):t('showCredential')} onClick={onToggle}>{visible?<EyeOff size={15}/>:<Eye size={15}/>}</button></div><button type="button" className="mini-action secret-key-save" disabled={!dirty} onClick={onSave}><Save size={13}/>{value?t('saveCredential'):hasStoredValue?t('removeCredential'):t('saveCredential')}</button><small className={`secret-key-state ${dirty?'dirty':'saved'}`}>{dirty?t('credentialUnsaved'):hasStoredValue?t('credentialStored',{count:storedLength}):t('credentialNotStored')}</small></div>}
function SecretKeyEditor({value,savedValue,visible,onChange,onToggle,onSave,disabled=false,optional=false}:{value:string;savedValue:string;visible:boolean;onChange:(value:string)=>void;onToggle:()=>void;onSave:()=>void;disabled?:boolean;optional?:boolean}){const{t}=useTranslation();const dirty=value!==savedValue;return <div className="secret-key-editor"><div className="secret-key-input-wrap"><input className="secret-key-input" disabled={disabled} type={visible?'text':'password'} value={value} autoComplete="off" spellCheck={false} placeholder={optional?t('optional'):t('notConfigured')} onChange={(e)=>onChange(e.target.value)}/><button type="button" className="secret-key-eye" disabled={disabled||!value} title={visible?t('hideCredential'):t('showCredential')} aria-label={visible?t('hideCredential'):t('showCredential')} onClick={onToggle}>{visible?<EyeOff size={15}/>:<Eye size={15}/>}</button></div><button type="button" className="mini-action secret-key-save" disabled={disabled||!dirty} onClick={onSave}><Save size={13}/>{value?t('saveCredential'):savedValue?t('removeCredential'):t('saveCredential')}</button><small className={`secret-key-state ${dirty?'dirty':'saved'}`}>{dirty?t('credentialUnsaved'):savedValue?t('credentialStored',{count:savedValue.length}):t('credentialNotStored')}</small></div>}
function summaryLengthDescriptionKey(length:AiSettings['summaryLength']):string{return length==='BRIEF'?'summaryBriefDescription':length==='DETAILED'?'summaryDetailedDescription':'summaryStandardDescription'}
function RuleActionRow({icon,title,description,disabled=false,unavailable=false,onClick}:{icon:React.ReactNode;title:string;description?:string;disabled?:boolean;unavailable?:boolean;onClick?:()=>void}){if(onClick)return <button type="button" className={`settings-action-row interactive ${unavailable?'disabled':''}`} data-unavailable={unavailable||undefined} disabled={disabled} onClick={onClick}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong>{description&&<span>{description}</span>}</div></button>;return <div className={`settings-action-row ${disabled||unavailable?'disabled':''}`}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong>{description&&<span>{description}</span>}</div></div>}
function SettingsActionRow({icon,title,description,onClick,disabled=false}:{icon:React.ReactNode;title:string;description:string;onClick:()=>void;disabled?:boolean}){return <button type="button" className="settings-action-row interactive" disabled={disabled} onClick={onClick}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong><span>{description}</span></div></button>}
function RuleModal({title,description,wide=false,onClose,children}:{title:string;description?:string;wide?:boolean;onClose:()=>void;children:React.ReactNode}){return <div className="rule-modal-backdrop" role="presentation" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose()}}><section className={`rule-modal ${wide?'wide':''}`} role="dialog" aria-modal="true"><header><div><h2>{title}</h2>{description&&<p>{description}</p>}</div><button type="button" className="icon-button" onClick={onClose}><X size={17}/></button></header><div className="rule-modal-body">{children}</div></section></div>}
function MarkdownContent({text}:{text:string}){
  const lines=text.replace(/\r\n/g,'\n').split('\n');const blocks:React.ReactNode[]=[];let index=0
  while(index<lines.length){
    const line=lines[index]??''
    const headers=parseMarkdownTableRow(line);const separator=parseMarkdownTableRow(lines[index+1]??'')
    if(headers&&separator&&headers.length===separator.length&&isMarkdownTableSeparator(separator)){
      const rows:string[][]=[];index+=2
      while(index<lines.length){const row=parseMarkdownTableRow(lines[index]??'');if(!row||row.length!==headers.length)break;rows.push(row);index++}
      blocks.push(<div className="rule-guide-table-scroll" key={blocks.length}><table className="rule-guide-table"><thead><tr>{headers.map((cell,cellIndex)=><th key={cellIndex}>{renderMarkdownInline(cell)}</th>)}</tr></thead><tbody>{rows.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,cellIndex)=><td key={cellIndex}>{renderMarkdownInline(cell)}</td>)}</tr>)}</tbody></table></div>);continue
    }
    if(!line.trim()){index++;continue}
    if(line.startsWith('```')){const code:string[]=[];index++;while(index<lines.length&&!((lines[index]??'').startsWith('```'))){code.push(lines[index]??'');index++}if(index<lines.length)index++;blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>);continue}
    if(/^#{1,6}\s/.test(line)){const level=line.match(/^(#+)/)?.[1]?.length??1;const value=line.replace(/^#{1,6}\s*/,'');const Heading: 'h2'|'h3'|'h4'=level<=1?'h2':level===2?'h3':'h4';blocks.push(<Heading key={blocks.length}>{renderMarkdownInline(value)}</Heading>);index++;continue}
    if(/^[-*]\s+/.test(line)){const items:string[]=[];while(index<lines.length&&/^[-*]\s+/.test(lines[index]??'')){items.push((lines[index]??'').replace(/^[-*]\s+/,''));index++}blocks.push(<ul key={blocks.length}>{items.map((item,itemIndex)=><li key={itemIndex}>{renderMarkdownInline(item)}</li>)}</ul>);continue}
    if(/^\d+[.)]\s+/.test(line)){const items:string[]=[];while(index<lines.length&&/^\d+[.)]\s+/.test(lines[index]??'')){items.push((lines[index]??'').replace(/^\d+[.)]\s+/,''));index++}blocks.push(<ol key={blocks.length}>{items.map((item,itemIndex)=><li key={itemIndex}>{renderMarkdownInline(item)}</li>)}</ol>);continue}
    if(/^>\s?/.test(line)){const quote:string[]=[];while(index<lines.length&&/^>\s?/.test(lines[index]??'')){quote.push((lines[index]??'').replace(/^>\s?/,''));index++}blocks.push(<blockquote key={blocks.length}>{quote.map((item,itemIndex)=><div key={itemIndex}>{renderMarkdownInline(item)}</div>)}</blockquote>);continue}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){blocks.push(<hr key={blocks.length}/>);index++;continue}
    const paragraph:string[]=[line];index++;while(index<lines.length&&(lines[index]??'').trim()&&!/^```|^#{1,6}\s|^[-*]\s+|^\d+[.)]\s+|^>\s?|^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[index]??'')){paragraph.push(lines[index]??'');index++}blocks.push(<p key={blocks.length}>{renderMarkdownInline(paragraph.join('\n'))}</p>)
  }
  return <div className="rule-guide-content">{blocks}</div>
}
function parseMarkdownTableRow(value:string):string[]|null{const line=value.trim();if(!line.includes('|'))return null;const cells=line.replace(/^\|/,'').replace(/\|$/,'').split('|').map((cell)=>cell.trim());return cells.length>=2&&cells.some(Boolean)?cells:null}
function isMarkdownTableSeparator(cells:string[]):boolean{return cells.length>=2&&cells.every((cell)=>/^:?-{3,}:?$/.test(cell.replace(/\s/g,'')))}
function renderMarkdownInline(value:string):React.ReactNode[]{const tokens=/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\))/g;const parts=value.split(tokens);return parts.map((part,index)=>{if(!part)return null;if((part.startsWith('**')&&part.endsWith('**'))||(part.startsWith('__')&&part.endsWith('__')))return <strong key={index}>{part.slice(2,-2)}</strong>;if(part.startsWith('`')&&part.endsWith('`'))return <code key={index}>{part.slice(1,-1)}</code>;const link=part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)$/);if(link)return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;return <span key={index}>{part}</span>})}
function GuideMarkdown({text}:{text:string}){return <MarkdownContent text={text}/>}
function Toggle({checked,onChange,disabled=false,ariaLabel}:{checked:boolean;onChange:(value:boolean)=>void;disabled?:boolean;ariaLabel:string}){return <label className="setting-switch"><input type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={(e)=>onChange(e.target.checked)}/><span/></label>}
function StatusText({text}:{text:string}){return <div className="settings-status">{text}</div>}
function LoadingSettings(){const{t}=useTranslation();return <div className="article-body-status">{t('loadingContent')}</div>}
function syncIntervalLabel(minutes:SyncIntervalMinutes,t:(key:string,options?:Record<string,unknown>)=>string):string{if(minutes===0)return t('syncManual');if(minutes<60)return t('syncEveryMinutes',{count:minutes});if(minutes===60)return t('syncEveryHour');if(minutes<1440)return t('syncEveryHours',{count:minutes/60});return t('syncEveryDay')}
function formatDate(value:number|null|undefined,fallback:string,locale:string):string{return value?new Date(value).toLocaleString(locale):fallback}
function errorText(error:unknown):string{return error instanceof Error?error.message:String(error)}
function withoutKey<T>(source:Record<string,T>,key:string):Record<string,T>{const next={...source};delete next[key];return next}

