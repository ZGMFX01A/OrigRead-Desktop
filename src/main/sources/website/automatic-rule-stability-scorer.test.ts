import { describe, expect, it } from 'vitest'
import { defaultWebsiteRule } from '../../../shared/website'
import {
  automaticRuleHistoryScore,
  FULL_SCAN_REUSE_INTERVAL,
  shouldRunAutomaticFullScan
} from './automatic-rule-stability-scorer'
import type { WebsiteParsePreference } from './website-parse-preference-repository'

const RULE_A = 'auto-dom:example:a'
const RULE_B = 'auto-dom:example:b'

describe('AutomaticRuleStabilityScorer parity', () => {
  it('new candidate has no history adjustment', () => {
    expect(automaticRuleHistoryScore(null, RULE_A)).toBe(0)
    expect(automaticRuleHistoryScore(preference(), RULE_A)).toBe(0)
  })

  it('repeated winner outranks merely observed candidate and clamps at 12', () => {
    const current = preference({
      automaticRuleHistory: [
        { ruleId: RULE_A, fullScanAppearances: 3, consecutiveFullScanMisses: 0, successfulSelections: 8, lastSeenAt: null },
        { ruleId: RULE_B, fullScanAppearances: 3, consecutiveFullScanMisses: 0, successfulSelections: 0, lastSeenAt: null }
      ],
      automaticLastSelectedRuleId: RULE_A,
      automaticSelectionStreak: 8
    })
    expect(automaticRuleHistoryScore(current, RULE_A)).toBe(12)
    expect(automaticRuleHistoryScore(current, RULE_A)).toBeGreaterThan(automaticRuleHistoryScore(current, RULE_B))
  })

  it('missing full scans penalize candidates', () => {
    const current = preference({
      automaticRuleHistory: [
        { ruleId: RULE_A, fullScanAppearances: 1, consecutiveFullScanMisses: 3, successfulSelections: 1, lastSeenAt: null }
      ]
    })
    expect(automaticRuleHistoryScore(current, RULE_A)).toBeLessThan(0)
  })

  it('runs a full scan after five successful cached reuses', () => {
    const before = preference({ cachedAutomaticRule: automaticRule(), automaticReuseSinceFullScan: FULL_SCAN_REUSE_INTERVAL - 1 })
    expect(shouldRunAutomaticFullScan(before)).toBe(false)
    expect(shouldRunAutomaticFullScan({ ...before, automaticReuseSinceFullScan: FULL_SCAN_REUSE_INTERVAL })).toBe(true)
  })
})

function automaticRule() {
  return defaultWebsiteRule({
    id: RULE_A,
    name: 'Smart detection',
    version: 7,
    hosts: ['example.com'],
    articleSelectors: ['.news > article'],
    titleSelector: 'a',
    automaticUrlPattern: 'example.com/news/{number}'
  })
}

function preference(patch: Partial<WebsiteParsePreference> = {}): WebsiteParsePreference {
  return {
    feedId: 'feed-1',
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
    automaticFullScanCount: 0,
    ...patch
  }
}

