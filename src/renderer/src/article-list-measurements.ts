export interface ArticleListMeasurementLayout {
  scope: string
  key: string
  width: number
  estimatedRowHeight: number
}

/** A generation belongs to geometry, independently of the list/translation scope. */
export class ArticleListMeasurements {
  private values = new Map<string, number>()
  private version = 0
  constructor(private layout: ArticleListMeasurementLayout) {}

  get generation(): number { return this.version }
  get heights(): ReadonlyMap<string, number> { return this.values }

  changeFor(next: ArticleListMeasurementLayout): 'scope' | 'layout' | null {
    if (next.scope !== this.layout.scope) return 'scope'
    if (next.key !== this.layout.key || next.estimatedRowHeight !== this.layout.estimatedRowHeight
      || (next.width > 0 && next.width !== this.layout.width)) return 'layout'
    return null
  }

  configure(next: ArticleListMeasurementLayout): 'scope' | 'layout' | null {
    const change = this.changeFor(next)
    if (!change) return null
    this.layout = { ...next, width: next.width > 0 ? next.width : this.layout.width }
    this.invalidate()
    return change
  }

  record(id: string, height: number, generation: number): boolean {
    if (generation !== this.version || !Number.isFinite(height) || height <= 0 || this.values.get(id) === height) return false
    this.values.set(id, height)
    return true
  }

  invalidate(ids?: readonly string[]): boolean {
    if (ids?.length === 0) return false
    if (ids) ids.forEach(id => this.values.delete(id))
    else this.values.clear()
    // Invalidate callbacks even when a changed row has not delivered its first measurement yet.
    this.version++
    return true
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.values.keys()) if (!ids.has(id)) this.values.delete(id)
  }
}
