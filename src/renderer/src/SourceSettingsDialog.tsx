import { RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleFilterRule, ArticleFilterRuleType } from '../../shared/filter-rules'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { WebsiteParseCandidate } from '../../shared/website'
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
      feed.sourceType === 'website' ? window.origread.getWebsiteSourceRuleSettings(feed.id) : Promise.resolve(null)
    ]).then(([loadedGroups, snapshot, sourceRuleSettings]) => {
      if (cancelled) return
      setGroups(loadedGroups)
      setFilters(snapshot.rules)
      setWebsiteSettings(sourceRuleSettings)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [feed.id, feed.sourceType])

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

  const sourceTypeLabel = feed.sourceType === 'rss'
    ? t('sourceTypeRss')
    : feed.sourceType === 'website'
      ? t('sourceTypeWebsite')
      : t('sourceTypeJson')
  const tabs: SourceSettingsTab[] = feed.sourceType === 'rss'
    ? ['general', 'filters', 'maintenance']
    : ['general', 'reading', 'filters', 'maintenance']

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
              {websiteCandidates.length > 0 && <div className="source-parser-candidates">{websiteCandidates.map((candidate)=>(
                <button type="button" key={candidate.rule.id} className={websiteSettings.preferredRuleId===candidate.rule.id?'selected':''} onClick={()=>void setPreferredWebsiteRule(candidate.rule.id)}>
                  <strong>{candidate.rule.name}</strong><span>{candidate.diagnostics.articleCount} · {candidate.diagnostics.state} · {candidate.diagnostics.score}</span>
                </button>
              ))}</div>}
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
