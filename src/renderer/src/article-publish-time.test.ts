import { describe, expect, it } from 'vitest'
import {
  formatArticlePublishTime,
  isValidPublishTime,
  PUBLISH_TIME_SKEW_TOLERANCE_MS,
  getJustNowText
} from './article-publish-time'

describe('article-publish-time', () => {
  describe('isValidPublishTime', () => {
    it('accepts 0 as a legal epoch', () => {
      expect(isValidPublishTime(0)).toBe(true)
    })

    it('accepts valid positive timestamps', () => {
      expect(isValidPublishTime(1_700_000_000_000)).toBe(true)
      expect(isValidPublishTime(10_000)).toBe(true)
    })

    it('rejects null, undefined, and non-number types', () => {
      expect(isValidPublishTime(null)).toBe(false)
      expect(isValidPublishTime(undefined)).toBe(false)
      expect(isValidPublishTime('1700000000000')).toBe(false)
      expect(isValidPublishTime({})).toBe(false)
      expect(isValidPublishTime([])).toBe(false)
      expect(isValidPublishTime(true)).toBe(false)
    })

    it('rejects NaN and Infinity while preserving valid dates before 1970', () => {
      expect(isValidPublishTime(Number.NaN)).toBe(false)
      expect(isValidPublishTime(Number.POSITIVE_INFINITY)).toBe(false)
      expect(isValidPublishTime(Number.NEGATIVE_INFINITY)).toBe(false)
      expect(isValidPublishTime(-1)).toBe(true)
      expect(isValidPublishTime(-86400000)).toBe(true)
    })

    it('rejects extreme out-of-range timestamps', () => {
      expect(isValidPublishTime(9e16)).toBe(false)
      expect(isValidPublishTime(-9e16)).toBe(false)
    })
  })

  describe('formatArticlePublishTime', () => {
    const fixedNow = 1_786_000_000_000 // 2026-08-05T07:06:40.000Z

    it('returns null for missing or invalid timestamps', () => {
      expect(formatArticlePublishTime(null)).toBeNull()
      expect(formatArticlePublishTime(undefined)).toBeNull()
      expect(formatArticlePublishTime(Number.NaN)).toBeNull()
      expect(formatArticlePublishTime('2026-08-05')).toBeNull()
    })

    it('formats epoch 0 safely without returning null', () => {
      const result = formatArticlePublishTime(0, 'zh', fixedNow)
      expect(result).not.toBeNull()
      expect(result?.iso).toBe('1970-01-01T00:00:00.000Z')
      expect(result?.isFuture).toBe(false)
      expect(result?.relative).toContain('年前')
      expect(result?.detail).toContain(result?.relative ?? '')
    })

    it('preserves an article date before the Unix epoch', () => {
      expect(formatArticlePublishTime(-1, 'en', fixedNow)?.iso).toBe('1969-12-31T23:59:59.999Z')
    })

    it('tolerates small future clock skew within 60 seconds as just now', () => {
      // Future within tolerance (+30s)
      const slightFuture = fixedNow + 30_000
      const zhResult = formatArticlePublishTime(slightFuture, 'zh', fixedNow)
      expect(zhResult?.isFuture).toBe(false)
      expect(zhResult?.relative).toBe('刚刚')
      expect(zhResult?.detail).toContain('(刚刚)')

      const enResult = formatArticlePublishTime(slightFuture, 'en', fixedNow)
      expect(enResult?.isFuture).toBe(false)
      expect(enResult?.relative).toBe('Just now')
      expect(enResult?.detail).toContain('(Just now)')
    })

    it('tolerates small past time within 60 seconds as just now', () => {
      const recentPast = fixedNow - 20_000
      const zhResult = formatArticlePublishTime(recentPast, 'zh', fixedNow)
      expect(zhResult?.relative).toBe('刚刚')

      const enResult = formatArticlePublishTime(recentPast, 'en', fixedNow)
      expect(enResult?.relative).toBe('Just now')
    })

    it('does NOT pretend future dates are just now when exceeding tolerance', () => {
      // Beyond tolerance: 5 minutes into the future
      const futureDate = fixedNow + PUBLISH_TIME_SKEW_TOLERANCE_MS + 240_000
      const zhResult = formatArticlePublishTime(futureDate, 'zh', fixedNow)

      expect(zhResult?.isFuture).toBe(true)
      expect(zhResult?.relative).not.toBe('刚刚')
      // Real date is shown
      expect(zhResult?.relative).toMatch(/\d+/)
      // For far future, detail displays full datetime without pseudo-relative suffix
      expect(zhResult?.detail).toBe(zhResult?.full)
      expect(zhResult?.detail).not.toContain('刚刚')
    })

    it('formats relative minutes and hours accurately in Chinese and English', () => {
      // 15 minutes ago
      const fifteenMinsAgo = fixedNow - 15 * 60_000
      const zh15m = formatArticlePublishTime(fifteenMinsAgo, 'zh', fixedNow)
      expect(zh15m?.relative).toBe('15分钟前')
      expect(zh15m?.detail).toContain('(15分钟前)')

      const en15m = formatArticlePublishTime(fifteenMinsAgo, 'en', fixedNow)
      expect(en15m?.relative).toBe('15 minutes ago')
      expect(en15m?.detail).toContain('(15 minutes ago)')

      // 4 hours ago
      const fourHoursAgo = fixedNow - 4 * 3_600_000
      const zh4h = formatArticlePublishTime(fourHoursAgo, 'zh', fixedNow)
      expect(zh4h?.relative).toBe('4小时前')

      const en4h = formatArticlePublishTime(fourHoursAgo, 'en', fixedNow)
      expect(en4h?.relative).toBe('4 hours ago')
    })

    it('formats relative days in Chinese and English', () => {
      // 3 days ago
      const threeDaysAgo = fixedNow - 3 * 86_400_000
      const zh3d = formatArticlePublishTime(threeDaysAgo, 'zh', fixedNow)
      expect(zh3d?.relative).toBe('3天前')

      const en3d = formatArticlePublishTime(threeDaysAgo, 'en', fixedNow)
      expect(en3d?.relative).toBe('3 days ago')
    })

    it('provides ISO string matching the date', () => {
      const ts = 1_700_000_000_000
      const res = formatArticlePublishTime(ts, 'en', fixedNow)
      expect(res?.iso).toBe(new Date(ts).toISOString())
    })
  })

  describe('getJustNowText', () => {
    it('returns appropriate text for supported languages', () => {
      expect(getJustNowText('zh')).toBe('刚刚')
      expect(getJustNowText('zh-CN')).toBe('刚刚')
      expect(getJustNowText('en')).toBe('Just now')
      expect(getJustNowText('en-US')).toBe('Just now')
      expect(getJustNowText('ja')).toBe('たった今')
      expect(getJustNowText('fr')).toBe('À l’instant')
      expect(getJustNowText('de')).toBe('Gerade eben')
    })
  })

})
