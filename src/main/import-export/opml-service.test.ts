import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { CURRENT_ACCOUNT_SETTING_KEY, DEFAULT_GROUP_ID } from '../database/migrations'
import { OpmlService } from './opml-service'

describe('OpmlService', () => {
  it('reuses the default and normalized group paths across repeated imports', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)
    const input = `<opml><body>
      <outline text=" Default "><outline text="A" xmlUrl="https://example.com/a.xml" /></outline>
      <outline text=" Tech "><outline text=" Java "><outline text="B" xmlUrl="https://example.com/b.xml" /></outline></outline>
      <outline text="Tech"><outline text="Java"><outline text="C" xmlUrl="https://example.com/c.xml" /></outline></outline>
    </body></opml>`
    expect(service.importFromString(input)).toEqual({ groupsAdded: 2, feedsAdded: 3, feedsSkipped: 0 })
    expect(repository.listGroups().map((group) => group.name)).toEqual(['Default', 'Tech', 'Java'])
    const tech = repository.listGroups().find((g) => g.name === 'Tech')!
    const java = repository.listGroups().find((g) => g.name === 'Java')!
    expect(tech.parentId).toBeNull()
    expect(java.parentId).toBe(tech.id)
    expect(repository.findFeedByUrl('https://example.com/a.xml')?.groupId).toBe(DEFAULT_GROUP_ID)
    expect(repository.findFeedByUrl('https://example.com/b.xml')?.groupId).toBe(java.id)
    expect(repository.findFeedByUrl('https://example.com/c.xml')?.groupId).toBe(java.id)
    expect(service.importFromString(input)).toEqual({ groupsAdded: 0, feedsAdded: 0, feedsSkipped: 3 })
    database.close()
  })

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

  it('preserves nested hierarchy and empty groups across full export and import round-trip', () => {
    const db1 = new DesktopDatabase(':memory:')
    const repo1 = new LibraryRepository(db1.connection)
    const service1 = new OpmlService(repo1)

    const initialOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Default" isDefault="true">
      <outline text="Feed In Default" xmlUrl="https://example.com/default.xml" isNotification="true" />
    </outline>
    <outline text="Engineering">
      <outline text="Feed In Eng" xmlUrl="https://example.com/eng.xml" />
      <outline text="Frontend">
        <outline text="React" xmlUrl="https://example.com/react.xml" isFullContent="true" />
      </outline>
    </outline>
    <outline text="Empty Category" />
  </body>
</opml>`

    service1.importFromString(initialOpml)
    const exported = service1.exportToString(true)

    // 检查导出的 XML 包含真实嵌套结构
    expect(exported).toContain('<outline text="Engineering" title="Engineering">')
    expect(exported).toContain('<outline text="Frontend" title="Frontend">')
    expect(exported).toContain('<outline text="Empty Category" title="Empty Category" />')

    // 导入到全新数据库以测试完整往返一致性
    const db2 = new DesktopDatabase(':memory:')
    const repo2 = new LibraryRepository(db2.connection)
    const service2 = new OpmlService(repo2)

    const roundTripResult = service2.importFromString(exported)
    expect(roundTripResult.groupsAdded).toBe(3) // Engineering, Frontend, Empty Category
    expect(roundTripResult.feedsAdded).toBe(3)

    const groups = repo2.listGroups()
    const eng = groups.find((g) => g.name === 'Engineering')!
    const frontend = groups.find((g) => g.name === 'Frontend')!
    const emptyCat = groups.find((g) => g.name === 'Empty Category')!

    expect(eng.parentId).toBeNull()
    expect(frontend.parentId).toBe(eng.id)
    expect(emptyCat.parentId).toBeNull()

    const feeds = repo2.listFeeds()
    const feedDefault = feeds.find((f) => f.url === 'https://example.com/default.xml')!
    const feedEng = feeds.find((f) => f.url === 'https://example.com/eng.xml')!
    const feedReact = feeds.find((f) => f.url === 'https://example.com/react.xml')!

    expect(feedDefault.groupId).toBe(DEFAULT_GROUP_ID)
    expect(feedDefault.isNotification).toBe(true)
    expect(feedEng.groupId).toBe(eng.id)
    expect(feedReact.groupId).toBe(frontend.id)
    expect(feedReact.isFullContent).toBe(true)

    db1.close()
    db2.close()
  })

  it('allows sibling groups with identical names under different parent groups (同名不同父)', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline text="News">
          <outline text="Tech News Feed" xmlUrl="https://example.com/tech-news.xml" />
        </outline>
      </outline>
      <outline text="Life">
        <outline text="News">
          <outline text="Life News Feed" xmlUrl="https://example.com/life-news.xml" />
        </outline>
      </outline>
    </body></opml>`

    const result = service.importFromString(input)
    expect(result).toEqual({ groupsAdded: 4, feedsAdded: 2, feedsSkipped: 0 })

    const groups = repository.listGroups()
    const tech = groups.find((g) => g.name === 'Tech')!
    const life = groups.find((g) => g.name === 'Life')!
    const newsGroups = groups.filter((g) => g.name === 'News')

    expect(newsGroups).toHaveLength(2)
    const techNews = newsGroups.find((g) => g.parentId === tech.id)!
    const lifeNews = newsGroups.find((g) => g.parentId === life.id)!
    expect(techNews).toBeDefined()
    expect(lifeNews).toBeDefined()

    expect(repository.findFeedByUrl('https://example.com/tech-news.xml')?.groupId).toBe(techNews.id)
    expect(repository.findFeedByUrl('https://example.com/life-news.xml')?.groupId).toBe(lifeNews.id)

    // 重复导入幂等
    const repeatResult = service.importFromString(input)
    expect(repeatResult).toEqual({ groupsAdded: 0, feedsAdded: 0, feedsSkipped: 2 })
    database.close()
  })

  it('does not split group names containing slashes (含/普通名称不拆)', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="CI / CD">
        <outline text="Pipeline Feed" xmlUrl="https://example.com/pipeline.xml" />
      </outline>
    </body></opml>`

    const result = service.importFromString(input)
    expect(result).toEqual({ groupsAdded: 1, feedsAdded: 1, feedsSkipped: 0 })

    const groups = repository.listGroups()
    expect(groups.map((g) => g.name)).toEqual(['Default', 'CI / CD'])
    const ciGroup = groups.find((g) => g.name === 'CI / CD')!
    expect(ciGroup.parentId).toBeNull()
    database.close()
  })

  it('hoists children of anonymous containers without creating empty-named folders', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline>
          <outline text="Feed In Container" xmlUrl="https://example.com/container.xml" />
          <outline text="Subgroup">
            <outline text="Deep Feed" xmlUrl="https://example.com/deep.xml" />
          </outline>
        </outline>
      </outline>
      <outline>
        <outline text="Root Hoisted Feed" xmlUrl="https://example.com/root.xml" />
      </outline>
    </body></opml>`

    const result = service.importFromString(input)
    expect(result.groupsAdded).toBe(2) // Tech, Subgroup

    const groups = repository.listGroups()
    expect(groups.map((g) => g.name)).toEqual(['Default', 'Tech', 'Subgroup'])
    const tech = groups.find((g) => g.name === 'Tech')!
    const subgroup = groups.find((g) => g.name === 'Subgroup')!
    expect(subgroup.parentId).toBe(tech.id)

    const feedContainer = repository.findFeedByUrl('https://example.com/container.xml')!
    expect(feedContainer.groupId).toBe(tech.id)

    const rootHoisted = repository.findFeedByUrl('https://example.com/root.xml')!
    expect(rootHoisted.groupId).toBe(DEFAULT_GROUP_ID)

    database.close()
  })

  it('handles outline having both xmlUrl and children as feed plus child structure', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline text="Feed With Children" xmlUrl="https://example.com/parent.xml">
          <outline text="Child Feed" xmlUrl="https://example.com/child.xml" />
          <outline text="Child Group">
            <outline text="Grandchild Feed" xmlUrl="https://example.com/grandchild.xml" />
          </outline>
        </outline>
      </outline>
    </body></opml>`

    const result = service.importFromString(input)
    expect(result.groupsAdded).toBe(2) // Tech, Child Group
    expect(result.feedsAdded).toBe(3) // parent, child, grandchild

    const groups = repository.listGroups()
    const tech = groups.find((g) => g.name === 'Tech')!
    const childGroup = groups.find((g) => g.name === 'Child Group')!
    expect(childGroup.parentId).toBe(tech.id)

    const parentFeed = repository.findFeedByUrl('https://example.com/parent.xml')!
    expect(parentFeed.groupId).toBe(tech.id)

    const childFeed = repository.findFeedByUrl('https://example.com/child.xml')!
    expect(childFeed.groupId).toBe(tech.id)

    const grandchildFeed = repository.findFeedByUrl('https://example.com/grandchild.xml')!
    expect(grandchildFeed.groupId).toBe(childGroup.id)

    database.close()
  })

  it('bounds recursion and throws on input exceeding maximum depth limit (32 levels)', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    // 构建超过 32 层的深度嵌套
    let nested = '<outline text="Leaf" xmlUrl="https://example.com/leaf.xml" />'
    for (let i = 33; i >= 1; i--) {
      nested = `<outline text="Level${i}">${nested}</outline>`
    }
    const deepInput = `<opml version="2.0"><body>${nested}</body></opml>`

    expect(() => service.importFromString(deepInput)).toThrow('分组层级深度超过最大限制')
    database.close()
  })

  it('rolls back entire transaction on invalid feed URL leaving no partial groups', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="Brand New Group">
        <outline text="Valid Feed" xmlUrl="https://example.com/good.xml" />
        <outline text="Invalid Feed" xmlUrl="ftp://invalid.com/bad.xml" />
      </outline>
    </body></opml>`

    expect(() => service.importFromString(input)).toThrow('OPML 来源仅支持 HTTP(S)')
    // 数据库保持不变，未留下 Brand New Group 半组
    expect(repository.listGroups().map((g) => g.name)).toEqual(['Default'])
    expect(repository.listFeeds()).toHaveLength(1) // 迁移初始的示例 feed
    database.close()
  })

  it('rejects importing into remote accounts without writing anything', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    // 创建一个远程账户 (accountId: 2, type: 'fresh_rss') 并将其设为当前账户
    database.connection
      .prepare('INSERT INTO accounts (id, name, type, created_at) VALUES (?, ?, ?, ?)')
      .run(2, 'FreshRSS', 'fresh_rss', Date.now())
    database.connection
      .prepare(
        'INSERT INTO groups (id, account_id, name, sort_order, is_default, parent_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('remote-default', 2, 'Default', 0, 1, null)
    database.connection
      .prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(CURRENT_ACCOUNT_SETTING_KEY, '2', Date.now())

    expect(repository.getCurrentAccountId()).toBe(2)

    const input = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline text="Java">
          <outline text="Spring Feed" xmlUrl="https://example.com/spring.xml" />
        </outline>
      </outline>
    </body></opml>`

    expect(() => service.importFromString(input)).toThrow('当前远端账户不支持导入 OPML')
    expect(repository.listGroupsForAccount(2)).toHaveLength(1)
    expect(repository.listFeedsForAccount(2)).toHaveLength(0)

    database.close()
  })

  it('rejects group name longer than 200 characters before writing anything', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const longName = 'A'.repeat(201)
    const input = `<opml version="2.0"><body>
      <outline text="${longName}">
        <outline text="Feed" xmlUrl="https://example.com/feed.xml" />
      </outline>
    </body></opml>`

    expect(() => service.importFromString(input)).toThrow('分组名称不能超过 200 个字符')
    expect(repository.listGroups().map((g) => g.name)).toEqual(['Default'])
    expect(repository.listFeeds()).toHaveLength(1) // 初始示例 feed
    database.close()
  })

  it('treats root group matching default group name as case-sensitive and prioritizes default marker', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    // 1. 小写 "default" 根分组不与默认分组 "Default" 合并，而是创建独立的 "default" 分组
    const input1 = `<opml version="2.0"><body>
      <outline text="default">
        <outline text="Feed In Lowercase Default" xmlUrl="https://example.com/lower.xml" />
      </outline>
    </body></opml>`
    service.importFromString(input1)

    const groups1 = repository.listGroups()
    expect(groups1.map((g) => g.name)).toEqual(['Default', 'default'])
    const lowerGroup = groups1.find((g) => g.name === 'default')!
    expect(lowerGroup.isDefault).toBe(false)
    expect(repository.findFeedByUrl('https://example.com/lower.xml')?.groupId).toBe(lowerGroup.id)

    // 2. 大写 "Default" 根分组与默认分组精确合并
    const input2 = `<opml version="2.0"><body>
      <outline text="Default">
        <outline text="Feed In Exact Default" xmlUrl="https://example.com/exact.xml" />
      </outline>
    </body></opml>`
    service.importFromString(input2)
    expect(repository.listGroups().map((g) => g.name)).toEqual(['Default', 'default'])
    expect(repository.findFeedByUrl('https://example.com/exact.xml')?.groupId).toBe(DEFAULT_GROUP_ID)

    // 3. 带有 isDefault="true" 标记的任何名称优先归入默认分组
    const input3 = `<opml version="2.0"><body>
      <outline text="Custom Marker Name" isDefault="true">
        <outline text="Feed In Marker Default" xmlUrl="https://example.com/marker.xml" />
      </outline>
    </body></opml>`
    service.importFromString(input3)
    expect(repository.findFeedByUrl('https://example.com/marker.xml')?.groupId).toBe(DEFAULT_GROUP_ID)

    database.close()
  })

  it('maintains single entity decoding for URLs with & and literal &amp; across round-trip', () => {
    const db1 = new DesktopDatabase(':memory:')
    const repo1 = new LibraryRepository(db1.connection)
    const service1 = new OpmlService(repo1)

    const input = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Tech">
      <outline text="Feed With Entities" xmlUrl="https://example.com/feed?a=1&amp;b=2&amp;amp;literal=3" />
    </outline>
  </body>
</opml>`

    service1.importFromString(input)
    const feed1 = repo1.findFeedByUrl('https://example.com/feed?a=1&b=2&amp;literal=3')!
    expect(feed1).toBeDefined()
    expect(feed1.url).toBe('https://example.com/feed?a=1&b=2&amp;literal=3')

    const exported = service1.exportToString(true)
    expect(exported).toContain('xmlUrl="https://example.com/feed?a=1&amp;b=2&amp;amp;literal=3"')

    // 往返导入第二个库
    const db2 = new DesktopDatabase(':memory:')
    const repo2 = new LibraryRepository(db2.connection)
    const service2 = new OpmlService(repo2)

    service2.importFromString(exported)
    const feed2 = repo2.findFeedByUrl('https://example.com/feed?a=1&b=2&amp;literal=3')!
    expect(feed2).toBeDefined()
    expect(feed2.url).toBe('https://example.com/feed?a=1&b=2&amp;literal=3')

    db1.close()
    db2.close()
  })

  it('handles group names with colons, quotes and slashes without key collision', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new OpmlService(repository)

    const input = `<opml version="2.0"><body>
      <outline text="A::B">
        <outline text="C&quot;D&apos;E">
          <outline text="Feed 1" xmlUrl="https://example.com/1.xml" />
        </outline>
      </outline>
      <outline text="A">
        <outline text="B::C&quot;D&apos;E">
          <outline text="Feed 2" xmlUrl="https://example.com/2.xml" />
        </outline>
      </outline>
    </body></opml>`

    const result = service.importFromString(input)
    expect(result.groupsAdded).toBe(4)
    expect(result.feedsAdded).toBe(2)

    const groups = repository.listGroups()
    const ab = groups.find((g) => g.name === 'A::B')!
    const cde = groups.find((g) => g.name === 'C"D\'E')!
    const a = groups.find((g) => g.name === 'A')!
    const bcde = groups.find((g) => g.name === 'B::C"D\'E')!

    expect(ab.parentId).toBeNull()
    expect(cde.parentId).toBe(ab.id)
    expect(a.parentId).toBeNull()
    expect(bcde.parentId).toBe(a.id)

    expect(repository.findFeedByUrl('https://example.com/1.xml')?.groupId).toBe(cde.id)
    expect(repository.findFeedByUrl('https://example.com/2.xml')?.groupId).toBe(bcde.id)

    database.close()
  })
})
