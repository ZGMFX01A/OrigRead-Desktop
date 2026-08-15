import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { WebsiteParseCandidate, WebsiteRule } from '../../../shared/website'
import { AUTOMATIC_WEBSITE_RULE_ID_PREFIX } from './automatic-website-list-detector'
import { FULL_SCAN_REUSE_INTERVAL } from './automatic-rule-stability-scorer'

export interface AutomaticRuleHistoryEntry {
  ruleId: string
  fullScanAppearances: number
  consecutiveFullScanMisses: number
  successfulSelections: number
  lastSeenAt: number | null
}

export interface WebsiteParsePreference {
  feedId: string
  dynamicRenderingEnabled: boolean
  preferredRuleId: string | null
  preferredRuleName: string | null
  lastSelectedRuleId: string | null
  lastScore: number | null
  lastArticleCount: number | null
  cachedAutomaticRule: WebsiteRule | null
  automaticRuleUpdatedAt: number | null
  automaticRuleHistory: AutomaticRuleHistoryEntry[]
  automaticLastSelectedRuleId: string | null
  automaticSelectionStreak: number
  automaticReuseSinceFullScan: number
  automaticFullScanCount: number
}

interface PreferenceBundle { items: WebsiteParsePreference[] }

const MAX_AUTOMATIC_HISTORY_ITEMS = 12
const MAX_HISTORY_COUNTER = 10_000
const MAX_CONSECUTIVE_MISSES = 20

export class WebsiteParsePreferenceRepository {
  constructor(private readonly preferenceFile: string) {}

  get(feedId: string): WebsiteParsePreference | null {
    return this.load().find((item) => item.feedId === feedId) ?? null
  }

  setPreferredRule(feedId: string, ruleId: string | null, ruleName: string | null = null): void {
    this.save({ ...this.getOrCreate(feedId), preferredRuleId: ruleId, preferredRuleName: ruleName })
  }

  setDynamicRenderingEnabled(feedId: string, enabled: boolean): void {
    this.save({ ...this.getOrCreate(feedId), dynamicRenderingEnabled: enabled })
  }

  delete(feedId: string): void {
    this.write(this.load().filter((item) => item.feedId !== feedId))
  }

  saveAutomaticRule(feedId: string, rule: WebsiteRule, updatedAt = Date.now()): void {
    if (!rule.id.startsWith(AUTOMATIC_WEBSITE_RULE_ID_PREFIX)) throw new Error('只能缓存自动 DOM 规则')
    this.save({ ...this.getOrCreate(feedId), cachedAutomaticRule: rule, automaticRuleUpdatedAt: updatedAt })
  }

  clearAutomaticRule(feedId: string): void {
    const current = this.get(feedId)
    if (!current) return
    this.save({ ...current, cachedAutomaticRule: null, automaticRuleUpdatedAt: null, automaticReuseSinceFullScan: 0 })
  }

  recordAutomaticSelection(
    feedId: string,
    selectedRuleId: string,
    observedRuleIds: Set<string>,
    fullScan: boolean,
    observedAt = Date.now()
  ): void {
    if (!selectedRuleId.startsWith(AUTOMATIC_WEBSITE_RULE_ID_PREFIX)) throw new Error('只能记录自动 DOM 规则历史')
    const current = this.getOrCreate(feedId)
    const automaticObserved = new Set([...observedRuleIds].filter((id) => id.startsWith(AUTOMATIC_WEBSITE_RULE_ID_PREFIX)))
    automaticObserved.add(selectedRuleId)
    const history = new Map(current.automaticRuleHistory.map((item) => [item.ruleId, { ...item }]))

    if (fullScan) {
      for (const [ruleId, item] of history) {
        history.set(ruleId, automaticObserved.has(ruleId)
          ? { ...item, fullScanAppearances: increment(item.fullScanAppearances), consecutiveFullScanMisses: 0, lastSeenAt: observedAt }
          : { ...item, consecutiveFullScanMisses: Math.min(MAX_CONSECUTIVE_MISSES, item.consecutiveFullScanMisses + 1) })
      }
      for (const ruleId of automaticObserved) {
        if (!history.has(ruleId)) history.set(ruleId, historyEntry(ruleId, 1, observedAt))
      }
    }

    const selected = history.get(selectedRuleId) ?? historyEntry(selectedRuleId)
    history.set(selectedRuleId, { ...selected, successfulSelections: increment(selected.successfulSelections), lastSeenAt: observedAt })
    const continuing = current.automaticLastSelectedRuleId === selectedRuleId
    this.save({
      ...current,
      automaticRuleHistory: [...history.values()]
        .sort((left, right) => (right.lastSeenAt ?? Number.MIN_SAFE_INTEGER) - (left.lastSeenAt ?? Number.MIN_SAFE_INTEGER) || right.successfulSelections - left.successfulSelections)
        .slice(0, MAX_AUTOMATIC_HISTORY_ITEMS),
      automaticLastSelectedRuleId: selectedRuleId,
      automaticSelectionStreak: continuing ? increment(current.automaticSelectionStreak) : 1,
      automaticReuseSinceFullScan: fullScan ? 0 : Math.min(FULL_SCAN_REUSE_INTERVAL, current.automaticReuseSinceFullScan + 1),
      automaticFullScanCount: fullScan ? increment(current.automaticFullScanCount) : current.automaticFullScanCount
    })
  }

