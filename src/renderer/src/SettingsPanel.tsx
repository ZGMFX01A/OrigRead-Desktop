import { BookOpenText, Bot, Clock3, DatabaseBackup, FileJson2, Filter, Globe2, Languages, Plus, RefreshCw, Settings2, Trash2, Upload, Download, CircleHelp, Sparkles, FileText, Search, RadioTower, RotateCcw, X, Eye, EyeOff, Save } from 'lucide-react'
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
import type { RssHubSettings } from '../../shared/rsshub'
import type { AiGeneratedRuleKind, AiGeneratedRulePreview } from '../../shared/ai-rule'

type SettingsPage = 'general' | 'translation' | 'ai' | 'filters' | 'jsonRules' | 'websiteRules' | 'rsshub' | 'backup'
const INTERNAL_ITHOME_RULE_ID = 'ithome-home'

interface SettingsPanelProps {
  settings: DesktopSettings
  appInfo: AppInfo | null
  syncState: SyncRuntimeState | null
  onChange(patch: DesktopSettingsPatch): void
  onConfigurationRestored?(): void
}

export function SettingsPanel({ settings, appInfo, syncState, onChange, onConfigurationRestored }: SettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<SettingsPage>('general')
  return <div className="settings-layout">
    <aside className="settings-nav">
      <div className="settings-nav-title"><Settings2 size={18}/><span>{t('settings')}</span></div>
      <SettingsNavButton active={page==='general'} icon={<Globe2 size={16}/>} label={t('settingsGeneral')} onClick={()=>setPage('general')}/>
      <SettingsNavButton active={page==='ai'} icon={<Bot size={16}/>} label={t('aiSettingsTitle')} onClick={()=>setPage('ai')}/>
      <SettingsNavButton active={page==='translation'} icon={<Languages size={16}/>} label={t('translationSettingsTitle')} onClick={()=>setPage('translation')}/>
      <SettingsNavButton active={page==='filters'} icon={<Filter size={16}/>} label={t('articleFilters')} onClick={()=>setPage('filters')}/>
      <SettingsNavButton active={page==='jsonRules'} icon={<FileJson2 size={16}/>} label={t('jsonRules')} onClick={()=>setPage('jsonRules')}/>
      <SettingsNavButton active={page==='websiteRules'} icon={<Globe2 size={16}/>} label={t('websiteRules')} onClick={()=>setPage('websiteRules')}/>
      <SettingsNavButton active={page==='rsshub'} icon={<RadioTower size={16}/>} label={t('rssHubSettings')} onClick={()=>setPage('rsshub')}/>
      <SettingsNavButton active={page==='backup'} icon={<DatabaseBackup size={16}/>} label={t('backupRestore')} onClick={()=>setPage('backup')}/>
      <div className="settings-nav-spacer" />
      <small>{appInfo ? `v${appInfo.version} · ${appInfo.platform}` : '—'}</small>
    </aside>
    <div className="settings-page settings-subpage">
      {page==='general' && <GeneralSettings settings={settings} syncState={syncState} onChange={onChange}/>}
      {page==='translation' && <TranslationSettingsPage/>}
      {page==='ai' && <AiSettingsPage/>}
      {page==='filters' && <ArticleFilterSettingsPage/>}
      {page==='jsonRules' && <JsonRulesSettingsPage/>}
      {page==='websiteRules' && <WebsiteRulesSettingsPage/>}
      {page==='rsshub' && <RssHubSettingsPage/>}
      {page==='backup' && <BackupSettingsPage onRestored={onConfigurationRestored}/>}
    </div>
  </div>
}

