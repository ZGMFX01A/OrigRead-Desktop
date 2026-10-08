import { ChevronDown, Languages, Square, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleRecord } from '../../shared/library'
import type { TranslationTarget } from '../../shared/translation'
import { ListTranslationController, matchesListTranslation } from './list-translation-controller'
import { TranslationTargetDialog } from './ReaderToolDialogs'
import './list-translation.css'

export function useListTranslation(scope: string, articles: ArticleRecord[], listRef: RefObject<HTMLDivElement | null>) {
  const controller = useMemo(() => new ListTranslationController(window.origread), [])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const accountId = articles[0]?.accountId
  const currentScope = useRef<string | null>(scope)
  currentScope.current = scope
  const [menuOpen, setMenuOpen] = useState(false)
  const getRows = useCallback((): ArticleRecord[] => {
    const element = listRef.current
    const top = element?.getBoundingClientRect().top ?? 0
    const first = element ? Array.from(element.querySelectorAll<HTMLElement>('[data-article-id]')).find(row => row.getBoundingClientRect().bottom > top) : null
    const index = first ? articles.findIndex(article => article.id === first.dataset.articleId) : 0
    return articles.slice(Math.max(0, index), Math.max(0, index) + 50)
  }, [articles, listRef])
  const rowsRef = useRef(getRows)
  rowsRef.current = getRows
  useEffect(() => {
    currentScope.current = scope
    controller.reset(scope); setMenuOpen(false)
    return () => { currentScope.current = null; controller.stop() }
  }, [controller, scope])
  useEffect(() => window.origread.onListTranslationProgress(controller.progress), [controller])
  useEffect(() => {
    if (accountId === undefined) return
    const restore = (): void => { void controller.restore(accountId, rowsRef.current()) }
    const unsubscribe = window.origread.onTranslationChanged(restore)
    const visibility = (): void => { if (document.hidden) controller.stop(); else restore() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', restore)
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', restore) }
  }, [controller, accountId])
  useEffect(() => {
    if (accountId === undefined) return
    const element = listRef.current
    let timer: ReturnType<typeof setTimeout> | null = null
    const restore = (): void => { void controller.restore(accountId, getRows()) }
    const scrolled = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(restore, 120)
    }
    restore()
    element?.addEventListener('scroll', scrolled, { passive: true })
    return () => { if (timer) clearTimeout(timer); element?.removeEventListener('scroll', scrolled) }
  }, [controller, scope, accountId, getRows, listRef])
  useEffect(() => {
    const expiresAt = Math.min(...[...state.items.values()].map(item => item.expiresAt))
    if (!Number.isFinite(expiresAt)) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) controller.expire()
      else timer = setTimeout(schedule, Math.min(2_147_483_647, remaining))
    }
    schedule()
    return () => clearTimeout(timer)
  }, [controller, state.items])
  const translate = (target?: TranslationTarget): void => {
    // A dialog can finish saving its default after navigation. Do not translate the old list.
    if (currentScope.current === scope && accountId !== undefined) void controller.translate(accountId, rowsRef.current(), target)
  }
  return { controller, state, menuOpen, setMenuOpen, translate, accountId,
    item: (article: ArticleRecord) => {
      const item = state.items.get(article.id)
      return item?.showTranslation && matchesListTranslation(item, article, state.settings?.targetLanguage) ? item : null
    }
  }
}
export type ListTranslationBinding = ReturnType<typeof useListTranslation>

/** List action belongs beside the count/refresh row, not in the body toolbar. */
export function ListTranslationButton({ translation, onOpenSettings }: { translation: ListTranslationBinding; onOpenSettings(): void }) {
  const { t } = useTranslation()
  const { state, accountId, controller, menuOpen, setMenuOpen, translate } = translation
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => { setMenuOpen(false); trigger.current?.focus() }
  const open = (): void => { controller.stop(); setMenuOpen(true) }
  useEffect(() => {
    if (!menuOpen) return
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); trigger.current?.focus() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [menuOpen, setMenuOpen])
  return <>
    <div className={`list-translation-split ${[...state.items.values()].some(item => item.showTranslation) ? 'active' : ''}`}>
      <button type="button" className="list-translation-main" disabled={accountId === undefined && !state.busy}
        aria-label={t(state.busy ? 'stopTranslation' : 'translateList')} title={t(state.busy ? 'stopTranslation' : 'translateList')}
        onClick={() => state.busy ? controller.stop() : translate()}>
        {state.busy ? <Square size={14} fill="currentColor" /> : <Languages size={15} />}
      </button>
      <button ref={trigger} type="button" className="list-translation-options" disabled={accountId === undefined}
        aria-haspopup="dialog" aria-expanded={menuOpen} aria-label={t('translationTarget')} title={t('translationTarget')}
        onClick={open} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); open() } }}><ChevronDown size={12} /></button>
    </div>
    {menuOpen && createPortal(<TranslationTargetDialog onClose={close} onOpenSettings={() => { close(); onOpenSettings() }}
      onTranslate={async (target, setDefault) => {
        if (setDefault) await window.origread.updateTranslationSettings({ defaultTarget: target })
        close(); translate(target)
      }} />, document.body)}
  </>
}
export function ListTranslationStatus({ translation }: { translation: ListTranslationBinding }) {
  const { t } = useTranslation()
  const { state, controller } = translation
  if (!state.busy && !state.error) return null
  return <div className={`list-translation-status ${state.error ? 'error' : ''}`} role={state.error ? 'alert' : 'status'}>
    <span>{state.error ? t(state.error, { defaultValue: state.error }) : t('listTranslationProgress', { completed: state.completed, total: state.total })}</span>
    {state.error && <button type="button" className="icon-button" aria-label={t('close')} onClick={controller.dismissError}><X size={13} /></button>}
  </div>
}