  saveLastSelection(feedId: string, candidate: WebsiteParseCandidate): void {
    this.save({
      ...this.getOrCreate(feedId),
      lastSelectedRuleId: candidate.rule.id,
      lastScore: candidate.diagnostics.score,
      lastArticleCount: candidate.articles.length
    })
  }

  exportBackup(feedIds: Set<string>): string {
    return JSON.stringify({ items: this.load().filter((item) => feedIds.has(item.feedId)) }, null, 2)
  }

  validateBackup(content: string): void {
    this.decode(content)
  }

  restoreBackup(content: string, feedIdMap: Map<string, string>): void {
    const restored = this.decode(content).items
      .map((item) => feedIdMap.get(item.feedId) ? { ...item, feedId: feedIdMap.get(item.feedId)! } : null)
      .filter((item): item is WebsiteParsePreference => item !== null)
    const affected = new Set(restored.map((item) => item.feedId))
    this.write([...this.load().filter((item) => !affected.has(item.feedId)), ...restored])
  }

  private getOrCreate(feedId: string): WebsiteParsePreference {
    return this.get(feedId) ?? defaultPreference(feedId)
  }

  private save(item: WebsiteParsePreference): void {
    this.write([...this.load().filter((existing) => existing.feedId !== item.feedId), item])
  }

  private load(): WebsiteParsePreference[] {
    try {
      if (!existsSync(this.preferenceFile)) return []
      return this.decode(readFileSync(this.preferenceFile, 'utf8')).items
    } catch {
      return []
    }
  }

  private decode(content: string): PreferenceBundle {
    const parsed = JSON.parse(content) as { items?: unknown }
    if (!Array.isArray(parsed.items)) throw new Error('网站解析偏好文件缺少 items')
    return { items: parsed.items.map((item) => normalizePreference(item as Partial<WebsiteParsePreference>)) }
  }

  private write(items: WebsiteParsePreference[]): void {
    writeFileSync(this.preferenceFile, JSON.stringify({ items: items.sort((a, b) => a.feedId.localeCompare(b.feedId)) }, null, 2), 'utf8')
  }
}

function defaultPreference(feedId: string): WebsiteParsePreference {
  return {
    feedId,
    dynamicRenderingEnabled: false,
    preferredRuleId: null,
    preferredRuleName: null,
    lastSelectedRuleId: null,
    lastScore: null,
    lastArticleCount: null,
    cachedAutomaticRule: null,
    automaticRuleUpdatedAt: null,
    automaticRuleHistory: [],
    automaticLastSelectedRuleId: null,
    automaticSelectionStreak: 0,
    automaticReuseSinceFullScan: 0,
    automaticFullScanCount: 0
  }
}

function normalizePreference(input: Partial<WebsiteParsePreference>): WebsiteParsePreference {
  if (typeof input.feedId !== 'string' || !input.feedId) throw new Error('网站解析偏好缺少 feedId')
  return { ...defaultPreference(input.feedId), ...input, feedId: input.feedId, automaticRuleHistory: Array.isArray(input.automaticRuleHistory) ? input.automaticRuleHistory : [] }
}

function historyEntry(ruleId: string, fullScanAppearances = 0, lastSeenAt: number | null = null): AutomaticRuleHistoryEntry {
  return { ruleId, fullScanAppearances, consecutiveFullScanMisses: 0, successfulSelections: 0, lastSeenAt }
}

function increment(value: number): number { return Math.min(MAX_HISTORY_COUNTER, value + 1) }

