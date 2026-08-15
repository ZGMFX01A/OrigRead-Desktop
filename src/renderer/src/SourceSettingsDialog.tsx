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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="source-settings-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><h2>{t('sourceSettings')}</h2><p>{feed.sourceType.toUpperCase()} · {feed.name}</p></div>
          <button type="button" className="dialog-close" aria-label={t('cancel')} onClick={onClose}><X size={17}/></button>
        </header>

        <div className="source-settings-scroll">
          {error && <div className="dialog-error">{error}</div>}
          <div className="source-settings-grid">
            <label className="dialog-field"><span>{t('sourceName')}</span><input value={name} onChange={(event)=>setName(event.target.value)} /></label>
            <label className="dialog-field"><span>{t('sourceUrl')}</span><input value={url} onChange={(event)=>setUrl(event.target.value)} /></label>
            <label className="dialog-field"><span>{t('sourceGroup')}</span><select value={groupId} onChange={(event)=>setGroupId(event.target.value)}>{groups.map((group)=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <div className="source-inline-field">
              <input value={newGroupName} placeholder={t('newGroupName')} onChange={(event)=>setNewGroupName(event.target.value)} onKeyDown={(event)=>{if(event.key==='Enter')void addGroup()}} />
              <button type="button" className="mini-action" disabled={!newGroupName.trim()||busy} onClick={()=>void addGroup()}>{t('addGroup')}</button>
            </div>
          </div>

          <section className="source-settings-section">
            <h3>{t('sourcePreferences')}</h3>
            <label className="source-setting-toggle"><input type="checkbox" checked={isFullContent} onChange={(event)=>{setIsFullContent(event.target.checked);if(event.target.checked)setIsBrowser(false)}}/><span>{t('parseFullContent')}</span></label>
            <label className="source-setting-toggle"><input type="checkbox" checked={isBrowser} onChange={(event)=>{setIsBrowser(event.target.checked);if(event.target.checked)setIsFullContent(false)}}/><span>{t('openInBrowserPreset')}</span></label>
            <label className="source-setting-toggle"><input type="checkbox" checked={isNotification} onChange={(event)=>setIsNotification(event.target.checked)}/><span>{t('allowNotification')}</span></label>
          </section>

          <section className="source-settings-section">
            <h3>{t('sourceFilters')}</h3>
            <div className="source-filter-add">
              <input value={filterKeyword} placeholder={t('filterKeywordPlaceholder')} onChange={(event)=>setFilterKeyword(event.target.value)} />
              <select value={filterType} onChange={(event)=>setFilterType(event.target.value as ArticleFilterRuleType)}><option value="KEYWORD">{t('keyword')}</option><option value="REGEX">{t('regex')}</option></select>
              <button type="button" className="mini-action" disabled={!filterKeyword.trim()} onClick={()=>void addFilter()}>{t('add')}</button>
            </div>
            {sourceFilters.length === 0 ? <p className="source-settings-muted">{t('noSourceFilters')}</p> : sourceFilters.map((rule)=>(
              <div className="source-filter-row" key={rule.id}>
                <label><input type="checkbox" checked={rule.enabled} onChange={async(event)=>setFilters((await window.origread.setArticleFilterEnabled(rule.id,event.target.checked)).rules)}/><span>{rule.keyword}</span></label>
                <span>{rule.type}</span>
                <button type="button" className="icon-button danger" aria-label={t('delete')} onClick={async()=>setFilters((await window.origread.deleteArticleFilter(rule.id)).rules)}><Trash2 size={14}/></button>
              </div>
            ))}
          </section>

          {feed.sourceType === 'website' && websiteSettings && (
            <section className="source-settings-section">
              <h3>{t('websiteSourceParser')}</h3>
              <label className="source-setting-toggle"><input type="checkbox" checked={websiteSettings.dynamicRenderingEnabled} onChange={async(event)=>setWebsiteSettings(await window.origread.setWebsiteSourceDynamicRendering(feed.id,event.target.checked))}/><span>{t('dynamicRendering')}</span></label>
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

          <section className="source-settings-section source-danger-zone">
            <h3>{t('sourceMaintenance')}</h3>
            <div className="source-maintenance-actions">
              <button type="button" className="mini-action" disabled={busy} onClick={async()=>{setBusy(true);try{const next=await window.origread.reloadFeedIcon(feed.id);onChanged(next)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}>{t('reloadIcon')}</button>
              <button type="button" className="mini-action" disabled={busy} onClick={async()=>{if(!window.confirm(t('confirmClearSourceArticles')))return;setBusy(true);try{await window.origread.clearFeedArticles(feed.id);onChanged(feed)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}>{t('clearSourceArticles')}</button>
              <button type="button" className="mini-action danger" disabled={busy} onClick={async()=>{if(!window.confirm(t('confirmDeleteSource')))return;setBusy(true);try{await window.origread.deleteFeed(feed.id);onChanged(null)}catch(reason){setError(reason instanceof Error?reason.message:String(reason))}finally{setBusy(false)}}}><Trash2 size={13}/>{t('deleteSource')}</button>
            </div>
          </section>
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
