import { ArrowLeft, ArrowRight, Bot, BookOpenText, CircleHelp, DatabaseBackup, FileJson2, Filter, Globe2, Languages, RadioTower, RefreshCw, Search, SearchX, UserRound, X } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsPage, SettingsSearchItem, SettingsSearchResult } from './settings-search'
import './settings-search.css'

interface SettingsSearchToolbarProps {
  query: string
  showBack: boolean
  onChange(query: string): void
  onFocus(): void
  onClear(): void
  onBack(): void
  onSubmit(): void
}

export function SettingsSearchToolbar({ query, showBack, onChange, onFocus, onClear, onBack, onSubmit }: SettingsSearchToolbarProps): React.JSX.Element {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  return <div className="settings-search-toolbar">
    <div className="settings-search-field">
      <Search size={17} aria-hidden="true"/>
      <input ref={input} type="search" className="settings-search-input"
        aria-label={t('settingsSearchPlaceholder')} placeholder={t('settingsSearchPlaceholder')}
        autoComplete="off" spellCheck={false} value={query}
        onFocus={onFocus} onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onSubmit()
          }
        }}/>
      {query.length > 0 && <button type="button" className="icon-button settings-search-clear"
        aria-label={t('settingsSearchClear')} title={t('settingsSearchClear')}
        onClick={() => { onClear(); input.current?.focus() }}><X size={16}/></button>}
    </div>
    {showBack && <button type="button" className="mini-action settings-search-back" onClick={() => { onBack(); input.current?.focus() }}>
      <ArrowLeft size={14}/><span>{t('settingsSearchBack')}</span>
    </button>}
  </div>
}

const pageIcons = {
  general: Globe2, accounts: UserRound, ai: Bot, translation: Languages,
  filters: Filter, jsonRules: FileJson2, websiteRules: Globe2, rsshub: RadioTower,
  backup: DatabaseBackup, about: CircleHelp, update: RefreshCw
} satisfies Record<SettingsPage, typeof BookOpenText>

export function SettingsSearchResults({ results, onSelect }: {
  results: readonly SettingsSearchResult[]
  onSelect(item: SettingsSearchItem): void
}): React.JSX.Element {
  const { t } = useTranslation()
  return <section className="settings-search-results" aria-label={t('settingsSearchPlaceholder')}>
    <p className="settings-search-count" role="status" aria-live="polite">
      {results.length ? t('settingsSearchCount', { count: results.length }) : t('settingsSearchEmpty')}
    </p>
    {results.length === 0
      ? <div className="settings-search-empty"><SearchX size={38} aria-hidden="true"/><p>{t('settingsSearchTryAnother')}</p></div>
      : <div className="settings-search-result-list" role="list">
        {results.map(result => {
          const Icon = pageIcons[result.item.page]
          return <div role="listitem" key={result.item.id}>
            <button type="button" className="settings-search-result" data-settings-search-id={result.item.id}
              onClick={() => onSelect(result.item)}>
              <Icon size={20} aria-hidden="true"/>
              <span className="settings-search-result-copy">
                <span className="settings-search-breadcrumb">{result.breadcrumb}</span>
                <strong>{result.title}</strong>
                {result.description && <span className="settings-search-description">{result.description}</span>}
              </span>
              <ArrowRight size={17} aria-hidden="true"/>
            </button>
          </div>
        })}
      </div>}
  </section>
}
