import { Check, Compass, Search, Rss } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedCatalogEntry, FeedCatalogSnapshot } from '../../shared/source-catalog'
import { localizedSourceCategory, secondarySourceCategory, sourceCategorySearchTerms } from '../../shared/source-catalog'

interface SourceDiscoveryPanelProps {
  onSubscribe(feed: FeedCatalogEntry): void
}

export function SourceDiscoveryPanel({ onSubscribe }: SourceDiscoveryPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [catalog, setCatalog] = useState<FeedCatalogSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('')
  const [error, setError] = useState('')
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US'

  useEffect(() => {
    void window.origread.getSourceCatalog().then(setCatalog).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const feeds = useMemo(() => {
    if (!catalog) return []
    const normalized = query.trim().toLocaleLowerCase()
    return catalog.feeds.filter((feed) => {
      if (category && !feed.categories.includes(category)) return false
      if (!normalized) return true
      const categoryTerms = feed.categories.flatMap(sourceCategorySearchTerms)
      return [feed.name, feed.feedUrl, ...categoryTerms].some((value) => value.toLocaleLowerCase().includes(normalized))
    })
  }, [catalog, category, query])

  if (error) return <div className="source-discovery-state error">{error}</div>
  if (!catalog) return <div className="source-discovery-state">{t('loadingContent')}</div>

  return <div className="source-discovery-page">
    <div className="source-discovery-heading">
      <div className="source-discovery-heading-icon"><Compass size={23}/></div>
      <div><h1>{t('sourceDiscoveryTitle')}</h1></div>
    </div>
    <div className="source-discovery-controls">
      <label className="source-discovery-search"><Search size={17}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder={t('sourceDiscoverySearchHint')}/></label>
      <label className="source-discovery-category">
        <span>{t('sourceDiscoveryChooseCategory')}</span>
        <select value={category} onChange={(event)=>setCategory(event.target.value)}>
          <option value="">{t('sourceDiscoveryAllCategories')} · {catalog.feedCount}</option>
          {catalog.categories.map((item)=><option value={item} key={item}>{localizedSourceCategory(item, locale)} · {catalog.categoryCounts[item] ?? 0}</option>)}
        </select>
      </label>
      <span className="source-discovery-count">{t('sourceCount',{count:feeds.length})}</span>
    </div>
    <div className="source-discovery-results">
      {feeds.length ? feeds.map((feed)=><SourceCatalogItem key={feed.id} feed={feed} locale={locale} onSubscribe={()=>onSubscribe(feed)}/>) : <div className="source-discovery-empty"><strong>{t('sourceDiscoveryNoResults')}</strong><span>{t('sourceDiscoveryNoResultsHint')}</span></div>}
    </div>
  </div>
}

function SourceCatalogItem({feed,locale,onSubscribe}:{feed:FeedCatalogEntry;locale:string;onSubscribe:()=>void}):React.JSX.Element{
  const {t}=useTranslation()
  const labels=feed.categories.map((category)=>localizedSourceCategory(category,locale))
  const categories=labels.length<=2?labels.join(' · '):`${labels.slice(0,2).join(' · ')} +${labels.length-2}`
  const secondary=feed.categories.slice(0,2).map((category)=>secondarySourceCategory(category,locale)).filter(Boolean).join(' · ')
  return <div className="source-discovery-item">
    <div className="source-discovery-feed-icon"><Rss size={18}/></div>
    <div className="source-discovery-feed-copy"><strong>{feed.name}</strong><span>{displayHost(feed.siteUrl??feed.feedUrl)}</span>{categories&&<small>{categories}{secondary?` · ${secondary}`:''}</small>}</div>
    <button type="button" className="source-discovery-subscribe" onClick={onSubscribe}><Check size={14}/>{t('subscribe')}</button>
  </div>
}

function displayHost(value:string):string{
  try{return new URL(value).hostname.replace(/^www\./,'')||value}catch{return value}
}
