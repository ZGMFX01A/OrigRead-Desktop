import { RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiSettings, AiSummaryLength, AiSummaryRequestOptions } from '../../shared/ai'
import type { TranslationSettings, TranslationTarget } from '../../shared/translation'

export function AiSummaryOptionsDialog({ onClose, onGenerate }: {
  onClose(): void
  onGenerate(options: AiSummaryRequestOptions): Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [length, setLength] = useState<AiSummaryLength>('STANDARD')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.origread.getAiSettings().then((loaded) => {
      setSettings(loaded)
      const provider = loaded.providers.find((item)=>item.id===loaded.defaultProviderId&&item.enabled) ?? loaded.providers.find((item)=>item.enabled)
      setProviderId(provider?.id ?? '')
      setModel(provider?.defaultModel || provider?.models[0] || '')
      setLength(loaded.summaryLength)
    }).catch((reason)=>setError(reason instanceof Error?reason.message:String(reason)))
  }, [])

  const provider = settings?.providers.find((item)=>item.id===providerId) ?? null

  return <div className="dialog-backdrop nested-dialog" role="presentation" onMouseDown={onClose}>
    <section className="reader-tool-dialog" role="dialog" aria-modal="true" onMouseDown={(event)=>event.stopPropagation()}>
      <header className="dialog-header"><div><h2>{t('aiSummaryOptions')}</h2><p>{t('aiSummaryOptionsDescription')}</p></div><button className="dialog-close" type="button" onClick={onClose}><X size={17}/></button></header>
      <div className="reader-tool-dialog-body">
        {error&&<div className="dialog-error">{error}</div>}
        <label className="dialog-field"><span>{t('aiProvider')}</span><select value={providerId} onChange={(event)=>{const id=event.target.value;setProviderId(id);const next=settings?.providers.find((item)=>item.id===id);setModel(next?.defaultModel||next?.models[0]||'')}}>{settings?.providers.filter((item)=>item.enabled).map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="dialog-field"><span>{t('model')}</span><select value={model} onChange={(event)=>setModel(event.target.value)}>{provider?.models.map((item)=><option key={item} value={item}>{item}</option>)}{model&&!provider?.models.includes(model)&&<option value={model}>{model}</option>}</select></label>
        <div className="dialog-field"><span>{t('summaryLength')}</span><div className="summary-mode-selector">
          {([
            ['BRIEF','summaryModeQuick','summaryBriefDescription'],
            ['STANDARD','summaryModeBalanced','summaryStandardDescription'],
            ['DETAILED','summaryModeDeep','summaryDetailedDescription']
          ] as const).map(([value,labelKey,descriptionKey])=><button type="button" key={value} className={`summary-mode-option ${length===value?'selected':''}`} onClick={()=>setLength(value)}><strong>{t(labelKey)}</strong><span>{t(descriptionKey)}</span></button>)}
        </div></div>
      </div>
      <footer className="dialog-footer"><span className="dialog-footer-spacer"/><button type="button" className="dialog-cancel" onClick={onClose}>{t('cancel')}</button><button type="button" className="dialog-submit" disabled={busy||!providerId||!model} onClick={async()=>{setBusy(true);setError(null);try{await onGenerate({providerId,model,length});onClose()}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}>{busy&&<RefreshCw size={14} className="spinning"/>}{t('generate')}</button></footer>
    </section>
  </div>
}

export function TranslationTargetDialog({ onClose, onTranslate }: {
  onClose(): void
  onTranslate(target: TranslationTarget, setDefault: boolean): Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [translation, setTranslation] = useState<TranslationSettings | null>(null)
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [setDefault, setSetDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(()=>{void Promise.all([window.origread.getTranslationSettings(),window.origread.getAiSettings()]).then(([translationSettings,aiSettings])=>{setTranslation(translationSettings);setAi(aiSettings);setSelectedKey(targetKey(translationSettings.defaultTarget))}).catch((reason)=>setError(reason instanceof Error?reason.message:String(reason)))},[])

  const targets = useMemo(()=>{
    const values:Array<{key:string;label:string;target:TranslationTarget}>=[]
    for(const provider of translation?.providers??[]){if(provider.enabled&&provider.desktopSupported)values.push({key:`traditional:${provider.type}`,label:providerLabel(provider.type),target:{type:'traditional',provider:provider.type}})}
    for(const provider of ai?.providers??[]){if(!provider.enabled)continue;for(const model of distinct([provider.defaultModel,...provider.models]).filter(Boolean)){const target:TranslationTarget={type:'ai',providerId:provider.id,providerName:provider.name,model};values.push({key:targetKey(target),label:`${provider.name} · ${model}`,target})}}
    return values
  },[translation,ai])
  const traditionalTargets=targets.filter((item)=>item.target.type==='traditional')
  const aiTargets=targets.filter((item)=>item.target.type==='ai')
  const selected=targets.find((item)=>item.key===selectedKey)??targets[0]??null

  return <div className="dialog-backdrop nested-dialog" role="presentation" onMouseDown={onClose}>
    <section className="reader-tool-dialog translation-target-dialog" role="dialog" aria-modal="true" onMouseDown={(event)=>event.stopPropagation()}>
      <header className="dialog-header"><div><h2>{t('translationTarget')}</h2><p>{t('translationTargetDescription')}</p></div><button className="dialog-close" type="button" onClick={onClose}><X size={17}/></button></header>
      <div className="reader-tool-dialog-body">
        {error&&<div className="dialog-error">{error}</div>}
        <div className="translation-target-groups">
          {traditionalTargets.length>0&&<section className="translation-target-group"><header><strong>{t('traditionalTranslation')}</strong><span>{t('traditionalTranslationDescription')}</span></header><div className="translation-target-list">{traditionalTargets.map((item)=><label key={item.key} className={`translation-target-option ${selectedKey===item.key?'selected':''}`}><input type="radio" name="translation-target" checked={selectedKey===item.key} onChange={()=>setSelectedKey(item.key)}/><span>{item.label}</span></label>)}</div></section>}
          {aiTargets.length>0&&<section className="translation-target-group"><header><strong>{t('aiTranslation')}</strong><span>{t('aiTranslationDescription')}</span></header><div className="translation-target-list">{aiTargets.map((item)=><label key={item.key} className={`translation-target-option ${selectedKey===item.key?'selected':''}`}><input type="radio" name="translation-target" checked={selectedKey===item.key} onChange={()=>setSelectedKey(item.key)}/><span>{item.label}</span></label>)}</div></section>}
        </div>
        <label className="source-setting-toggle"><input type="checkbox" checked={setDefault} onChange={(event)=>setSetDefault(event.target.checked)}/><span>{t('setAsDefaultTranslationTarget')}</span></label>
      </div>
      <footer className="dialog-footer"><span className="dialog-footer-spacer"/><button className="dialog-cancel" type="button" onClick={onClose}>{t('cancel')}</button><button className="dialog-submit" type="button" disabled={busy||!selected} onClick={async()=>{if(!selected)return;setBusy(true);setError(null);try{await onTranslate(selected.target,setDefault);onClose()}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}>{busy&&<RefreshCw size={14} className="spinning"/>}{t('translateNow')}</button></footer>
    </section>
  </div>
}

function targetKey(target:TranslationTarget):string{return target.type==='traditional'?`traditional:${target.provider}`:`ai:${target.providerId}:${target.model}`}
function providerLabel(type:string):string{return type==='MICROSOFT'?'Microsoft Translator':type==='DEEPL'?'DeepL':type==='GOOGLE_CLOUD'?'Google Cloud Translation':type==='DLX'?'DLX':type}
function distinct(values:string[]):string[]{return[...new Set(values)]}
