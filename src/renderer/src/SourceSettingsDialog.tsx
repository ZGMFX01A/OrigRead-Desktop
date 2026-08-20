import { RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleFilterRule, ArticleFilterRuleType } from '../../shared/filter-rules'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { WebsiteParseCandidate, WebsiteRule } from '../../shared/website'
import type { JsonRule } from '../../shared/json-source'
import type { WebsiteSourceRuleSettings } from '../../shared/contracts'

interface Props {
  feed: FeedRecord
  onClose(): void
  onChanged(feed: FeedRecord | null): void
}

type SourceSettingsTab = 'general' | 'reading' | 'filters' | 'maintenance'

export function SourceSettingsDialog({ feed, onClose, onChanged }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [name, setName] = useState(feed.name)
  const [url, setUrl] = useState(feed.url)
  const [groupId, setGroupId] = useState(feed.groupId)
  const [isNotification, setIsNotification] = useState(feed.isNotification)
  const [isFullContent, setIsFullContent] = useState(feed.isFullContent)
  const [isBrowser, setIsBrowser] = useState(feed.isBrowser)
  const [newGroupName, setNewGroupName] = useState('')
  const [filters, setFilters] = useState<ArticleFilterRule[]>([])
  const [filterKeyword, setFilterKeyword] = useState('')
  const [filterType, setFilterType] = useState<ArticleFilterRuleType>('KEYWORD')
  const [websiteSettings, setWebsiteSettings] = useState<WebsiteSourceRuleSettings | null>(null)
  const [websiteCandidates, setWebsiteCandidates] = useState<WebsiteParseCandidate[]>([])
  const [websiteRules, setWebsiteRules] = useState<WebsiteRule[]>([])
  const [jsonRules, setJsonRules] = useState<JsonRule[]>([])
  const [busy, setBusy] = useState(false)
  const [candidateBusy, setCandidateBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SourceSettingsTab>('general')
  const [newGroupOpen, setNewGroupOpen] = useState(false)

  const sourceFilters = useMemo(() => filters.filter((rule) => rule.feedId === feed.id), [feed.id, filters])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.origread.listGroups(),
      window.origread.getArticleFilters(),
      feed.sourceType === 'website' ? window.origread.getWebsiteSourceRuleSettings(feed.id) : Promise.resolve(null),
      feed.sourceType === 'website' ? window.origread.listWebsiteRulesForUrl(feed.url) : Promise.resolve([]),
      feed.sourceType === 'json' ? window.origread.listJsonRulesForUrl(feed.url) : Promise.resolve([])
    ]).then(([loadedGroups, snapshot, sourceRuleSettings, configuredWebsiteRules, configuredJsonRules]) => {
      if (cancelled) return
      setGroups(loadedGroups)
      setFilters(snapshot.rules)
      setWebsiteSettings(sourceRuleSettings)
      setWebsiteRules(configuredWebsiteRules)
      setJsonRules(configuredJsonRules)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [feed.id, feed.sourceType, feed.url])

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const updated = await window.origread.updateFeedSettings(feed.id, {
        name: name.trim(),
        url: url.trim(),
        groupId,
        isNotification,
        isFullContent,
        isBrowser
      })
      onChanged(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const addGroup = async (): Promise<void> => {
    if (!newGroupName.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.origread.addGroup(newGroupName.trim())
      setGroups(next)
      const created = next.find((item) => item.name === newGroupName.trim())
      if (created) setGroupId(created.id)
      setNewGroupName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const addFilter = async (): Promise<void> => {
    if (!filterKeyword.trim()) return
    setError(null)
    try {
      const snapshot = await window.origread.addArticleFilter(filterKeyword.trim(), filterType, feed.id)
      setFilters(snapshot.rules)
      setFilterKeyword('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const evaluateWebsite = async (): Promise<void> => {
    if (candidateBusy) return
    setCandidateBusy(true)
    setError(null)
    try {
      setWebsiteCandidates(await window.origread.evaluateWebsiteSourceRules(feed.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCandidateBusy(false)
    }
  }

  const setPreferredWebsiteRule = async (ruleId: string | null): Promise<void> => {
    setCandidateBusy(true)
    setError(null)
    try {
      setWebsiteSettings(await window.origread.setWebsiteSourcePreferredRule(feed.id, ruleId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCandidateBusy(false)
    }
  }

  const setWebsiteRuleEnabled = async (ruleId: string, enabled: boolean): Promise<void> => {
    setCandidateBusy(true)
    setError(null)
    try {
      await window.origread.setWebsiteRuleEnabled(ruleId, enabled)
      setWebsiteRules(await window.origread.listWebsiteRulesForUrl(feed.url))
      if (!enabled && websiteSettings?.preferredRuleId === ruleId) {
        setWebsiteSettings(await window.origread.setWebsiteSourcePreferredRule(feed.id, null))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCandidateBusy(false)
    }
  }

  const setJsonRuleEnabled = async (ruleId: string, enabled: boolean): Promise<void> => {
    setCandidateBusy(true)
    setError(null)
    try {
      await window.origread.setJsonRuleEnabled(ruleId, enabled)
      setJsonRules(await window.origread.listJsonRulesForUrl(feed.url))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCandidateBusy(false)
    }
  }

  const sourceTypeLabel = feed.sourceType === 'rss'
    ? t('sourceTypeRss')
    : feed.sourceType === 'website'
      ? t('sourceTypeWebsite')
      : t('sourceTypeJson')
  const tabs: SourceSettingsTab[] = feed.sourceType === 'rss'
    ? ['general', 'filters', 'maintenance']
    : ['general', 'reading', 'filters', 'maintenance']
  const websiteCandidateById = new Map(websiteCandidates.map((candidate) => [candidate.rule.id, candidate]))
  const configuredWebsiteRuleIds = new Set(websiteRules.map((rule) => rule.id))
  const builtInCandidates = websiteCandidates.filter((candidate) => !configuredWebsiteRuleIds.has(candidate.rule.id))
  const candidateStateLabel = (candidate: WebsiteParseCandidate): string => candidate.diagnostics.state === 'AVAILABLE' ? t('websiteParserAvailable') : t('websiteParserUnavailable')
  const candidateDisplayName = (candidate: WebsiteParseCandidate): string => candidate.rule.id.startsWith('auto-dom:')
    ? `${t('websiteParserSmartDetection')}${candidate.rule.name.includes(' · ') ? ` · ${candidate.rule.name.split(' · ').slice(1).join(' · ')}` : ''}`
    : candidate.rule.name

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="source-settings-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div>
            <div className="source-settings-title-line"><h2>{t('sourceSettings')}</h2><span className="source-type-badge">{sourceTypeLabel}</span></div>
            <p>{feed.name}</p>
          </div>
          <button type="button" className="dialog-close" aria-label={t('cancel')} onClick={onClose}><X size={17}/></button>
        </header>

        <nav className="source-settings-tabs" aria-label={t('sourceSettings')}>
          {tabs.map((tab) => (
            <button key={tab} type="button" className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>
              {t(`sourceSettingsTab_${tab}`)}
            </button>
          ))}
        </nav>

        <div className="source-settings-scroll">
          {error && <div className="dialog-error">{error}</div>}
          {activeTab === 'general' && <div className="source-settings-panel">
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('sourceBasicInfo')}</h3><p>{t('sourceBasicInfoDesc')}</p></div></div>
              <div className="source-settings-grid">
                <label className="dialog-field"><span>{t('sourceName')}</span><input value={name} onChange={(event)=>setName(event.target.value)} /></label>
                <label className="dialog-field"><span>{t('sourceGroup')}</span><select value={groupId} onChange={(event)=>setGroupId(event.target.value)}>{groups.map((group)=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
                <label className="dialog-field source-url-field"><span>{t('sourceUrl')}</span><input value={url} onChange={(event)=>setUrl(event.target.value)} /></label>
              </div>
              <div className="source-group-create">
                {!newGroupOpen ? <button type="button" className="mini-action" onClick={()=>setNewGroupOpen(true)}>{t('addGroup')}</button> : <>
                  <input autoFocus value={newGroupName} placeholder={t('newGroupName')} onChange={(event)=>setNewGroupName(event.target.value)} onKeyDown={(event)=>{if(event.key==='Enter')void addGroup()}} />
                  <button type="button" className="mini-action" disabled={!newGroupName.trim()||busy} onClick={async()=>{await addGroup();setNewGroupOpen(false)}}>{t('add')}</button>
                  <button type="button" className="mini-action subtle" onClick={()=>{setNewGroupName('');setNewGroupOpen(false)}}>{t('cancel')}</button>
                </>}
              </div>
            </section>
          </div>}

          {activeTab === 'general' && <div className="source-settings-panel">
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('sourceNotifications')}</h3><p>{t('sourceNotificationsDesc')}</p></div></div>
              <label className="source-setting-row"><span><strong>{t('allowNotification')}</strong><small>{t('allowNotificationDesc')}</small></span><input type="checkbox" checked={isNotification} onChange={(event)=>setIsNotification(event.target.checked)}/></label>
            </section>
          </div>}

          {activeTab === 'reading' && <div className="source-settings-panel">
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('sourceReading')}</h3><p>{t('sourceReadingDesc')}</p></div></div>
              <div className="source-reading-choices">
                <button type="button" className={`source-reading-choice ${!isBrowser?'selected':''}`} onClick={()=>setIsBrowser(false)}>
                  <span><strong>{t('readInsideOrigRead')}</strong><small>{t('readInsideOrigReadDesc')}</small></span>
                  <span className="source-reading-choice-state">{!isBrowser?t('currentChoice'):''}</span>
                </button>
                <button type="button" className={`source-reading-choice ${isBrowser?'selected':''}`} onClick={()=>{setIsBrowser(true);setIsFullContent(false)}}>
                  <span><strong>{t('openOriginalInBrowser')}</strong><small>{t('openOriginalInBrowserDesc')}</small></span>
                  <span className="source-reading-choice-state">{isBrowser?t('currentChoice'):''}</span>
                </button>
              </div>
              {feed.sourceType === 'website' && !isBrowser && (
                <label className="source-setting-row source-reading-secondary"><span><strong>{t('fetchOriginalFullContent')}</strong><small>{t('websiteFullContentDesc')}</small></span><input type="checkbox" checked={isFullContent} onChange={(event)=>setIsFullContent(event.target.checked)}/></label>
              )}
            </section>
          </div>}

          {activeTab === 'filters' && <div className="source-settings-panel">
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('sourceFilters')}</h3><p>{t('sourceFiltersDesc')}</p></div></div>
              <div className="source-filter-editor">
                <input value={filterKeyword} placeholder={t('filterKeywordPlaceholder')} onChange={(event)=>setFilterKeyword(event.target.value)} />
                <div>
                  <select value={filterType} onChange={(event)=>setFilterType(event.target.value as ArticleFilterRuleType)}><option value="KEYWORD">{t('keyword')}</option><option value="REGEX">{t('regex')}</option></select>
                  <button type="button" className="mini-action" disabled={!filterKeyword.trim()} onClick={()=>void addFilter()}>{t('add')}</button>
                </div>
              </div>
              {sourceFilters.length === 0 ? <p className="source-settings-muted">{t('noSourceFilters')}</p> : <div className="source-filter-list">{sourceFilters.map((rule)=>(
                <div className="source-filter-row" key={rule.id}>
                  <label><input type="checkbox" checked={rule.enabled} onChange={async(event)=>setFilters((await window.origread.setArticleFilterEnabled(rule.id,event.target.checked)).rules)}/><span>{rule.keyword}</span></label>
                  <span>{rule.type === 'REGEX' ? t('regex') : t('keyword')}</span>
                  <button type="button" className="icon-button danger" aria-label={t('delete')} onClick={async()=>setFilters((await window.origread.deleteArticleFilter(rule.id)).rules)}><Trash2 size={14}/></button>
                </div>
              ))}</div>}
            </section>
          </div>}

          {activeTab === 'reading' && feed.sourceType === 'website' && websiteSettings && (
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('websiteSourceParser')}</h3><p>{t('websiteSourceParserDesc')}</p></div></div>
              <label className="source-setting-row"><span><strong>{t('dynamicRendering')}</strong><small>{t('dynamicRenderingDesc')}</small></span><input type="checkbox" checked={websiteSettings.dynamicRenderingEnabled} onChange={async(event)=>setWebsiteSettings(await window.origread.setWebsiteSourceDynamicRendering(feed.id,event.target.checked))}/></label>
              <div className="source-parser-actions">
                <button type="button" className="mini-action" disabled={candidateBusy} onClick={()=>void evaluateWebsite()}>{candidateBusy?<RefreshCw size={13} className="spinning"/>:null}{t('evaluateParserCandidates')}</button>
                <button type="button" className="mini-action" disabled={candidateBusy||websiteSettings.preferredRuleId===null} onClick={()=>void setPreferredWebsiteRule(null)}>{t('restoreAutomaticParser')}</button>
              </div>
              <div className="source-parser-groups">
                <div className="source-parser-group">
                  <div className="source-parser-group-heading"><div><h4>{t('websiteParserAutomatic')}</h4><p>{t('websiteParserAutomaticDesc')}</p></div></div>
                  <button type="button" className={`source-parser-option ${websiteSettings.preferredRuleId===null?'selected':''}`} onClick={()=>void setPreferredWebsiteRule(null)}>
                    <span><strong>{t('websiteParserAutomatic')}</strong><small>{t('websiteParserAutomaticDesc')}</small></span>
                    <span className="source-parser-option-state">{websiteSettings.preferredRuleId===null?t('currentChoice'):''}</span>
                  </button>
                </div>

                <div className="source-parser-group">
                  <div className="source-parser-group-heading"><div><h4>{t('websiteParserRules')} ({websiteRules.length})</h4><p>{t('websiteParserRulesDesc')}</p></div></div>
                  {websiteRules.length === 0 ? <p className="source-settings-muted">{t('noMatchingWebsiteRules')}</p> : <div className="source-parser-rule-list">{websiteRules.map((rule) => {
                    const candidate = websiteCandidateById.get(rule.id)
                    const selected = websiteSettings.preferredRuleId === rule.id
                    return <div className={`source-parser-rule ${selected?'selected':''}`} key={rule.id}>
                      <label className="source-parser-rule-toggle">
                        <input type="checkbox" checked={rule.enabled} disabled={candidateBusy} onChange={(event)=>void setWebsiteRuleEnabled(rule.id,event.target.checked)} />
                        <span><strong>{rule.name}</strong><small>{candidate ? t('websiteRuleCandidateStats', { count: candidate.diagnostics.articleCount, score: candidate.diagnostics.score, state: candidateStateLabel(candidate) }) : `${rule.hosts.join(', ')} · ${rule.enabled ? t('websiteRuleEnabled') : t('websiteRuleDisabled')}`}</small></span>
                      </label>
                      <button type="button" className="mini-action source-parser-use" disabled={candidateBusy||!rule.enabled} onClick={()=>void setPreferredWebsiteRule(rule.id)}>{selected?t('currentChoice'):t('useParser')}</button>
                    </div>
                  })}</div>}
                </div>

                <div className="source-parser-group">
                  <div className="source-parser-group-heading"><div><h4>{t('websiteParserBuiltIn')} ({builtInCandidates.length})</h4><p>{t('websiteParserBuiltInDesc')}</p></div></div>
                  {websiteCandidates.length === 0 ? <p className="source-settings-muted">{t('noBuiltInWebsiteCandidates')}</p> : builtInCandidates.length === 0 ? <p className="source-settings-muted">{t('noAvailableBuiltInWebsiteCandidates')}</p> : <div className="source-parser-candidates">{builtInCandidates.map((candidate) => {
                    const available = candidate.diagnostics.state === 'AVAILABLE'
                    return <button type="button" key={candidate.rule.id} disabled={!available||candidateBusy} className={`source-parser-option ${websiteSettings.preferredRuleId===candidate.rule.id?'selected':''} ${!available?'unavailable':''}`} onClick={()=>void setPreferredWebsiteRule(candidate.rule.id)}>
                      <span><strong>{candidateDisplayName(candidate)}</strong><small>{t('websiteRuleCandidateStats', { count: candidate.diagnostics.articleCount, score: candidate.diagnostics.score, state: candidateStateLabel(candidate) })}</small></span>
                      <span className="source-parser-option-state">{websiteSettings.preferredRuleId===candidate.rule.id?t('currentChoice'):''}</span>
                    </button>
                  })}</div>}
                </div>
              </div>
            </section>
          )}

          {activeTab === 'reading' && feed.sourceType === 'json' && (
            <section className="source-settings-card">
              <div className="source-section-heading"><div><h3>{t('jsonSourceParser')}</h3><p>{t('jsonSourceParserDesc')}</p></div></div>
              {jsonRules.length === 0 ? <p className="source-settings-muted">{t('noMatchingJsonRules')}</p> : <div className="source-parser-candidates">
                {jsonRules.map((rule) => (
                  <label className={`source-parser-candidate ${rule.enabled ? 'selected' : ''}`} key={rule.id}>
                    <input type="checkbox" checked={rule.enabled} disabled={candidateBusy} onChange={(event)=>void setJsonRuleEnabled(rule.id,event.target.checked)} />
                    <span><strong>{rule.name}</strong><small>{rule.sourceKind} · {rule.enabled ? t('jsonRuleEnabled') : t('jsonRuleDisabled')}</small></span>
                  </label>
                ))}
              </div>}
            </section>
          )}

          {activeTab === 'maintenance' && <div className="source-settings-panel">
          <section className="source-settings-card">
            <div className="source-section-heading"><div><h3>{t('sourceMaintenance')}</h3><p>{t('sourceMaintenanceDesc')}</p></div></div>
            <div className="source-maintenance-list">
              <button type="button" disabled={busy} onClick={async()=>{setBusy(true);try{const next=await window.origread.reloadFeedIcon(feed.id);onChanged(next)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}><span><strong>{t('reloadIcon')}</strong><small>{t('reloadIconDesc')}</small></span><span>›</span></button>
              <button type="button" disabled={busy} onClick={async()=>{if(!window.confirm(t('confirmClearSourceArticles')))return;setBusy(true);try{await window.origread.clearFeedArticles(feed.id);onChanged(feed)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}><span><strong>{t('clearSourceArticles')}</strong><small>{t('clearSourceArticlesDesc')}</small></span><span>›</span></button>
              <button type="button" className="mini-action danger" disabled={busy} onClick={async()=>{if(!window.confirm(t('confirmDeleteSource')))return;setBusy(true);try{await window.origread.deleteFeed(feed.id);onChanged(null)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}><Trash2 size={13}/>{t('deleteSource')}</button>
            </div>
          </section>
          </div>}
        </div>

        <footer className="dialog-footer">
          <span className="dialog-footer-spacer"/>
          <button type="button" className="dialog-cancel" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="dialog-submit" disabled={busy||!name.trim()||!url.trim()} onClick={()=>void save()}>{busy?<RefreshCw size={14} className="spinning"/>:null}{t('save')}</button>
        </footer>
      </section>
    </div>
  )
}
