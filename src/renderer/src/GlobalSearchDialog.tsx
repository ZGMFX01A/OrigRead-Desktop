import { ArrowDown, ArrowUp, BookOpenText, CornerDownLeft, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleSearchResult } from '../../shared/library'

interface GlobalSearchDialogProps {
  results: ArticleSearchResult[]
  loading: boolean
  error: string | null
  onSearch: (query: string) => void
  onClose: () => void
  onSelect: (result: ArticleSearchResult) => void
}

export function GlobalSearchDialog({ results, loading, error, onSearch, onClose, onSelect }: GlobalSearchDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => onSearch(query.trim()), 180)
    return () => window.clearTimeout(timeoutId)
  }, [onSearch, query])

  const selectActive = (): void => {
    const result = results[activeIndex]
    if (result) onSelect(result)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => results.length === 0 ? 0 : Math.min(current + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      selectActive()
    }
  }

  return (
    <div className="global-search-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="global-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="global-search-header">
          <div className="global-search-heading">
            <div className="global-search-title-icon"><Search size={18} /></div>
            <div>
              <h2 id="global-search-title">{t('globalSearchTitle')}</h2>
              <p>{t('globalSearchDescription')}</p>
            </div>
          </div>
          <button type="button" className="dialog-close" aria-label={t('close')} onClick={onClose}><X size={17} /></button>
        </header>

        <div className="global-search-input-shell">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('globalSearchPlaceholder')}
            aria-label={t('globalSearchTitle')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd>Ctrl ⇧ F</kbd>
        </div>

        <div className="global-search-meta" role="status" aria-live="polite">
          {loading ? (
            <span className="global-search-loading"><LoaderCircle size={13} className="spinning" />{t('globalSearchSearching')}</span>
          ) : query.trim() ? (
            <span>{t('globalSearchResultCount', { count: results.length })}</span>
          ) : (
            <span>{t('globalSearchHint')}</span>
          )}
          <span className="global-search-keys"><ArrowUp size={12} /><ArrowDown size={12} /><CornerDownLeft size={12} /><span>{t('globalSearchKeyboardHint')}</span></span>
        </div>

        <div className="global-search-results">
          {error && (
            <div className="global-search-state error" role="alert">
              <strong>{t('globalSearchError')}</strong>
              <span>{error}</span>
            </div>
          )}
          {!error && !loading && !query.trim() && (
            <div className="global-search-state">
              <div className="global-search-state-icon"><BookOpenText size={20} /></div>
              <strong>{t('globalSearchEmptyTitle')}</strong>
              <span>{t('globalSearchEmptyDescription')}</span>
            </div>
          )}
          {!error && !loading && query.trim() && results.length === 0 && (
            <div className="global-search-state">
              <div className="global-search-state-icon"><Search size={20} /></div>
              <strong>{t('globalSearchNoResults')}</strong>
              <span>{t('globalSearchNoResultsDescription')}</span>
            </div>
          )}
          {!error && results.map((result, index) => (
            <button
              key={result.id}
              type="button"
              className={`global-search-result ${index === activeIndex ? 'selected' : ''}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(result)}
            >
              <div className="global-search-result-mark"><BookOpenText size={16} /></div>
              <div className="global-search-result-copy">
                <strong>{result.title || t('untitledArticle')}</strong>
                <div className="global-search-result-meta">
                  <span>{result.feedName}</span>
                  <span>·</span>
                  <span>{t(`globalSearchMatch${capitalize(result.matchField)}`)}</span>
                  {result.publishedAt && <><span>·</span><span>{formatSearchDate(result.publishedAt)}</span></>}
                </div>
                <p>{renderHighlightedSnippet(result.snippet, query.trim())}</p>
              </div>
              {result.isUnread && <span className="global-search-unread" aria-label={t('unread')} />}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function formatSearchDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(value)
}

function renderHighlightedSnippet(text: string, query: string): React.JSX.Element | string {
  if (!query) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  return <>{parts.map((part, index) => part.toLocaleLowerCase() === query.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part)}</>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
