import type { OrigReadDesktopApi } from '../../shared/contracts'
import type { ArticleRecord } from '../../shared/library'
import { listTranslationExcerpt, translationTargetKey, type ListTranslationItem, type ListTranslationProgress, type TranslationSettings, type TranslationTarget } from '../../shared/translation'

type Api = Pick<OrigReadDesktopApi, 'restoreListTranslations' | 'translateList' | 'stopListTranslation' | 'setTranslationVisible'>
export interface ListTranslationState {
  items: ReadonlyMap<string, ListTranslationItem>
  settings: TranslationSettings | null
  busy: boolean
  completed: number
  total: number
  error: string | null
  target?: TranslationTarget
}
const empty = (): ListTranslationState => ({ items: new Map(), settings: null, busy: false, completed: 0, total: 0, error: null })
export function matchesListTranslation(item: ListTranslationItem, article: ArticleRecord, language?: string): boolean {
  return item.accountId === article.accountId && item.feedId === article.feedId && item.expiresAt > Date.now()
    && (!language || item.language === language) && item.title === listTranslationExcerpt(article.title, 1024)
    && item.description === listTranslationExcerpt(article.description, 512)
}
/** Plain controller: local restore is separate from explicit generation; no React effect can generate. */
export class ListTranslationController {
  private value = empty()
  private listeners = new Set<() => void>()
  private scope = ''
  private serial = 0
  private readSerial = 0
  private active: string | null = null
  constructor(private readonly api: Api) {}
  snapshot = (): ListTranslationState => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(patch: Partial<ListTranslationState>): void {
    this.value = { ...this.value, ...patch }; this.listeners.forEach(listener => listener())
  }
  reset(scope: string): void {
    if (scope === this.scope) return
    this.stop(); this.scope = scope; this.value = empty(); this.listeners.forEach(listener => listener())
  }
  stop = (): void => {
    this.serial++; this.readSerial++
    const request = this.active; this.active = null
    if (request) void this.api.stopListTranslation(request).catch(() => undefined)
    if (this.value.busy) this.publish({ busy: false, error: null })
  }
  dismissError = (): void => this.publish({ error: null })
  async restore(accountId: number, articles: ArticleRecord[]): Promise<void> {
    const read = ++this.readSerial; const scope = this.scope
    const result = await this.api.restoreListTranslations(accountId, articles.slice(0, 50).map(article => article.id)).catch(() => null)
    if (!result || read !== this.readSerial || scope !== this.scope) return
    // A settings read may update layout while generating, never restart or expand the paid task.
    this.publish({ settings: result.settings })
    if (this.active) return
    const items = new Map(this.value.items)
    articles.forEach(article => items.delete(article.id))
    result.items.forEach(item => {
      const article = articles.find(article => article.id === item.articleId)
      if (article && matchesListTranslation(item, article, result.settings.targetLanguage)) items.set(item.articleId, item)
    })
    while (items.size > 200) items.delete(items.keys().next().value!)
    this.publish({ items })
  }
  progress = (progress: ListTranslationProgress): void => {
    if (this.active !== progress.requestId) return
    const items = new Map(this.value.items)
    progress.items.forEach(item => { items.delete(item.articleId); items.set(item.articleId, item) })
    while (items.size > 200) items.delete(items.keys().next().value!)
    this.publish({ items, completed: progress.completed, total: progress.total })
  }
  async translate(accountId: number, articles: ArticleRecord[], target?: TranslationTarget): Promise<void> {
    if (this.active && !target) { this.stop(); return }
    if (!articles.length) return
    this.stop()
    const scope = this.scope; const serial = ++this.serial
    const rows = articles.slice(0, 50)
    const chosen = target ?? this.value.target ?? this.value.items.get(rows[0]!.id)?.target ?? this.value.settings?.defaultTarget
    const cached = rows.map(row => this.value.items.get(row.id))
    const ready = !target && !!chosen && cached.every((item, i) => item && matchesListTranslation(item, rows[i]!, this.value.settings?.targetLanguage)
      && translationTargetKey(item.target) === translationTargetKey(chosen))
    if (ready) {
      const show = !cached.every(item => item!.showTranslation)
      const items = new Map(this.value.items)
      cached.forEach(item => items.set(item!.articleId, { ...item!, showTranslation: show }))
      this.publish({ items, error: null })
      const results = await Promise.all(cached.filter(item => item?.cacheKey).map(item => this.api.setTranslationVisible(accountId, item!.articleId, 'LIST', item!.cacheKey!, show).catch(() => false)))
      if (serial === this.serial && results.some(saved => !saved)) this.publish({ error: 'translationCacheSaveFailed' })
      return
    }
    const requestId = crypto.randomUUID()
    this.active = requestId
    this.publish({ busy: true, completed: 0, total: rows.length, error: null, target: chosen })
    try {
      const result = await this.api.translateList({ requestId, accountId, articleIds: rows.map(row => row.id), target: chosen })
      if (serial !== this.serial || scope !== this.scope) return
      this.progress(result)
      if (result.items.some(item => item.cacheWriteFailed)) this.publish({ error: 'translationCacheSaveFailed' })
    } catch (error) {
      if (serial === this.serial && scope === this.scope) this.publish({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (serial === this.serial) { this.active = null; this.publish({ busy: false }) }
    }
  }
  expire(): void {
    const items = new Map([...this.value.items].filter(([, item]) => item.expiresAt > Date.now()))
    if (items.size !== this.value.items.size) this.publish({ items })
  }
}
