import type { WebsiteParsePreference } from './website-parse-preference-repository'

export const FULL_SCAN_REUSE_INTERVAL = 5

export function shouldRunAutomaticFullScan(preference: WebsiteParsePreference | null): boolean {
  return preference?.cachedAutomaticRule != null && preference.automaticReuseSinceFullScan >= FULL_SCAN_REUSE_INTERVAL
}

export function automaticRuleHistoryScore(preference: WebsiteParsePreference | null, ruleId: string): number {
  const history = preference?.automaticRuleHistory.find((item) => item.ruleId === ruleId)
  if (!history) return 0
  const successfulSelectionBonus = Math.min(history.successfulSelections, 4)
  const fullScanAppearanceBonus = Math.min(history.fullScanAppearances, 4)
  const repeatedAppearanceBonus = history.fullScanAppearances >= 2 ? 2 : 0
  const streakBonus = preference?.automaticLastSelectedRuleId === ruleId ? Math.min(preference.automaticSelectionStreak, 4) : 0
  const missingPenalty = Math.min(history.consecutiveFullScanMisses * 3, 9)
  return Math.max(-8, Math.min(12, successfulSelectionBonus + fullScanAppearanceBonus + repeatedAppearanceBonus + streakBonus - missingPenalty))
}