function GeneralSettings({settings,syncState,onChange}:{settings:DesktopSettings;syncState:SyncRuntimeState|null;onChange:(patch:DesktopSettingsPatch)=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation();const locale=i18n.resolvedLanguage?.startsWith('zh')?'zh-CN':'en-US'
  return <>
    <PageIntro icon={<Settings2 size={22}/>} title={t('settingsGeneral')} description={t('settingsDescription')}/>
    <SettingsSection icon={<Globe2 size={17}/>} title={t('settingsGeneral')}>
      <SettingRow title={t('language')} description={t('languageDescription')}><select className="language-select" value={settings.language} onChange={(e)=>onChange({language:e.target.value as DesktopSettings['language']})}><option value="system">{t('languageSystem')}</option><option value="zh">简体中文</option><option value="en">English</option></select></SettingRow>
    </SettingsSection>
    <SettingsSection icon={<BookOpenText size={17}/>} title={t('settingsReading')}>
      <SettingRow title={t('readerFontSize')} description={t('readerFontSizeDescription')}><select className="reader-font-size-select" value={settings.readerFontSize} onChange={(e)=>onChange({readerFontSize:Number(e.target.value)})}><option value={15}>{t('readerFontSmall')}</option><option value={17}>{t('readerFontStandard')}</option><option value={19}>{t('readerFontLarge')}</option><option value={21}>{t('readerFontExtraLarge')}</option></select></SettingRow>
      <SettingRow title={t('readerLineHeight')} description={t('readerLineHeightDescription')}><select className="reader-line-height-select" value={settings.readerLineHeight} onChange={(e)=>onChange({readerLineHeight:Number(e.target.value)})}><option value={1.65}>{t('readerCompact')}</option><option value={1.85}>{t('readerStandard')}</option><option value={2.05}>{t('readerRelaxed')}</option></select></SettingRow>
      <SettingRow title={t('readerContentWidth')} description={t('readerContentWidthDescription')}><select className="reader-content-width-select" value={settings.readerContentWidth} onChange={(e)=>onChange({readerContentWidth:Number(e.target.value)})}><option value={680}>{t('readerWidthNarrow')}</option><option value={760}>{t('readerWidthStandard')}</option><option value={900}>{t('readerWidthWide')}</option></select></SettingRow>
    </SettingsSection>
    <SettingsSection icon={<Clock3 size={17}/>} title={t('settingsSync')}>
      <SettingRow title={t('syncInterval')} description={t('syncIntervalDescription')}><select className="sync-interval-select" value={settings.syncIntervalMinutes} onChange={(e)=>onChange({syncIntervalMinutes:Number(e.target.value) as SyncIntervalMinutes})}>{SYNC_INTERVAL_OPTIONS.map((m)=><option key={m} value={m}>{syncIntervalLabel(m,t)}</option>)}</select></SettingRow>
      <SettingRow title={t('syncOnStart')} description={t('syncOnStartDescription')}><Toggle checked={settings.syncOnStart} onChange={(value)=>onChange({syncOnStart:value})}/></SettingRow>
      <div className="sync-runtime-card"><div><span>{t('syncStatus')}</span><strong>{syncState?.running?t('syncRunning'):t('syncIdle')}</strong></div><div><span>{t('lastSync')}</span><strong>{formatDate(syncState?.lastFinishedAt,t('never'),locale)}</strong></div><div><span>{t('nextSync')}</span><strong>{formatDate(syncState?.nextRunAt,t('manualOnly'),locale)}</strong></div></div>
    </SettingsSection>
  </>
}

function AiSettingsPage():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<AiSettings|null>(null)
  const [keys,setKeys]=useState<Record<string,string>>({})
  const [savedKeys,setSavedKeys]=useState<Record<string,string>>({})
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({})
  const [status,setStatus]=useState('')

  useEffect(()=>{
    let cancelled=false
    void (async()=>{
      try{
        const loaded=await window.origread.getAiSettings()
        const entries=await Promise.all(loaded.providers.map(async(provider)=>[provider.id,await window.origread.getAiApiKey(provider.id)] as const))
        if(cancelled)return
        const loadedKeys=Object.fromEntries(entries)
        setSettings(loaded);setKeys(loadedKeys);setSavedKeys(loadedKeys)
      }catch(error){if(!cancelled)setStatus(errorText(error))}
    })()
    return()=>{cancelled=true}
  },[])

  const updateGlobal=async(patch:Parameters<typeof window.origread.updateAiSettings>[0])=>{setSettings(await window.origread.updateAiSettings(patch))}
  const updateProvider=async(provider:AiProviderProfile,patch:Record<string,unknown>)=>{setSettings(await window.origread.updateAiProvider({id:provider.id,...patch}))}
  const saveKey=async(provider:AiProviderProfile)=>{
    try{
      const draft=keys[provider.id]??''
      setSettings(await window.origread.updateAiProvider({id:provider.id,apiKey:draft}))
      const saved=await window.origread.getAiApiKey(provider.id)
      setKeys((value)=>({...value,[provider.id]:saved}));setSavedKeys((value)=>({...value,[provider.id]:saved}))
      setStatus(saved?t('credentialSaved',{count:saved.length}):t('credentialRemoved'))
    }catch(error){setStatus(`${t('credentialSaveFailed')}: ${errorText(error)}`)}
  }
  if(!settings)return <LoadingSettings/>
  return <><PageIntro icon={<Bot size={22}/>} title={t('aiSettingsTitle')} description={t('aiSettingsDescription')}/>
    <SettingsSection icon={<Bot size={17}/>} title={t('aiGlobal')}>
      <SettingRow title={t('aiEnabled')} description={t('aiEnabledDescription')}><Toggle checked={settings.enabled} onChange={(v)=>void updateGlobal({enabled:v})}/></SettingRow>
      <SettingRow title={t('aiDefaultProvider')} description={t('aiDefaultProviderDescription')}><select value={settings.defaultProviderId} onChange={(e)=>void updateGlobal({defaultProviderId:e.target.value})}>{settings.providers.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></SettingRow>
      <SettingRow title={t('aiOutputLanguage')} description={t('aiOutputLanguageDescription')}><input value={settings.outputLanguage} onChange={(e)=>void updateGlobal({outputLanguage:e.target.value})}/></SettingRow>
      <SettingRow title={t('aiSummaryLength')} description={t(summaryLengthDescriptionKey(settings.summaryLength))}><select value={settings.summaryLength} onChange={(e)=>void updateGlobal({summaryLength:e.target.value as AiSettings['summaryLength']})}><option value="BRIEF">{t('summaryBrief')}</option><option value="STANDARD">{t('summaryStandard')}</option><option value="DETAILED">{t('summaryDetailed')}</option></select></SettingRow>
    </SettingsSection>
    <div className="settings-section-title standalone-settings-section-title"><Bot size={17}/><span>{t('aiProviders')}</span><button className="mini-action" onClick={async()=>{const next=await window.origread.addAiProvider();const added=next.providers.find((item)=>!settings.providers.some((old)=>old.id===item.id));setSettings(next);if(added){setKeys((value)=>({...value,[added.id]:''}));setSavedKeys((value)=>({...value,[added.id]:''}))}}}><Plus size={14}/>{t('add')}</button></div>
    <p className="settings-section-description">{t('aiProvidersDescription')}</p>
    {settings.providers.map((provider)=>{const dirty=(keys[provider.id]??'')!==(savedKeys[provider.id]??'');return <section className="provider-card" key={provider.id}>
      <div className="provider-card-head"><input className="provider-name" value={provider.name} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.id===provider.id?{...p,name:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{name:settings.providers.find((p)=>p.id===provider.id)!.name})}/><Toggle checked={provider.enabled} onChange={(v)=>void updateProvider(provider,{enabled:v})}/>{settings.providers.length>1&&<button className="icon-button danger" onClick={async()=>{const next=await window.origread.removeAiProvider(provider.id);setSettings(next);setKeys((value)=>withoutKey(value,provider.id));setSavedKeys((value)=>withoutKey(value,provider.id))}}><Trash2 size={15}/></button>}</div>
      <Field label="Endpoint"><input value={provider.endpoint} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.id===provider.id?{...p,endpoint:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{endpoint:settings.providers.find((p)=>p.id===provider.id)!.endpoint})}/></Field>
      <Field label="API Key"><SecretKeyEditor value={keys[provider.id]??''} savedValue={savedKeys[provider.id]??''} visible={visibleKeys[provider.id]===true} onChange={(value)=>setKeys((current)=>({...current,[provider.id]:value}))} onToggle={()=>setVisibleKeys((current)=>({...current,[provider.id]:!current[provider.id]}))} onSave={()=>void saveKey(provider)}/></Field>
      <Field label={t('aiModel')}><div className="inline-controls"><select value={provider.defaultModel} onChange={(e)=>void updateProvider(provider,{defaultModel:e.target.value})}><option value="">{t('selectModel')}</option>{provider.models.map((m)=><option key={m} value={m}>{m}</option>)}</select><button className="mini-action" onClick={async()=>{try{const models=await window.origread.refreshAiModels(provider.id,keys[provider.id]);setSettings(await window.origread.getAiSettings());setStatus(t('modelsLoaded',{count:models.length}))}catch(e){setStatus(errorText(e))}}}><RefreshCw size={13}/>{t('loadModels')}</button><button className="mini-action" disabled={dirty} title={dirty?t('saveCredentialFirst'):undefined} onClick={async()=>{const r=await window.origread.testAiProvider(provider.id);setStatus(r.ok?t('connectionOk'):r.error??'Error')}}>{t('testConnection')}</button></div></Field>
    </section>})}
    {status&&<StatusText text={status}/>} </>
}

