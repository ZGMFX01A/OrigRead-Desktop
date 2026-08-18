import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import { LibraryRepository } from '../../database/library-repository'
import { WebsiteParsePreferenceRepository } from './website-parse-preference-repository'
import { WebsiteRuleRepository } from './website-rule-repository'
import { WebsiteSourceService, type WebsiteFetchPayload } from './website-source-service'
import { WebsiteSubscriptionService } from './website-subscription-service'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('WebsiteSubscriptionService', () => {
  it('adds a website, immediately syncs it, and preserves read/star state on refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'origread-website-sub-'))
    dirs.push(dir)
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new LibraryRepository(database.connection)
      const html = fixture('url-clusters.html')
      const queue = [payload(html), payload(html.replaceAll('100', '900'))]
      const sourceService = new WebsiteSourceService(
        new WebsiteRuleRepository(join(dir, 'rules.json')),
        new WebsiteParsePreferenceRepository(join(dir, 'prefs.json')),
        async () => {
          const next = queue.shift()
          if (!next) throw new Error('No queued response')
          return next
        }
      )
      const subscription = new WebsiteSubscriptionService(repository, sourceService)
      const inspected = await sourceService.inspect('https://news.example.com/')
      const added = await subscription.add(inspected)
      expect(repository.listArticlesByFeed(added.feedId)).toHaveLength(5)

      const first = repository.listArticlesByFeed(added.feedId)[0]!
      repository.setArticleUnread(first.id, false)
      repository.setArticleStarred(first.id, true)
      const refreshed = await subscription.refresh(added.feedId)
      expect(refreshed.fetchedArticles).toBe(5)
      const preserved = repository.listArticlesByFeed(added.feedId).find((article) => article.id === first.id)!
      expect(preserved.isUnread).toBe(false)
      expect(preserved.isStarred).toBe(true)
    } finally {
      database.close()
    }
  })

  it('persists inspection articles without making a second network request during add', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'origread-website-sub-failure-'))
    dirs.push(dir)
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new LibraryRepository(database.connection)
      const html = fixture('url-clusters.html')
      let calls = 0
      const sourceService = new WebsiteSourceService(
        new WebsiteRuleRepository(join(dir, 'rules.json')),
        new WebsiteParsePreferenceRepository(join(dir, 'prefs.json')),
        async () => {
          calls += 1
          if (calls === 1) return payload(html)
          throw new Error('add must not make a second request')
        }
      )
      const subscription = new WebsiteSubscriptionService(repository, sourceService)
      const inspected = await sourceService.inspect('https://news.example.com/')
      const added = await subscription.add(inspected)

      expect(added.insertedArticles).toBe(5)
      expect(calls).toBe(1)
      expect(repository.getFeedById(added.feedId)).toMatchObject({
        url: 'https://news.example.com/',
        sourceType: 'website'
      })
      expect(repository.listFeeds()).toHaveLength(1)
      expect(repository.listArticlesByFeed(added.feedId)).toHaveLength(5)
    } finally {
      database.close()
    }
  })
})

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/website-samples', name), 'utf8')
}

function payload(html: string): WebsiteFetchPayload {
  return { status: 200, finalUrl: 'https://news.example.com/', html }
}

