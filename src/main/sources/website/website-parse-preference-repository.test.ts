import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultWebsiteRule } from '../../../shared/website'
import { FULL_SCAN_REUSE_INTERVAL, automaticRuleHistoryScore, shouldRunAutomaticFullScan } from './automatic-rule-stability-scorer'
import { WebsiteParsePreferenceRepository } from './website-parse-preference-repository'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('WebsiteParsePreferenceRepository parity', () => {
  it('keeps legacy dynamic rendering default disabled and persists changes', () => {
    const { repository, file } = createRepository()
    writeFileSync(file, JSON.stringify({ items: [{ feedId: 'legacy-feed' }] }))
    expect(repository.get('legacy-feed')?.dynamicRenderingEnabled).toBe(false)
    repository.setDynamicRenderingEnabled('dynamic-feed', true)
    expect(repository.get('dynamic-feed')?.dynamicRenderingEnabled).toBe(true)
    repository.setDynamicRenderingEnabled('dynamic-feed', false)
    expect(repository.get('dynamic-feed')?.dynamicRenderingEnabled).toBe(false)
  })

  it('saves and clears source-level automatic rule', () => {
    const { repository } = createRepository()
    const rule = automaticRule('auto-dom:example:1')
    repository.saveAutomaticRule('feed-1', rule, 1234)
    expect(repository.get('feed-1')?.cachedAutomaticRule).toEqual(rule)
    expect(repository.get('feed-1')?.automaticRuleUpdatedAt).toBe(1234)
    repository.clearAutomaticRule('feed-1')
    expect(repository.get('feed-1')?.cachedAutomaticRule).toBeNull()
    expect(repository.get('feed-1')?.automaticRuleUpdatedAt).toBeNull()
  })

  it('records history and schedules the same periodic full scan as Android', () => {
    const { repository } = createRepository()
    const ruleA = 'auto-dom:example:a'
    const ruleB = 'auto-dom:example:b'
    const ruleC = 'auto-dom:example:c'
    repository.saveAutomaticRule('feed-1', automaticRule(ruleA), 900)
    repository.recordAutomaticSelection('feed-1', ruleA, new Set([ruleA, ruleB]), true, 1000)
    for (let index = 0; index < FULL_SCAN_REUSE_INTERVAL; index += 1) {
      repository.recordAutomaticSelection('feed-1', ruleA, new Set([ruleA]), false, 1100 + index)
    }
    const stable = repository.get('feed-1')!
    expect(stable.automaticFullScanCount).toBe(1)
    expect(stable.automaticReuseSinceFullScan).toBe(FULL_SCAN_REUSE_INTERVAL)
    expect(stable.automaticSelectionStreak).toBe(6)
    expect(stable.automaticRuleHistory.find((item) => item.ruleId === ruleA)?.successfulSelections).toBe(6)
    expect(stable.automaticRuleHistory.find((item) => item.ruleId === ruleB)?.fullScanAppearances).toBe(1)
    expect(shouldRunAutomaticFullScan(stable)).toBe(true)
    expect(automaticRuleHistoryScore(stable, ruleA)).toBeGreaterThan(automaticRuleHistoryScore(stable, ruleB))

    repository.recordAutomaticSelection('feed-1', ruleB, new Set([ruleB, ruleC]), true, 2000)
    const switched = repository.get('feed-1')!
    expect(switched.automaticFullScanCount).toBe(2)
    expect(switched.automaticReuseSinceFullScan).toBe(0)
    expect(switched.automaticLastSelectedRuleId).toBe(ruleB)
    expect(switched.automaticSelectionStreak).toBe(1)
    expect(switched.automaticRuleHistory.find((item) => item.ruleId === ruleA)?.consecutiveFullScanMisses).toBe(1)
    expect(switched.automaticRuleHistory.find((item) => item.ruleId === ruleB)?.fullScanAppearances).toBe(2)
  })
})

function createRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'origread-website-pref-'))
  dirs.push(dir)
  const file = join(dir, 'website-parse-preferences.json')
  return { file, repository: new WebsiteParsePreferenceRepository(file) }
}

function automaticRule(id: string) {
  return defaultWebsiteRule({
    id,
    name: 'Smart detection',
    version: 7,
    hosts: ['example.com'],
    articleSelectors: ['section.news > article.item'],
    titleSelector: 'h2 > a.title',
    automaticUrlPattern: 'example.com/news/{number}',
    automaticDateExtraction: true
  })
}