function TranslationSettingsPage():React.JSX.Element{
  const {t}=useTranslation()
  const [settings,setSettings]=useState<TranslationSettings|null>(null)
  const [targetLanguageDraft,setTargetLanguageDraft]=useState('zh-CN')
  const [keys,setKeys]=useState<Record<string,string>>({})
  const [savedKeys,setSavedKeys]=useState<Record<string,string>>({})
  const [visibleKeys,setVisibleKeys]=useState<Record<string,boolean>>({})
  const [status,setStatus]=useState('')

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
      setStatus(saved?t('credentialSaved',{count:saved.length}):t('credentialRemoved'))
    }catch(error){setStatus(`${t('credentialSaveFailed')}: ${errorText(error)}`)}
  }
  return <><PageIntro icon={<Languages size={22}/>} title={t('translationSettingsTitle')} description={t('translationSettingsDescription')}/>
    <SettingsSection icon={<Languages size={17}/>} title={t('translationGlobal')}>
      <SettingRow title={t('translationTargetLanguage')} description={t('translationTargetLanguageDescription')}><input className="translation-target-language-input" value={targetLanguageDraft} onChange={(e)=>setTargetLanguageDraft(e.target.value)} onBlur={()=>void update({targetLanguage:targetLanguageDraft})} onKeyDown={(e)=>{if(e.key==='Enter')e.currentTarget.blur()}}/></SettingRow>
      <SettingRow title={t('translationDisplayMode')} description={t('translationDisplayModeDescription')}><select value={settings.displayMode} onChange={(e)=>void update({displayMode:e.target.value as TranslationSettings['displayMode']})}><option value="TRANSLATED">{t('translatedOnly')}</option><option value="BILINGUAL">{t('bilingual')}</option></select></SettingRow>
    </SettingsSection>
    <div className="settings-section-title standalone-settings-section-title"><Languages size={17}/><span>{t('translationDefaultTarget')}</span></div>
    <p className="settings-section-description">{t('translationDefaultTargetDescription')}</p>
    {desktopProviders.map((provider)=>{const selected=settings.defaultTarget.type==='traditional'&&settings.defaultTarget.provider===provider.type;const dirty=(keys[provider.type]??'')!==(savedKeys[provider.type]??'');return <section className="provider-card" key={provider.type}><div className="provider-card-head"><label className="provider-default-radio"><input type="radio" name="translation-default-provider" checked={selected} disabled={!provider.enabled} onChange={()=>void update({defaultTarget:{type:'traditional',provider:provider.type}})}/><span/></label><div className="provider-card-title"><strong>{providerName(provider.type)}</strong><span>{t(translationProviderDescriptionKey(provider.type))}</span></div><Toggle checked={provider.enabled} onChange={(v)=>void updateProvider(provider,{enabled:v})}/></div><>
      <Field label="Endpoint"><input disabled={!provider.enabled} value={provider.endpoint} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.type===provider.type?{...p,endpoint:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{endpoint:settings.providers.find((p)=>p.type===provider.type)!.endpoint})}/></Field>
      {provider.type==='MICROSOFT'&&<Field label="Region"><input disabled={!provider.enabled} value={provider.region} onChange={(e)=>setSettings({...settings,providers:settings.providers.map((p)=>p.type===provider.type?{...p,region:e.target.value}:p)})} onBlur={()=>void updateProvider(provider,{region:settings.providers.find((p)=>p.type===provider.type)!.region})}/></Field>}
      <Field label="API Key"><SecretKeyEditor disabled={!provider.enabled} value={keys[provider.type]??''} savedValue={savedKeys[provider.type]??''} visible={visibleKeys[provider.type]===true} optional={provider.type==='DLX'} onChange={(value)=>setKeys((current)=>({...current,[provider.type]:value}))} onToggle={()=>setVisibleKeys((current)=>({...current,[provider.type]:!current[provider.type]}))} onSave={()=>void saveKey(provider)}/></Field>
      <button className="mini-action" disabled={!provider.enabled||dirty} title={dirty?t('saveCredentialFirst'):undefined} onClick={async()=>{const r=await window.origread.testTranslationProvider(provider.type);setStatus(r.ok?`${t('connectionOk')}: ${r.value}`:r.error??'Error')}}>{t('testConnection')}</button>
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
      <div className="rule-add-row filter-rule-add-row"><input value={keyword} placeholder={t('filterKeywordPlaceholder')} onChange={(e)=>setKeyword(e.target.value)}/><select value={ruleType} onChange={(e)=>setRuleType(e.target.value as ArticleFilterRuleType)}><option value="KEYWORD">{t('filterTypeKeyword')}</option><option value="REGEX">{t('filterTypeRegex')}</option></select><button className="mini-action" disabled={!keyword.trim()} onClick={async()=>{try{setFilters(await window.origread.addArticleFilter(keyword,ruleType,null));setKeyword('')}catch(e){setStatus(errorText(e))}}}><Plus size={13}/>{t('addFilterRule')}</button></div>
    </SettingsSection>
    <SettingsSection icon={<Filter size={17}/>} title={t('articleFilters')}>
      <RuleFileActions kind="filter" onDone={(s)=>{setStatus(s);void reload()}}/>
      {filters.rules.length>0?<div className="rule-list">{filters.rules.map((rule)=><div className="rule-row" key={rule.id}><Toggle checked={rule.enabled} onChange={async(v)=>setFilters(await window.origread.setArticleFilterEnabled(rule.id,v))}/><div><strong>{rule.keyword}</strong><span>{rule.type==='KEYWORD'?t('filterTypeKeyword'):t('filterTypeRegex')} · {rule.feedId?rule.feedName??t('sourceFilterRule'):t('globalFilterRule')}</span></div><button className="icon-button danger" onClick={async()=>setFilters(await window.origread.deleteArticleFilter(rule.id))}><Trash2 size={14}/></button></div>)}</div>:<div className="settings-empty"><strong>{t('noFilterRules')}</strong><span>{t('noFilterRulesDescription')}</span></div>}
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
    </SettingsSection>{status&&<StatusText text={status}/>}</>
}

function RuleHeaderActions({kind,onDone,onSaved}:{kind:'json'|'website';onDone:(value:string)=>void;onSaved:()=>void}):React.JSX.Element{
  const {t,i18n}=useTranslation();const[guide,setGuide]=useState<string|null>(null);const[dialog,setDialog]=useState<'ai'|'test'|null>(null);const[url,setUrl]=useState('');const[busy,setBusy]=useState(false);const[preview,setPreview]=useState<AiGeneratedRulePreview|null>(null);const[error,setError]=useState('')
  const language:'zh'|'en'=i18n.resolvedLanguage?.startsWith('zh')?'zh':'en'
  const showGuide=async()=>{try{setGuide(await window.origread.getRuleGuide(kind,language))}catch(e){onDone(errorText(e))}}
  const exportTemplate=async()=>{const r=await window.origread.exportRuleTemplateFile(kind);if(!r.cancelled)onDone(r.ok?t('ruleTemplateExported'):r.error??'Error')}
  const runDialog=async()=>{if(!url.trim()||!dialog)return;setBusy(true);setError('');try{if(dialog==='test'){const r=await window.origread.testWebsiteRule(url);if(r.ok){onDone(t('websiteRuleTestSuccess',{count:r.articleCount}));setDialog(null);setUrl('')}else setError(t('websiteRuleTestFailed',{error:r.error??''}))}else{setPreview(await window.origread.generateAiRule(kind==='website'?'WEBSITE':'JSON',url));setDialog(null)}}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  const savePreview=async()=>{if(!preview)return;setBusy(true);setError('');try{await window.origread.saveAiGeneratedRule(preview.previewId);setPreview(null);setUrl('');onDone(t('aiRuleSaved'));onSaved()}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  return <>
    <RuleActionRow icon={<CircleHelp size={16}/>} title={kind==='website'?t('websiteRuleTutorial'):t('rulesTutorial')} description={kind==='json'?t('jsonRulesTutorialDescription'):undefined} onClick={()=>void showGuide()}/>
    <RuleActionRow icon={<Sparkles size={16}/>} title={kind==='website'?t('aiGenerateWebsiteRule'):t('aiGenerateJsonRule')} description={t('aiGenerateRuleDescription')} onClick={()=>{setDialog('ai');setUrl('');setError('')}}/>
    <RuleActionRow icon={<FileText size={16}/>} title={kind==='website'?t('exportWebsiteRuleTemplate'):t('exportJsonRuleTemplate')} onClick={()=>void exportTemplate()}/>
    <RuleFileActions kind={kind} onDone={(s)=>{onDone(s);onSaved()}}/>
    {kind==='website'&&<RuleActionRow icon={<Search size={16}/>} title={t('testWebsiteRule')} onClick={()=>{setDialog('test');setUrl('');setError('')}}/>}
    {guide!==null&&<RuleModal title={kind==='website'?t('websiteRuleTutorial'):t('rulesTutorial')} onClose={()=>setGuide(null)}><GuideMarkdown text={guide}/></RuleModal>}
    {dialog!==null&&<RuleModal title={dialog==='test'?t('testWebsiteRule'):kind==='website'?t('aiGenerateWebsiteRule'):t('aiGenerateJsonRule')} onClose={()=>!busy&&setDialog(null)}><label className="rule-dialog-field"><span>{t('targetUrl')}</span><input autoFocus value={url} placeholder={dialog==='test'||kind==='website'?'https://www.example.com/news/':'https://api.example.com/posts'} onChange={(e)=>setUrl(e.target.value)}/></label>{error&&<div className="rule-dialog-error">{error}</div>}<div className="rule-dialog-actions"><button className="mini-action secondary" disabled={busy} onClick={()=>setDialog(null)}>{t('cancel')}</button><button className="mini-action" disabled={busy||!url.trim()} onClick={()=>void runDialog()}>{busy?t('working'):dialog==='test'?t('testWebsiteRule'):t('generate')}</button></div></RuleModal>}
    {preview&&<RuleModal title={t('aiRulePreviewTitle')} onClose={()=>!busy&&setPreview(null)}><div className="ai-rule-validation"><strong>{t('aiRuleLocalValidationPassed')}</strong><span>{t('aiRulePreviewMetrics',{count:preview.articleCount,score:preview.score})}</span></div>{preview.sampleTitles.length>0&&<div className="ai-rule-samples"><strong>{t('aiRuleSampleArticles')}</strong>{preview.sampleTitles.map((title,index)=><span key={index}>{title}</span>)}</div>}<strong className="rule-json-label">{t('aiRuleJsonPreview')}</strong><pre className="rule-json-preview">{preview.ruleJson}</pre>{error&&<div className="rule-dialog-error">{error}</div>}<div className="rule-dialog-actions"><button className="mini-action secondary" disabled={busy} onClick={()=>setPreview(null)}>{t('cancel')}</button><button className="mini-action" disabled={busy} onClick={()=>void savePreview()}>{t('aiRuleSave')}</button></div></RuleModal>}
  </>
}

function RssHubSettingsPage():React.JSX.Element{
  const{t}=useTranslation();const[settings,setSettings]=useState<RssHubSettings|null>(null);const[url,setUrl]=useState('');const[testing,setTesting]=useState<string|null>(null);const[results,setResults]=useState<Record<string,string>>({});const[status,setStatus]=useState('')
  const reload=()=>void window.origread.getRssHubSettings().then(setSettings);useEffect(reload,[])
  if(!settings)return <LoadingSettings/>
  const test=async(instanceUrl:string,addOnSuccess=false)=>{if(testing)return;setTesting(instanceUrl);try{const result=await window.origread.testRssHubInstance(instanceUrl);if(result.ok){setResults((value)=>({...value,[instanceUrl]:t('rssHubTestSuccess')}));if(addOnSuccess){setSettings(await window.origread.addRssHubInstance(instanceUrl));setUrl('')}}else setResults((value)=>({...value,[instanceUrl]:`${t('rssHubTestFailed')}${result.error??''}`}))}finally{setTesting(null)}}
  return <><PageIntro icon={<RadioTower size={22}/>} title={t('rssHubSettings')} description={t('rssHubSettingsDescription')}/>
    <SettingsSection icon={<RadioTower size={17}/>} title={t('rssHubEnable')}><SettingRow title={t('rssHubEnable')} description={t('rssHubEnableDescription')}><Toggle checked={settings.enabled} onChange={async(v)=>setSettings(await window.origread.setRssHubEnabled(v))}/></SettingRow></SettingsSection>
    <SettingsSection icon={<RadioTower size={17}/>} title={t('rssHubInstanceList')}><p className="settings-card-description rsshub-list-description">{t('rssHubInstanceListDescription')}</p><div className="rsshub-instance-list">{settings.instances.map((instance)=><div className="rsshub-instance-row" key={instance.id}><div className="rsshub-instance-head"><div><strong>{instance.url}</strong>{[instance.location,instance.maintainer].filter(Boolean).length>0&&<span>{[instance.location,instance.maintainer].filter(Boolean).join(' · ')}</span>}</div><Toggle checked={instance.enabled} disabled={!settings.enabled} onChange={async(v)=>setSettings(await window.origread.setRssHubInstanceEnabled(instance.id,v))}/></div><div className="rsshub-instance-actions"><button className="mini-action secondary" disabled={!settings.enabled||testing!==null} onClick={()=>void test(instance.url)}>{testing===instance.url?t('working'):t('rssHubTestInstance')}</button>{results[instance.url]&&<span>{results[instance.url]}</span>}<button className="icon-button danger" disabled={!settings.enabled} title={t('rssHubDeleteInstance')} onClick={async()=>setSettings(await window.origread.deleteRssHubInstance(instance.id))}><Trash2 size={14}/></button></div></div>)}</div></SettingsSection>
    <SettingsSection icon={<Plus size={17}/>} title={t('rssHubAddInstance')}><div className="rsshub-add-row"><label><span>{t('rssHubInstanceUrl')}</span><input disabled={!settings.enabled} value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://rsshub.example.com"/><small>{t('rssHubInstanceDescription')}</small></label><button className="mini-action" disabled={!settings.enabled||!url.trim()||testing!==null} onClick={()=>void test(url,true)}>{testing!==null?t('working'):t('rssHubSaveAndTest')}</button></div><button className="mini-action secondary rsshub-restore" onClick={async()=>{setSettings(await window.origread.restoreDefaultRssHubSettings());setResults({});setUrl('');setStatus(t('restoreDefaultsDone'))}}><RotateCcw size={13}/>{t('restoreDefaults')}</button></SettingsSection>{status&&<StatusText text={status}/>}</>
}

function BackupSettingsPage({onRestored}:{onRestored?:()=>void}):React.JSX.Element{
  const {t}=useTranslation();const[includeSecrets,setIncludeSecrets]=useState(false);const[password,setPassword]=useState('');const[status,setStatus]=useState('');const[busy,setBusy]=useState(false)
  return <><PageIntro icon={<DatabaseBackup size={22}/>} title={t('backupRestore')} description={t('backupRestoreDescription')}/>
    <SettingsSection icon={<DatabaseBackup size={17}/>} title={t('backupScopeTitle')}>
      <div className="settings-banner"><strong>{t('backupScopeTitle')}</strong><span>{t('backupScopeDescription')}</span></div>
      <SettingRow title={t('backupIncludeSecrets')} description={t('backupIncludeSecretsDescription')}><Toggle checked={includeSecrets} onChange={(value)=>{setIncludeSecrets(value);if(!value)setPassword('')}}/></SettingRow>
      {includeSecrets&&<SettingRow title={t('backupPassword')} description={t('backupPasswordDescription')}><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)}/></SettingRow>}
      <SettingsActionRow icon={<Download size={16}/>} title={t('exportBackup')} description={t('exportBackupDescription')} disabled={busy||(includeSecrets&&password.length<6)} onClick={async()=>{setBusy(true);const r=await window.origread.exportConfigurationBackup(includeSecrets?password:'');setBusy(false);if(!r.cancelled)setStatus(r.ok?`${t('backupSaved')}: ${r.path}`:r.error??'Error')}}/>
      <SettingsActionRow icon={<Upload size={16}/>} title={t('restoreBackup')} description={t('restoreBackupDescription')} disabled={busy} onClick={async()=>{setBusy(true);const r=await window.origread.restoreConfigurationBackup(password);setBusy(false);if(!r.cancelled){setStatus(r.ok?t('restoreSuccess',{feeds:r.restoreResult?.feedsAdded??0,updated:r.restoreResult?.feedsUpdated??0}):r.error??'Error');if(r.ok)onRestored?.()}}}/>
    </SettingsSection>{status&&<StatusText text={status}/>}</>
}

function RuleRepositoryList<T extends {id:string;name:string;enabled:boolean}>({rules,describe,onToggle,onDelete}:{rules:T[];describe:(rule:T)=>string;onToggle:(id:string,value:boolean)=>void;onDelete:(id:string)=>void}){return <div className="rule-list">{rules.map((rule)=><div className="rule-row" key={rule.id}><Toggle checked={rule.enabled} onChange={(v)=>onToggle(rule.id,v)}/><div><strong>{rule.name}</strong><span>{describe(rule)}</span></div><button className="icon-button danger" onClick={()=>onDelete(rule.id)}><Trash2 size={14}/></button></div>)}</div>}
function RuleFileActions({kind,onDone}:{kind:'website'|'json'|'filter';onDone:(status:string)=>void}){const{t}=useTranslation();return <div className="rule-file-actions"><button className="mini-action" onClick={async()=>{const r=await window.origread.importRuleFile(kind);if(!r.cancelled)onDone(r.ok?t('rulesImported',{count:r.count}):r.error??'Error')}}><Upload size={13}/>{t('importRules')}</button><button className="mini-action" onClick={async()=>{const r=await window.origread.exportRuleFile(kind);if(!r.cancelled)onDone(r.ok?t('rulesExported'):r.error??'Error')}}><Download size={13}/>{t('exportRules')}</button></div>}

function providerName(type:TranslationProviderType):string{return{ML_KIT:'',MICROSOFT:'Microsoft Translator',DEEPL:'DeepL',GOOGLE_CLOUD:'Google Cloud Translation',DLX:'DeepLX / DLX'}[type]}
function translationProviderDescriptionKey(type:TranslationProviderType):string{return{ML_KIT:'',MICROSOFT:'translationProviderMicrosoftDescription',DEEPL:'translationProviderDeepLDescription',GOOGLE_CLOUD:'translationProviderGoogleCloudDescription',DLX:'translationProviderDlxDescription'}[type]}
function SettingsNavButton({active,icon,label,onClick}:{active:boolean;icon:React.ReactNode;label:string;onClick:()=>void}){return <button className={`settings-nav-button ${active?'active':''}`} onClick={onClick}>{icon}<span>{label}</span></button>}
function PageIntro({icon,title,description}:{icon:React.ReactNode;title:string;description:string}){return <div className="settings-intro"><div className="settings-intro-icon">{icon}</div><div><h1>{title}</h1><p>{description}</p></div></div>}
function SettingsSection({icon,title,children}:{icon:React.ReactNode;title:string;children:React.ReactNode}){return <section className="settings-section"><div className="settings-section-title">{icon}<span>{title}</span></div><div className="settings-card">{children}</div></section>}
function SettingRow({title,description,children}:{title:string;description:string;children:React.ReactNode}){return <div className="setting-row"><div className="setting-copy"><strong>{title}</strong><span>{description}</span></div><div className="setting-control">{children}</div></div>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="provider-field"><span>{label}</span>{children}</label>}
function SecretKeyEditor({value,savedValue,visible,onChange,onToggle,onSave,disabled=false,optional=false}:{value:string;savedValue:string;visible:boolean;onChange:(value:string)=>void;onToggle:()=>void;onSave:()=>void;disabled?:boolean;optional?:boolean}){const{t}=useTranslation();const dirty=value!==savedValue;return <div className="secret-key-editor"><div className="secret-key-input-wrap"><input className="secret-key-input" disabled={disabled} type={visible?'text':'password'} value={value} autoComplete="off" spellCheck={false} placeholder={optional?t('optional'):t('notConfigured')} onChange={(e)=>onChange(e.target.value)}/><button type="button" className="secret-key-eye" disabled={disabled||!value} title={visible?t('hideCredential'):t('showCredential')} aria-label={visible?t('hideCredential'):t('showCredential')} onClick={onToggle}>{visible?<EyeOff size={15}/>:<Eye size={15}/>}</button></div><button type="button" className="mini-action secret-key-save" disabled={disabled||!dirty} onClick={onSave}><Save size={13}/>{value?t('saveCredential'):savedValue?t('removeCredential'):t('saveCredential')}</button><small className={`secret-key-state ${dirty?'dirty':'saved'}`}>{dirty?t('credentialUnsaved'):savedValue?t('credentialStored',{count:savedValue.length}):t('credentialNotStored')}</small></div>}
function summaryLengthDescriptionKey(length:AiSettings['summaryLength']):string{return length==='BRIEF'?'summaryBriefDescription':length==='DETAILED'?'summaryDetailedDescription':'summaryStandardDescription'}
function RuleActionRow({icon,title,description,disabled=false,onClick}:{icon:React.ReactNode;title:string;description?:string;disabled?:boolean;onClick?:()=>void}){if(onClick)return <button type="button" className="settings-action-row interactive" disabled={disabled} onClick={onClick}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong>{description&&<span>{description}</span>}</div></button>;return <div className={`settings-action-row ${disabled?'disabled':''}`}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong>{description&&<span>{description}</span>}</div></div>}
function SettingsActionRow({icon,title,description,onClick,disabled=false}:{icon:React.ReactNode;title:string;description:string;onClick:()=>void;disabled?:boolean}){return <button type="button" className="settings-action-row interactive" disabled={disabled} onClick={onClick}><div className="settings-action-icon">{icon}</div><div><strong>{title}</strong><span>{description}</span></div></button>}
function RuleModal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){return <div className="rule-modal-backdrop" role="presentation" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose()}}><section className="rule-modal" role="dialog" aria-modal="true"><header><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose}><X size={17}/></button></header><div className="rule-modal-body">{children}</div></section></div>}
function GuideMarkdown({text}:{text:string}){const blocks=text.replace(/\r\n/g,'\n').split(/\n{2,}/);return <div className="rule-guide-content">{blocks.map((block,index)=>{const value=block.trim();if(!value)return null;if(value.startsWith('```'))return <pre key={index}><code>{value.replace(/^```[^\n]*\n?/,'').replace(/```$/,'').trimEnd()}</code></pre>;if(value.startsWith('### '))return <h4 key={index}>{value.slice(4)}</h4>;if(value.startsWith('## '))return <h3 key={index}>{value.slice(3)}</h3>;if(value.startsWith('# '))return <h2 key={index}>{value.slice(2)}</h2>;if(value.split('\n').every((line)=>line.startsWith('- ')))return <ul key={index}>{value.split('\n').map((line,lineIndex)=><li key={lineIndex}>{line.slice(2)}</li>)}</ul>;return <p key={index}>{value}</p>})}</div>}
function Toggle({checked,onChange,disabled=false}:{checked:boolean;onChange:(value:boolean)=>void;disabled?:boolean}){return <label className="setting-switch"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e)=>onChange(e.target.checked)}/><span/></label>}
function StatusText({text}:{text:string}){return <div className="settings-status">{text}</div>}
function LoadingSettings(){const{t}=useTranslation();return <div className="article-body-status">{t('loadingContent')}</div>}
function syncIntervalLabel(minutes:SyncIntervalMinutes,t:(key:string,options?:Record<string,unknown>)=>string):string{if(minutes===0)return t('syncManual');if(minutes<60)return t('syncEveryMinutes',{count:minutes});if(minutes===60)return t('syncEveryHour');if(minutes<1440)return t('syncEveryHours',{count:minutes/60});return t('syncEveryDay')}
function formatDate(value:number|null|undefined,fallback:string,locale:string):string{return value?new Date(value).toLocaleString(locale):fallback}
function errorText(error:unknown):string{return error instanceof Error?error.message:String(error)}
function withoutKey(source:Record<string,string>,key:string):Record<string,string>{const next={...source};delete next[key];return next}

