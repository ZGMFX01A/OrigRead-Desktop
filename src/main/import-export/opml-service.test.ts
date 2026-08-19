import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { OpmlService } from './opml-service'

describe('OpmlService', () => {
  it('imports top-level feeds into default group, creates groups, keeps OrigRead flags and skips duplicate URLs', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)
    const result = service.importFromString(`<?xml version="1.0"?>
      <opml version="2.0"><body>
        <outline text="Loose" xmlUrl="https://example.com/loose.xml" isNotification="true" />
        <outline text="Tech">
          <outline text="One" xmlUrl="https://example.com/one.xml" isFullContent="true" isBrowser="true" />
          <outline text="Duplicate" xmlUrl="https://example.com/loose.xml" />
        </outline>
        <outline text="Empty Group" />
      </body></opml>`)

    expect(result).toEqual({ groupsAdded: 2, feedsAdded: 2, feedsSkipped: 1 })
    const groups = repository.listGroups()
    expect(groups.map((group) => group.name)).toEqual(['Default', 'Tech', 'Empty Group'])
    const feeds = repository.listFeeds()
    const loose = feeds.find((feed) => feed.url === 'https://example.com/loose.xml')!
    expect(loose.groupId).toBe(DEFAULT_GROUP_ID)
    expect(loose.isNotification).toBe(true)
    const one = feeds.find((feed) => feed.url === 'https://example.com/one.xml')!
    expect(groups.find((group) => group.id === one.groupId)?.name).toBe('Tech')
    expect(one).toMatchObject({ isFullContent: true, isBrowser: true, sourceType: 'rss' })
    database.close()
  })

  it('uses an isDefault group outline as the existing default group and exports Android-compatible attributes', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)
    service.importFromString(`<opml version="2.0"><body>
      <outline text="Ignored name" isDefault="true">
        <outline title="A &amp; B" xmlUrl="https://example.com/a?x=1&amp;y=2" isNotification="true" isFullContent="true" isBrowser="true" />
      </outline>
    </body></opml>`)

    expect(repository.listGroups()).toHaveLength(1)
    const feed = repository.listFeeds()[0]!
    expect(feed.groupId).toBe(DEFAULT_GROUP_ID)
    const exported = service.exportToString(true)
    expect(exported).toContain('isDefault="true"')
    expect(exported).toContain('isNotification="true"')
    expect(exported).toContain('isFullContent="true"')
    expect(exported).toContain('isBrowser="true"')
    expect(exported).toContain('title="A &amp; B"')
    expect(exported).toContain('xmlUrl="https://example.com/a?x=1&amp;y=2"')
    database.close()
  })

  it('rejects non-OPML input before writing anything', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)
    expect(() => service.importFromString('<html><body>nope</body></html>')).toThrow('OPML')
    expect(repository.snapshot()).toMatchObject({ groups: 1, feeds: 1 })
    database.close()
  })
})
