import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { scoreAutomaticWebsiteRegion } from './automatic-website-region-scorer'

describe('scoreAutomaticWebsiteRegion', () => {
  it('promotes main latest content', () => {
    const $ = cheerio.load(`<main role="main"><section class="latest-news"><h2>最新资讯</h2><div id="article-list"><article>内容</article></div></section></main>`)
    const score = scoreAutomaticWebsiteRegion($, $('#article-list').get(0)!)
    expect(score.adjustment).toBeGreaterThan(0)
    expect(score.signals).toContain('main')
  })

  it('strongly demotes sidebar popular rankings', () => {
    const $ = cheerio.load(`<aside class="sidebar" role="complementary"><section data-widget="popular-ranking"><h2>热门排行</h2><ol id="rank-list"><li>内容</li></ol></section></aside>`)
    const score = scoreAutomaticWebsiteRegion($, $('#rank-list').get(0)!)
    expect(score.adjustment).toBeLessThanOrEqual(-35)
    expect(score.signals).toContain('aside')
  })

  it('does not use article title words as region signals', () => {
    const $ = cheerio.load(`<div id="plain-list" class="photo-grid domain-list"><article><h3>本周热门产品推荐与购买建议</h3></article></div>`)
    expect(scoreAutomaticWebsiteRegion($, $('#plain-list').get(0)!).adjustment).toBe(0)
  })
})

