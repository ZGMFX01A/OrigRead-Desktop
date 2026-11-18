import { describe, expect, it, vi } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AccountRepository } from './account-repository'
import { DesktopAccountService } from './desktop-account-service'

describe('DesktopAccountService Android parity', () => {
  it('reuses normalized names and the default group within the current local account', async () => {
    const fixture = createFixture(true)
    const first = await fixture.service.addGroup(' Tech ')
    const repeated = await fixture.service.addGroup('Tech')
    expect(repeated.id).toBe(first.id)
    expect(first.name).toBe('Tech')
    expect((await fixture.service.addGroup(' Default ')).isDefault).toBe(true)
    expect(fixture.library.listGroups()).toHaveLength(2)
    await expect(fixture.service.addGroup('   ')).rejects.toThrow('分组名称不能为空')
    const other = fixture.accounts.add({ type: 'local', name: 'Other' })
    const separate = await fixture.service.addGroup('Tech')
    expect(separate.accountId).toBe(other.id)
    expect(separate.id).not.toBe(first.id)
    fixture.database.close()
  })

  it('reuses legacy names with surrounding whitespace', async () => {
    const fixture = createFixture(true)
    fixture.library.upsertGroup({ id: 'legacy', accountId: 1, name: ' Tech ', sortOrder: 1, isDefault: false })
    expect((await fixture.service.addGroup('Tech')).id).toBe('legacy')
    expect(fixture.library.listGroups()).toHaveLength(2)
    fixture.database.close()
  })

  it('rolls back the inserted account and restores the previous account when credential validation fails', async () => {
    const fixture = createFixture(false)
    const originalId = fixture.accounts.currentId()

    await expect(fixture.service.add({ type:'google_reader',serverUrl:'https://reader.example/',username:'user',password:'invalid' }))
      .rejects.toThrow('服务器拒绝了当前账户凭据')
    expect(fixture.accounts.currentId()).toBe(originalId)
    expect(fixture.accounts.list()).toHaveLength(1)
    expect(fixture.remote.sync).not.toHaveBeenCalled()
    fixture.database.close()
  })

  it('returns after successful credential validation and starts the first remote sync without blocking add completion', async () => {
    const fixture = createFixture(true)
    let releaseSync!:()=>void
    const pending = new Promise<void>((resolve)=>{releaseSync=resolve})
    fixture.remote.sync.mockReturnValueOnce(pending)

    const added = await fixture.service.add({ type:'fresh_rss',serverUrl:'https://fresh.example/',username:'user',password:'valid' })
    expect(added.type).toBe('fresh_rss')
    expect(fixture.accounts.currentId()).toBe(added.id)
    expect(fixture.remote.sync).toHaveBeenCalledWith(added.id)
    releaseSync()
    fixture.database.close()
  })

  describe('renameGroup', () => {
    it('renames a local group and preserves id, accountId, sortOrder, isDefault, and feed associations', async () => {
      const fixture = createFixture(true)
      const group = await fixture.service.addGroup('Tech')
      fixture.library.upsertFeed({
        id: 'feed-1',
        accountId: group.accountId,
        groupId: group.id,
        name: 'Feed 1',
        url: 'https://example.com/rss',
        sourcePageUrl: null,
        sourceType: 'rss',
        icon: null,
        isNotification: false,
        isFullContent: false,
        isBrowser: false,
        dynamicRendering: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })

      const renamed = await fixture.service.renameGroup(group.id, '  Technology  ')
      expect(renamed.id).toBe(group.id)
      expect(renamed.name).toBe('Technology')
      expect(renamed.accountId).toBe(group.accountId)
      expect(renamed.sortOrder).toBe(group.sortOrder)
      expect(renamed.isDefault).toBe(false)
      expect(fixture.library.getFeedById('feed-1')?.groupId).toBe(group.id)

      const same = await fixture.service.renameGroup(group.id, 'Technology')
      expect(same.name).toBe('Technology')

      fixture.database.close()
    })

    it('rejects empty or whitespace-only name and names longer than 200 characters', async () => {
      const fixture = createFixture(true)
      const group = await fixture.service.addGroup('Science')
      await expect(fixture.service.renameGroup(group.id, '')).rejects.toThrow('分组名称不能为空')
      await expect(fixture.service.renameGroup(group.id, '   ')).rejects.toThrow('分组名称不能为空')
      await expect(fixture.service.renameGroup(group.id, 'a'.repeat(201))).rejects.toThrow('分组名称不能超过 200 个字符')
      fixture.database.close()
    })

    it('renames the default group while preserving its identity and default role', async () => {
      const fixture = createFixture(true)
      const defaultGroup = fixture.library.listGroups().find((g) => g.isDefault)!
      expect(defaultGroup).toBeDefined()
      const renamed = await fixture.service.renameGroup(defaultGroup.id, '  My Sources  ')
      expect(renamed).toEqual({ ...defaultGroup, name: 'My Sources' })
      expect(fixture.library.getDefaultGroupForAccount(defaultGroup.accountId!)).toEqual(renamed)
      expect((await fixture.service.addGroup('My Sources')).id).toBe(defaultGroup.id)
      fixture.database.close()
    })

    it('rejects duplicate names within the same account while allowing identical names in other accounts', async () => {
      const fixture = createFixture(true)
      const currentAccountId = fixture.accounts.currentId()
      const group1 = await fixture.service.addGroup('Design')
      await fixture.service.addGroup('Development')

      await expect(fixture.service.renameGroup(group1.id, 'Development')).rejects.toThrow('分组名称已存在')

      const otherAccount = fixture.accounts.add({ type: 'local', name: 'Other' })
      const otherGroup = await fixture.service.addGroup('Design')
      expect(otherGroup.accountId).toBe(otherAccount.id)

      fixture.accounts.switchTo(currentAccountId)
      await expect(fixture.service.renameGroup(group1.id, 'Design')).resolves.toMatchObject({ id: group1.id, name: 'Design' })

      fixture.database.close()
    })

    it('rejects non-existent group or group belonging to another account', async () => {
      const fixture = createFixture(true)
      const group1 = await fixture.service.addGroup('Music')
      await expect(fixture.service.renameGroup('non-existent-id', 'Art')).rejects.toThrow('分组不存在')

      const otherAccount = fixture.accounts.add({ type: 'local', name: 'Other' })
      const otherGroup = await fixture.service.addGroup('OtherMusic')

      fixture.accounts.switchTo(1)
      await expect(fixture.service.renameGroup(otherGroup.id, 'Renamed')).rejects.toThrow('分组不存在')

      fixture.database.close()
    })

    it('delegates renaming group to remote service for remote accounts', async () => {
      const fixture = createFixture(true)
      const expectedRecord = { id: 'remote-group-1', accountId: 2, name: 'Renamed', sortOrder: 0, isDefault: false }
      fixture.remote.renameGroup.mockResolvedValueOnce(expectedRecord)
      await fixture.service.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example/', username: 'user', password: 'valid' })
      expect(fixture.service.current().type).toBe('fresh_rss')

      const result = await fixture.service.renameGroup('remote-group-1', 'Renamed')
      expect(fixture.remote.renameGroup).toHaveBeenCalledWith('remote-group-1', 'Renamed')
      expect(result).toBe(expectedRecord)

      fixture.database.close()
    })

    it('delegates refreshGroup to localSync without advancing syncMetadata or archiving', async () => {
      const fixture = createFixture(true)
      const group = await fixture.service.addGroup('Work')
      const mockResult = {
        startedAt: 1000,
        finishedAt: 1005,
        sourceCount: 1,
        successCount: 1,
        failedCount: 0,
        fetchedArticles: 0,
        insertedArticles: 0,
        deletedArticles: 0,
        retryRecommended: false,
        results: []
      }
      fixture.localSync.refreshGroup.mockResolvedValueOnce(mockResult)

      const originalUpdatedAt = fixture.accounts.current().updatedAt
      const result = await fixture.service.refreshGroup(group.id)

      expect(fixture.localSync.refreshGroup).toHaveBeenCalledWith(group.id, expect.any(Number), 1)
      expect(result).toBe(mockResult)
      // 局部刷新不能推进全账户的 updatedAt
      expect(fixture.accounts.current().updatedAt).toBe(originalUpdatedAt)

      fixture.database.close()
    })
  })

  describe('addGroup with hierarchy options', () => {
    it('creates child group under existing parent with valid parentId and normalizes empty parentId to null', async () => {
      const fixture = createFixture(true)
      const parent = await fixture.service.addGroup('Tech')
      const child = await fixture.service.addGroup('Frontend', { parentId: parent.id })
      expect(child.parentId).toBe(parent.id)
      expect(child.name).toBe('Frontend')

      // 空值归一：'', '   ', null 归一为 null
      const root1 = await fixture.service.addGroup('Root1', { parentId: '' })
      expect(root1.parentId).toBeNull()
      const root2 = await fixture.service.addGroup('Root2', { parentId: '   ' })
      expect(root2.parentId).toBeNull()
      const root3 = await fixture.service.addGroup('Root3', { parentId: null })
      expect(root3.parentId).toBeNull()

      fixture.database.close()
    })

    it('reuses existing group under the same parent and allows cross-parent duplicate names', async () => {
      const fixture = createFixture(true)
      const parentA = await fixture.service.addGroup('ParentA')
      const parentB = await fixture.service.addGroup('ParentB')

      const childA = await fixture.service.addGroup('General', { parentId: parentA.id })
      const repeatedChildA = await fixture.service.addGroup('General', { parentId: parentA.id })
      expect(repeatedChildA.id).toBe(childA.id)

      // 跨父同名允许
      const childB = await fixture.service.addGroup('General', { parentId: parentB.id })
      expect(childB.id).not.toBe(childA.id)
      expect(childB.name).toBe('General')
      expect(childB.parentId).toBe(parentB.id)

      fixture.database.close()
    })

    it('rejects default group as parent or non-existent parent', async () => {
      const fixture = createFixture(true)
      const defaultGroup = fixture.library.listGroups().find((g) => g.isDefault)!
      await expect(fixture.service.addGroup('Child', { parentId: defaultGroup.id })).rejects.toThrow('默认分组不允许作为父分组')
      await expect(fixture.service.addGroup('Child', { parentId: 'non-existent' })).rejects.toThrow('指定的父分组不存在')

      const otherAccount = fixture.accounts.add({ type: 'local', name: 'Other' })
      const otherGroup = await fixture.service.addGroup('OtherParent')
      fixture.accounts.switchTo(1)
      await expect(fixture.service.addGroup('Child', { parentId: otherGroup.id })).rejects.toThrow('指定的父分组不存在')

      fixture.database.close()
    })

    it('rejects hierarchy on remote accounts and preserves backward compatibility with destFeedId', async () => {
      const fixture = createFixture(true)
      await fixture.service.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example/', username: 'user', password: 'valid' })
      expect(fixture.service.current().type).toBe('fresh_rss')

      // 远端拒绝层级
      await expect(fixture.service.addGroup('RemoteChild', { parentId: 'parent-1' })).rejects.toThrow('远程账户分组不支持层级结构')

      // 兼容向后传递 destFeedId
      fixture.remote.addGroup.mockResolvedValueOnce({ id: 'remote-grp', name: 'Work', isDefault: false, sortOrder: 0 })
      await fixture.service.addGroup('Work', 'dest-feed-123')
      expect(fixture.remote.addGroup).toHaveBeenCalledWith('Work', 'dest-feed-123')

      fixture.remote.addGroup.mockResolvedValueOnce({ id: 'remote-grp2', name: 'Work2', isDefault: false, sortOrder: 1 })
      await fixture.service.addGroup('Work2', { destFeedId: 'dest-feed-456' })
      expect(fixture.remote.addGroup).toHaveBeenCalledWith('Work2', 'dest-feed-456')

      fixture.database.close()
    })

    it('rejects exceeding 32 levels of depth on addGroup', async () => {
      const fixture = createFixture(true)
      let currentParentId: string | null = null
      for (let i = 1; i <= 32; i++) {
        const grp = await fixture.service.addGroup(`Level${i}`, currentParentId ? { parentId: currentParentId } : undefined)
        currentParentId = grp.id
      }
      // 第 33 层应被拒绝
      await expect(fixture.service.addGroup('Level33', { parentId: currentParentId! })).rejects.toThrow('分组层级深度超过最大限制 (32)')

      fixture.database.close()
    })
  })

  describe('renameGroup cross-parent parity', () => {
    it('allows renaming to a name that exists under a different parent, but rejects sibling duplicate', async () => {
      const fixture = createFixture(true)
      const parentA = await fixture.service.addGroup('ParentA')
      const parentB = await fixture.service.addGroup('ParentB')
      const childA = await fixture.service.addGroup('General', { parentId: parentA.id })
      const childB = await fixture.service.addGroup('Specific', { parentId: parentB.id })
      const siblingB = await fixture.service.addGroup('Other', { parentId: parentB.id })

      // 重命名 childB 为 'General'（ParentA 已有，但 ParentB 没有）-> 允许
      const renamed = await fixture.service.renameGroup(childB.id, 'General')
      expect(renamed.name).toBe('General')
      expect(renamed.parentId).toBe(parentB.id)

      // 重命名 siblingB 为 'General'（ParentB 下已有 childB 叫 'General'）-> 拒绝
      await expect(fixture.service.renameGroup(siblingB.id, 'General')).rejects.toThrow('分组名称已存在')

      fixture.database.close()
    })
  })

  describe('moveGroup', () => {
    it('moves a group to another parent or to root with empty/null normalization', async () => {
      const fixture = createFixture(true)
      const parent1 = await fixture.service.addGroup('Parent1')
      const parent2 = await fixture.service.addGroup('Parent2')
      const child = await fixture.service.addGroup('Child', { parentId: parent1.id })

      // 移动到 parent2
      const moved = await fixture.service.moveGroup(child.id, parent2.id)
      expect(moved.parentId).toBe(parent2.id)
      expect(fixture.library.listGroups().find((g) => g.id === child.id)?.parentId).toBe(parent2.id)

      // 空值归一移回根：null
      const root1 = await fixture.service.moveGroup(child.id, null)
      expect(root1.parentId).toBeNull()

      // 移回 parent1
      await fixture.service.moveGroup(child.id, parent1.id)

      // 空值归一移回根：空字符串与空格
      const root2 = await fixture.service.moveGroup(child.id, '   ')
      expect(root2.parentId).toBeNull()

      fixture.database.close()
    })

    it('preserves groupId and associated feeds when moving a group', async () => {
      const fixture = createFixture(true)
      const parent = await fixture.service.addGroup('Parent')
      const group = await fixture.service.addGroup('GroupToMove')
      fixture.library.upsertFeed({
        id: 'feed-move-test',
        accountId: group.accountId,
        groupId: group.id,
        name: 'Feed Bound To Group',
        url: 'https://example.com/feed',
        sourcePageUrl: null,
        sourceType: 'rss',
        icon: null,
        isNotification: false,
        isFullContent: false,
        isBrowser: false,
        dynamicRendering: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })

      const moved = await fixture.service.moveGroup(group.id, parent.id)
      expect(moved.id).toBe(group.id)
      expect(moved.parentId).toBe(parent.id)

      const feed = fixture.library.getFeedById('feed-move-test')
      expect(feed).toBeDefined()
      expect(feed?.groupId).toBe(group.id)

      fixture.database.close()
    })

    it('rejects moving default group and rejects setting default group as parent', async () => {
      const fixture = createFixture(true)
      const defaultGroup = fixture.library.listGroups().find((g) => g.isDefault)!
      const normalGroup = await fixture.service.addGroup('Normal')

      await expect(fixture.service.moveGroup(defaultGroup.id, normalGroup.id)).rejects.toThrow('默认分组不允许移动')
      await expect(fixture.service.moveGroup(defaultGroup.id, null)).rejects.toThrow('默认分组不允许移动')
      await expect(fixture.service.moveGroup(normalGroup.id, defaultGroup.id)).rejects.toThrow('默认分组不允许作为父分组')

      fixture.database.close()
    })

    it('rejects self-parenting and cycle references when moving', async () => {
      const fixture = createFixture(true)
      const nodeA = await fixture.service.addGroup('NodeA')
      const nodeB = await fixture.service.addGroup('NodeB', { parentId: nodeA.id })
      const nodeC = await fixture.service.addGroup('NodeC', { parentId: nodeB.id })

      // 自引用
      await expect(fixture.service.moveGroup(nodeA.id, nodeA.id)).rejects.toThrow('分组不能将自身设为父分组')

      // 移动到子孙节点造成环：A 移到 C 下
      await expect(fixture.service.moveGroup(nodeA.id, nodeC.id)).rejects.toThrow('检测到分组循环嵌套引用')
      // A 移到 B 下
      await expect(fixture.service.moveGroup(nodeA.id, nodeB.id)).rejects.toThrow('检测到分组循环嵌套引用')

      fixture.database.close()
    })

    it('rejects move if total subtree depth exceeds 32', async () => {
      const fixture = createFixture(true)
      // 构建深度为 30 的链
      let topId: string | null = null
      for (let i = 1; i <= 30; i++) {
        const g = await fixture.service.addGroup(`Chain${i}`, topId ? { parentId: topId } : undefined)
        topId = g.id
      }
      // 构建高度为 3 的子树：Sub1 -> Sub2 -> Sub3
      const sub1 = await fixture.service.addGroup('Sub1')
      const sub2 = await fixture.service.addGroup('Sub2', { parentId: sub1.id })
      await fixture.service.addGroup('Sub3', { parentId: sub2.id })

      // topId 深度为 30，sub1 子树高度为 3，30 + 3 = 33 > 32
      await expect(fixture.service.moveGroup(sub1.id, topId!)).rejects.toThrow('分组层级深度超过最大限制 (32)')

      fixture.database.close()
    })

    it('rejects moving when target parent already has a sibling with the same name', async () => {
      const fixture = createFixture(true)
      const parent = await fixture.service.addGroup('Parent')
      await fixture.service.addGroup('ChildName', { parentId: parent.id })
      const outsider = await fixture.service.addGroup('ChildName') // 根节点

      await expect(fixture.service.moveGroup(outsider.id, parent.id)).rejects.toThrow('同一层级下已存在同名分组')

      fixture.database.close()
    })

    it('rejects moving groups on remote accounts and non-existent groups', async () => {
      const fixture = createFixture(true)
      const localGroup = await fixture.service.addGroup('LocalGrp')
      await expect(fixture.service.moveGroup('non-existent-id', null)).rejects.toThrow('分组不存在')

      await fixture.service.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example/', username: 'user', password: 'valid' })
      expect(fixture.service.current().type).toBe('fresh_rss')

      await expect(fixture.service.moveGroup(localGroup.id, null)).rejects.toThrow('远程账户分组不支持层级结构')

      fixture.database.close()
    })
  })
})

function createFixture(valid:boolean) {
  const database=new DesktopDatabase(':memory:')
  const library=new LibraryRepository(database.connection)
  const accounts=new AccountRepository(database.connection,new MemorySecretStore())
  const remote={
    validCredentials:vi.fn(async()=>valid),sync:vi.fn(async(_id:number):Promise<void>=>{}),subscribeRss:vi.fn(),
    markArticleUnread:vi.fn(),markArticleStarred:vi.fn(),addGroup:vi.fn(),updateFeed:vi.fn(),deleteFeed:vi.fn(),renameGroup:vi.fn()
  }
  const localSync={refreshAllSources:vi.fn(),refreshGroup:vi.fn()}
  const service=new DesktopAccountService(accounts,library,{ remote: remote as never, localSync: localSync as never })
  return{database,library,accounts,remote,localSync,service}
}
