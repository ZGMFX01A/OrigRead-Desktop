import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from './database'
import { LibraryRepository } from './library-repository'
import { AccountRepository } from '../accounts/account-repository'
import { DesktopAccountService } from '../accounts/desktop-account-service'
import type { FeedRecord, GroupRecord } from '../../shared/library'

describe('Library Group Hierarchy (Schema v16)', () => {
  function setupTestEnv() {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const mockSecrets = {
      put: () => {},
      get: () => null,
      delete: () => {},
      contains: () => true
    }
    const accounts = new AccountRepository(database.connection, mockSecrets as any)
    const defaultGroup = repository.getCurrentDefaultGroup()
    return { database, repository, accounts, defaultGroup }
  }

  it('reads and writes parentId properly in SqliteLibraryCatalog', () => {
    const { repository } = setupTestEnv()

    // Default group has parentId as null
    const defaultGroup = repository.getCurrentDefaultGroup()
    expect(defaultGroup.parentId).toBeNull()

    // Add root-level custom group
    const parentGroup: GroupRecord = {
      id: 'grp-parent',
      accountId: 1,
      name: 'Engineering',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    }
    repository.upsertGroup(parentGroup)

    // Add child group
    const childGroup: GroupRecord = {
      id: 'grp-child',
      accountId: 1,
      name: 'Frontend',
      sortOrder: 1,
      isDefault: false,
      parentId: 'grp-parent'
    }
    repository.upsertGroup(childGroup)

    // Add grandchild group
    const grandchildGroup: GroupRecord = {
      id: 'grp-grandchild',
      accountId: 1,
      name: 'React',
      sortOrder: 1,
      isDefault: false,
      parentId: 'grp-child'
    }
    repository.upsertGroup(grandchildGroup)

    // List groups for account 1
    const groups = repository.listGroupsForAccount(1)
    const readParent = groups.find((g) => g.id === 'grp-parent')!
    const readChild = groups.find((g) => g.id === 'grp-child')!
    const readGrandchild = groups.find((g) => g.id === 'grp-grandchild')!

    expect(readParent.parentId).toBeNull()
    expect(readChild.parentId).toBe('grp-parent')
    expect(readGrandchild.parentId).toBe('grp-child')
  })

  it('preserves parentId when renaming a group via DesktopAccountService', async () => {
    const { database, repository, accounts } = setupTestEnv()
    const service = new DesktopAccountService(accounts, repository, {} as any)

    // Create parent and child
    repository.upsertGroup({
      id: 'parent-1',
      accountId: 1,
      name: 'Parent',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'child-1',
      accountId: 1,
      name: 'Original Child Name',
      sortOrder: 1,
      isDefault: false,
      parentId: 'parent-1'
    })

    // Rename child
    const renamed = await service.renameGroup('child-1', 'Renamed Child Name')
    expect(renamed.name).toBe('Renamed Child Name')
    expect(renamed.parentId).toBe('parent-1')

    // Read back from repository to verify DB persistence
    const reloaded = repository.listGroupsForAccount(1).find((g) => g.id === 'child-1')!
    expect(reloaded.name).toBe('Renamed Child Name')
    expect(reloaded.parentId).toBe('parent-1')

    database.connection.close()
  })

  it('rejects cross-account parent group', () => {
    const { repository, accounts } = setupTestEnv()

    // Create a second local account
    const acc2 = accounts.add({
      name: 'Second Local',
      type: 'local'
    })

    const acc2Parent: GroupRecord = {
      id: 'acc2-parent',
      accountId: acc2.id,
      name: 'Acc2 Group',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    }
    repository.upsertGroup(acc2Parent)

    // Attempt to set parent of an account 1 group to acc2-parent
    expect(() => {
      repository.upsertGroup({
        id: 'acc1-child',
        accountId: 1,
        name: 'Invalid Cross Account Child',
        sortOrder: 1,
        isDefault: false,
        parentId: 'acc2-parent'
      })
    }).toThrow('父分组必须属于同一账户')
  })

  it('rejects circular hierarchy reference', () => {
    const { repository } = setupTestEnv()

    repository.upsertGroup({
      id: 'node-a',
      accountId: 1,
      name: 'Node A',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'node-b',
      accountId: 1,
      name: 'Node B',
      sortOrder: 1,
      isDefault: false,
      parentId: 'node-a'
    })
    repository.upsertGroup({
      id: 'node-c',
      accountId: 1,
      name: 'Node C',
      sortOrder: 1,
      isDefault: false,
      parentId: 'node-b'
    })

    // Self-parenting
    expect(() => {
      repository.upsertGroup({
        id: 'node-a',
        accountId: 1,
        name: 'Node A',
        sortOrder: 1,
        isDefault: false,
        parentId: 'node-a'
      })
    }).toThrow('分组不能将自身设为父分组')

    // Moving A under C (where A is ancestor of C)
    expect(() => {
      repository.upsertGroup({
        id: 'node-a',
        accountId: 1,
        name: 'Node A',
        sortOrder: 1,
        isDefault: false,
        parentId: 'node-c'
      })
    }).toThrow('检测到分组循环嵌套引用')
  })

  it('rejects default group restrictions (cannot have parent, cannot be parent)', () => {
    const { repository, defaultGroup } = setupTestEnv()

    repository.upsertGroup({
      id: 'custom-grp',
      accountId: 1,
      name: 'Custom Group',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })

    // Setting parent on default group
    expect(() => {
      repository.upsertGroup({
        ...defaultGroup,
        parentId: 'custom-grp'
      })
    }).toThrow('默认分组不允许设置父分组')

    // Setting default group as parent of another group
    expect(() => {
      repository.upsertGroup({
        id: 'child-of-default',
        accountId: 1,
        name: 'Child Of Default',
        sortOrder: 1,
        isDefault: false,
        parentId: defaultGroup.id
      })
    }).toThrow('默认分组不允许作为父分组')
  })

  it('rejects non-existent parent', () => {
    const { repository } = setupTestEnv()

    expect(() => {
      repository.upsertGroup({
        id: 'orphan-group',
        accountId: 1,
        name: 'Orphan Group',
        sortOrder: 1,
        isDefault: false,
        parentId: 'non-existent-parent'
      })
    }).toThrow('指定的父分组不存在')
  })

  it('rejects non-null parentId on remote accounts but allows null parentId', () => {
    const { repository, accounts } = setupTestEnv()

    // Create a remote account (e.g. fever or google_reader)
    const remoteAcc = accounts.add({
      name: 'Remote Fever',
      type: 'fever',
      serverUrl: 'https://fever.example.com',
      username: 'user1',
      password: 'password1'
    })

    // Null parent is allowed on remote account
    expect(() => {
      repository.upsertGroup({
        id: 'remote-root',
        accountId: remoteAcc.id,
        name: 'Remote Root',
        sortOrder: 1,
        isDefault: false,
        parentId: null
      })
    }).not.toThrow()

    // Non-null parent is rejected on remote account
    expect(() => {
      repository.upsertGroup({
        id: 'remote-sub',
        accountId: remoteAcc.id,
        name: 'Remote Sub',
        sortOrder: 2,
        isDefault: false,
        parentId: 'remote-root'
      })
    }).toThrow('远程账户分组不支持层级结构')
  })

  it('maintains feed and article relationships when groups have hierarchy', () => {
    const { repository } = setupTestEnv()

    repository.upsertGroup({
      id: 'parent-group',
      accountId: 1,
      name: 'Parent Group',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })

    repository.upsertGroup({
      id: 'child-group',
      accountId: 1,
      name: 'Child Group',
      sortOrder: 1,
      isDefault: false,
      parentId: 'parent-group'
    })

    const feed: FeedRecord = {
      id: 'feed-in-child',
      accountId: 1,
      groupId: 'child-group',
      name: 'Child Feed',
      url: 'https://example.com/rss',
      sourcePageUrl: null,
      sourceType: 'rss',
      icon: null,
      isNotification: false,
      isFullContent: false,
      isBrowser: false,
      dynamicRendering: false,
      createdAt: 100,
      updatedAt: 200
    }
    repository.upsertFeed(feed)

    repository.upsertArticle({
      id: 'art-child-1',
      accountId: 1,
      feedId: 'feed-in-child',
      title: 'Article in Child Group',
      url: 'https://example.com/art-1',
      author: null,
      publishedAt: 500,
      description: '',
      contentHtml: null,
      fullContentHtml: null,
      imageUrl: null,
      isUnread: true,
      isStarred: false,
      createdAt: 100,
      updatedAt: 200
    })

    // Feeds and articles correctly queried
    expect(repository.getFeedById('feed-in-child')?.groupId).toBe('child-group')
    expect(repository.listArticlesByGroup('child-group')).toHaveLength(1)
    expect(repository.listArticlesByFeed('feed-in-child')).toHaveLength(1)
  })

  it('safely deletes entire account data with deep group tree and reading history without violating foreign key restrict, leaving other accounts intact', () => {
    const { repository, accounts } = setupTestEnv()

    // Create Account 2
    const acc2 = accounts.add({
      name: 'Account 2',
      type: 'local'
    })

    // Populate Account 1 with 3-tier hierarchy, feed, article, and reading history
    repository.upsertGroup({
      id: 'acc1-root',
      accountId: 1,
      name: 'Acc1 Root',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'acc1-child',
      accountId: 1,
      name: 'Acc1 Child',
      sortOrder: 1,
      isDefault: false,
      parentId: 'acc1-root'
    })
    repository.upsertGroup({
      id: 'acc1-grandchild',
      accountId: 1,
      name: 'Acc1 Grandchild',
      sortOrder: 1,
      isDefault: false,
      parentId: 'acc1-child'
    })
    repository.upsertFeed({
      id: 'feed-acc1',
      accountId: 1,
      groupId: 'acc1-grandchild',
      name: 'Feed Acc1',
      url: 'https://example.com/rss1',
      sourcePageUrl: null,
      sourceType: 'rss',
      icon: null,
      isNotification: false,
      isFullContent: false,
      isBrowser: false,
      dynamicRendering: false,
      createdAt: 100,
      updatedAt: 100
    })
    repository.upsertArticle({
      id: 'art-acc1',
      accountId: 1,
      feedId: 'feed-acc1',
      title: 'Article Acc1',
      url: 'https://example.com/art-1',
      author: null,
      publishedAt: 100,
      description: '',
      contentHtml: null,
      fullContentHtml: null,
      imageUrl: null,
      isUnread: true,
      isStarred: false,
      createdAt: 100,
      updatedAt: 100
    })
    repository.recordArticleOpened('art-acc1', 1)

    // Populate Account 2 with hierarchy, feed, article, and reading history
    repository.upsertGroup({
      id: 'acc2-root',
      accountId: acc2.id,
      name: 'Acc2 Root',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'acc2-child',
      accountId: acc2.id,
      name: 'Acc2 Child',
      sortOrder: 1,
      isDefault: false,
      parentId: 'acc2-root'
    })
    repository.upsertFeed({
      id: 'feed-acc2',
      accountId: acc2.id,
      groupId: 'acc2-child',
      name: 'Feed Acc2',
      url: 'https://example.com/rss2',
      sourcePageUrl: null,
      sourceType: 'rss',
      icon: null,
      isNotification: false,
      isFullContent: false,
      isBrowser: false,
      dynamicRendering: false,
      createdAt: 200,
      updatedAt: 200
    })
    repository.upsertArticle({
      id: 'art-acc2',
      accountId: acc2.id,
      feedId: 'feed-acc2',
      title: 'Article Acc2',
      url: 'https://example.com/art-2',
      author: null,
      publishedAt: 200,
      description: '',
      contentHtml: null,
      fullContentHtml: null,
      imageUrl: null,
      isUnread: true,
      isStarred: false,
      createdAt: 200,
      updatedAt: 200
    })
    repository.recordArticleOpened('art-acc2', acc2.id)

    // Delete Account 1 data: must not fail on foreign key constraint
    expect(() => repository.deleteAccountData(1)).not.toThrow()

    // Verify Account 1 is completely wiped
    expect(repository.listGroupsForAccount(1)).toEqual([])
    expect(repository.listFeedsForAccount(1)).toEqual([])
    expect(repository.listRecentArticles(10, 1)).toEqual([])

    // Verify Account 2 is completely preserved with its hierarchy intact
    const acc2Groups = repository.listGroupsForAccount(acc2.id)
    expect(acc2Groups.map((g) => g.id)).toContain('acc2-root')
    expect(acc2Groups.map((g) => g.id)).toContain('acc2-child')
    const preservedChild = acc2Groups.find((g) => g.id === 'acc2-child')!
    expect(preservedChild.parentId).toBe('acc2-root')

    const acc2Feeds = repository.listFeedsForAccount(acc2.id)
    expect(acc2Feeds).toHaveLength(1)
    expect(acc2Feeds[0]!.id).toBe('feed-acc2')

    const acc2Recent = repository.listRecentArticles(10, acc2.id)
    expect(acc2Recent).toHaveLength(1)
    expect(acc2Recent[0]!.id).toBe('art-acc2')
  })

  it('preserves groups with children during internal cleanup', () => {
    const { repository } = setupTestEnv()

    repository.upsertGroup({
      id: 'p-group',
      accountId: 1,
      name: 'Parent Group',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'c-group',
      accountId: 1,
      name: 'Child Group',
      sortOrder: 1,
      isDefault: false,
      parentId: 'p-group'
    })
    repository.upsertGroup({
      id: 'gc-group',
      accountId: 1,
      name: 'Grandchild Group',
      sortOrder: 1,
      isDefault: false,
      parentId: 'c-group'
    })

    // Delete c-group
    const deleted = repository.deleteGroupForAccountIfNoStarred(1, 'c-group')
    expect(deleted).toBe(false)

    // c-group is gone
    const groups = repository.listGroupsForAccount(1)
    expect(groups.find((g) => g.id === 'c-group')).toBeDefined()

    // gc-group is promoted to c-group's parent ('p-group'), preserving the child group without loss
    const grandchild = groups.find((g) => g.id === 'gc-group')!
    expect(grandchild).toBeDefined()
    expect(grandchild.parentId).toBe('c-group')

    // Now delete p-group (which is root, parentId: null)
    const pDeleted = repository.deleteGroupForAccountIfNoStarred(1, 'p-group')
    expect(pDeleted).toBe(false)

    // gc-group is promoted to root (parentId: null)
    const reloaded = repository.listGroupsForAccount(1)
    const grandchildAtRoot = reloaded.find((g) => g.id === 'gc-group')!
    expect(grandchildAtRoot).toBeDefined()
    expect(grandchildAtRoot.parentId).toBe('c-group')
  })

  it('prevents transferring a group with children to another account or setting it as default', () => {
    const { repository, accounts } = setupTestEnv()
    const acc2 = accounts.add({ name: 'Acc2', type: 'local' })

    repository.upsertGroup({
      id: 'parent-with-child',
      accountId: 1,
      name: 'Parent With Child',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'the-child',
      accountId: 1,
      name: 'The Child',
      sortOrder: 1,
      isDefault: false,
      parentId: 'parent-with-child'
    })

    // Attempt to transfer parent-with-child to acc2
    expect(() => {
      repository.upsertGroup({
        id: 'parent-with-child',
        accountId: acc2.id,
        name: 'Parent With Child',
        sortOrder: 1,
        isDefault: false,
        parentId: null
      })
    }).toThrow('不能将带有子分组的分组转移到其他账户')

    // Attempt to mark parent-with-child as default group
    expect(() => {
      repository.upsertGroup({
        id: 'parent-with-child',
        accountId: 1,
        name: 'Parent With Child',
        sortOrder: 1,
        isDefault: true,
        parentId: null
      })
    }).toThrow('带有子分组的分组不能设为默认分组')
  })

  it('allows groups with identical names under different parent nodes without global name collision at catalog level', () => {
    const { repository } = setupTestEnv()

    repository.upsertGroup({
      id: 'cat-a',
      accountId: 1,
      name: 'Category A',
      sortOrder: 1,
      isDefault: false,
      parentId: null
    })
    repository.upsertGroup({
      id: 'cat-b',
      accountId: 1,
      name: 'Category B',
      sortOrder: 2,
      isDefault: false,
      parentId: null
    })

    // Subgroup with same name 'General' under Category A and Category B
    expect(() => {
      repository.upsertGroup({
        id: 'sub-a-general',
        accountId: 1,
        name: 'General',
        sortOrder: 1,
        isDefault: false,
        parentId: 'cat-a'
      })
      repository.upsertGroup({
        id: 'sub-b-general',
        accountId: 1,
        name: 'General',
        sortOrder: 1,
        isDefault: false,
        parentId: 'cat-b'
      })
    }).not.toThrow()

    const groups = repository.listGroupsForAccount(1)
    expect(groups.find((g) => g.id === 'sub-a-general')?.name).toBe('General')
    expect(groups.find((g) => g.id === 'sub-b-general')?.name).toBe('General')
  })

  describe('C2b: Group scope article queries and descendant hierarchy', () => {
    it('includes descendants beyond the SQLite parameter chunk size', () => {
      const { database, repository } = setupTestEnv()
      try {
        repository.upsertGroup({ id: 'wide-parent', name: 'Wide', accountId: 1, isDefault: false, sortOrder: 1 })
        const insert = database.connection.prepare('INSERT INTO groups (id, account_id, name, sort_order, is_default, parent_id) VALUES (?, 1, ?, ?, 0, ?)')
        repository.transaction(() => {
          for (let i = 0; i < 805; i++) insert.run(`wide-${i}`, `Wide ${i}`, i + 2, 'wide-parent')
        })
        repository.upsertFeed(createTestFeed('wide-feed', 'wide-804', 'Last child'))
        repository.upsertArticle(createTestArticle({ id: 'wide-article', feedId: 'wide-feed', title: 'Beyond 800', contentHtml: '<p>body</p>' }))
        const summaries = repository.listArticleSummaries({ kind: 'group', id: 'wide-parent' })
        expect(summaries.map(article => article.id)).toEqual(['wide-article'])
        expect(summaries[0]?.contentHtml).toBeNull()
        expect(repository.listArticlesByGroup('wide-parent')[0]?.contentHtml).toBe('<p>body</p>')
      } finally { database.close() }
    })

    function createTestFeed(id: string, groupId: string, name: string, accountId = 1): import('../../shared/library').FeedRecord {
      return {
        id,
        accountId,
        groupId,
        name,
        url: `https://${id}.test/rss`,
        sourcePageUrl: null,
        sourceType: 'rss',
        icon: null,
        isNotification: false,
        isFullContent: false,
        isBrowser: false,
        dynamicRendering: false,
        createdAt: 100,
        updatedAt: 100
      }
    }

    function createTestArticle(attrs: Partial<import('../../shared/library').ArticleRecord> & { id: string; feedId: string; title: string }): import('../../shared/library').ArticleRecord {
      return {
        id: attrs.id,
        accountId: attrs.accountId ?? 1,
        feedId: attrs.feedId,
        title: attrs.title,
        url: attrs.url ?? `https://${attrs.id}.test`,
        author: attrs.author ?? null,
        publishedAt: attrs.publishedAt ?? 100,
        description: attrs.description ?? '',
        contentHtml: attrs.contentHtml ?? null,
        fullContentHtml: attrs.fullContentHtml ?? null,
        imageUrl: attrs.imageUrl ?? null,
        isUnread: attrs.isUnread ?? true,
        isStarred: attrs.isStarred ?? false,
        createdAt: attrs.createdAt ?? 100,
        updatedAt: attrs.updatedAt ?? 100
      }
    }

    it('queries articles for parent group including direct, child, and grandchild descendants while preserving metadata null-body in summaries', () => {
      const { repository } = setupTestEnv()

      // Account 1: parent -> child -> grandchild hierarchy
      repository.upsertGroup({ id: 'parent-group', accountId: 1, name: 'Parent', sortOrder: 1, isDefault: false, parentId: null })
      repository.upsertGroup({ id: 'child-group', accountId: 1, name: 'Child', sortOrder: 2, isDefault: false, parentId: 'parent-group' })
      repository.upsertGroup({ id: 'grandchild-group', accountId: 1, name: 'Grandchild', sortOrder: 3, isDefault: false, parentId: 'child-group' })
      repository.upsertGroup({ id: 'sibling-group', accountId: 1, name: 'Sibling', sortOrder: 4, isDefault: false, parentId: null })
      repository.upsertGroup({ id: 'empty-group', accountId: 1, name: 'Empty', sortOrder: 5, isDefault: false, parentId: 'parent-group' })

      // Feeds
      repository.upsertFeed(createTestFeed('feed-p', 'parent-group', 'Feed Parent'))
      repository.upsertFeed(createTestFeed('feed-c', 'child-group', 'Feed Child'))
      repository.upsertFeed(createTestFeed('feed-gc', 'grandchild-group', 'Feed Grandchild'))
      repository.upsertFeed(createTestFeed('feed-s', 'sibling-group', 'Feed Sibling'))

      // Articles
      for (const a of [
        createTestArticle({
          id: 'art-p',
          feedId: 'feed-p',
          title: 'Article Parent',
          contentHtml: '<p>Content Parent</p>',
          fullContentHtml: '<div>Full Parent</div>',
          isUnread: true,
          isStarred: false,
          publishedAt: 300,
          createdAt: 300,
          updatedAt: 300
        }),
        createTestArticle({
          id: 'art-c',
          feedId: 'feed-c',
          title: 'Article Child',
          contentHtml: '<p>Content Child</p>',
          fullContentHtml: '<div>Full Child</div>',
          isUnread: false,
          isStarred: true,
          publishedAt: 200,
          createdAt: 200,
          updatedAt: 200
        }),
        createTestArticle({
          id: 'art-gc',
          feedId: 'feed-gc',
          title: 'Article Grandchild',
          contentHtml: '<p>Content Grandchild</p>',
          fullContentHtml: '<div>Full Grandchild</div>',
          isUnread: true,
          isStarred: false,
          publishedAt: 100,
          createdAt: 100,
          updatedAt: 100
        }),
        createTestArticle({
          id: 'art-s',
          feedId: 'feed-s',
          title: 'Article Sibling',
          contentHtml: '<p>Content Sibling</p>',
          fullContentHtml: '<div>Full Sibling</div>',
          isUnread: true,
          isStarred: false,
          publishedAt: 400,
          createdAt: 400,
          updatedAt: 400
        })
      ]) {
        repository.upsertArticle(a)
      }

      // 1. listArticleSummaries({ kind: 'group', id: 'parent-group' }) includes parent + child + grandchild
      const summaries = repository.listArticleSummaries({ kind: 'group', id: 'parent-group' })
      expect(summaries.map((a) => a.id)).toEqual(['art-p', 'art-c', 'art-gc'])
      // Check metadata projections: body columns MUST be null
      for (const summary of summaries) {
        expect(summary.contentHtml).toBeNull()
        expect(summary.fullContentHtml).toBeNull()
      }

      // 2. Unread filtering applies across descendants
      const unreadSummaries = repository.listArticleSummaries({ kind: 'group', id: 'parent-group' }, 200, { isUnread: true })
      expect(unreadSummaries.map((a) => a.id)).toEqual(['art-p', 'art-gc'])

      const readSummaries = repository.listArticleSummaries({ kind: 'group', id: 'parent-group' }, 200, { isUnread: false })
      expect(readSummaries.map((a) => a.id)).toEqual(['art-c'])

      // 3. Child group scope includes child + grandchild
      const childSummaries = repository.listArticleSummaries({ kind: 'group', id: 'child-group' })
      expect(childSummaries.map((a) => a.id)).toEqual(['art-c', 'art-gc'])

      // 4. Grandchild leaf scope only includes grandchild
      const grandchildSummaries = repository.listArticleSummaries({ kind: 'group', id: 'grandchild-group' })
      expect(grandchildSummaries.map((a) => a.id)).toEqual(['art-gc'])

      // 5. Empty group returns empty array
      expect(repository.listArticleSummaries({ kind: 'group', id: 'empty-group' })).toEqual([])

      // 6. listArticlesByGroup('parent-group') returns full records with bodies
      const fullArticles = repository.listArticlesByGroup('parent-group')
      expect(fullArticles.map((a) => a.id)).toEqual(['art-p', 'art-c', 'art-gc'])
      expect(fullArticles[0]!.contentHtml).toBe('<p>Content Parent</p>')
      expect(fullArticles[0]!.fullContentHtml).toBe('<div>Full Parent</div>')
      expect(fullArticles[1]!.contentHtml).toBe('<p>Content Child</p>')
      expect(fullArticles[2]!.contentHtml).toBe('<p>Content Grandchild</p>')
    })

    it('enforces strict account isolation for group scope queries', () => {
      const { repository, accounts } = setupTestEnv()
      const acc2 = accounts.add({ name: 'Account 2', type: 'local' })

      // Account 1
      repository.upsertGroup({ id: 'acc1-root', accountId: 1, name: 'Acc1 Root', sortOrder: 1, isDefault: false, parentId: null })
      repository.upsertFeed(createTestFeed('acc1-feed', 'acc1-root', 'Acc1 Feed', 1))
      repository.upsertArticle(
        createTestArticle({
          id: 'acc1-art',
          accountId: 1,
          feedId: 'acc1-feed',
          title: 'Acc1 Art',
          contentHtml: 'Body 1',
          createdAt: 100,
          updatedAt: 100
        })
      )

      // Account 2
      repository.upsertGroup({ id: 'acc2-root', accountId: acc2.id, name: 'Acc2 Root', sortOrder: 1, isDefault: false, parentId: null })
      repository.upsertFeed(createTestFeed('acc2-feed', 'acc2-root', 'Acc2 Feed', acc2.id))
      repository.upsertArticle(
        createTestArticle({
          id: 'acc2-art',
          accountId: acc2.id,
          feedId: 'acc2-feed',
          title: 'Acc2 Art',
          contentHtml: 'Body 2',
          createdAt: 100,
          updatedAt: 100
        })
      )

      // Switch back to account 1 to verify isolation
      accounts.switchTo(1)

      // When account 1 is active:
      // Querying account 2 group ID returns empty (never leaks across accounts)
      expect(repository.listArticleSummaries({ kind: 'group', id: 'acc2-root' })).toEqual([])
      expect(repository.listArticlesByGroup('acc2-root')).toEqual([])

      // Querying account 1 group ID returns only account 1 articles
      expect(repository.listArticleSummaries({ kind: 'group', id: 'acc1-root' }).map((a) => a.id)).toEqual(['acc1-art'])
      expect(repository.listArticlesByGroup('acc1-root').map((a) => a.id)).toEqual(['acc1-art'])

      // Switch to account 2
      accounts.switchTo(acc2.id)
      expect(repository.listArticleSummaries({ kind: 'group', id: 'acc1-root' })).toEqual([])
      expect(repository.listArticleSummaries({ kind: 'group', id: 'acc2-root' }).map((a) => a.id)).toEqual(['acc2-art'])
      expect(repository.listArticlesByGroup('acc2-root').map((a) => a.id)).toEqual(['acc2-art'])
    })

    it('recursively gathers articles through deep nested hierarchy up to max depth', () => {
      const { repository } = setupTestEnv()

      // Build a 5-tier deep tree: g0 -> g1 -> g2 -> g3 -> g4
      let lastParentId: string | null = null
      for (let i = 0; i < 5; i++) {
        const id = `deep-g-${i}`
        repository.upsertGroup({
          id,
          accountId: 1,
          name: `Deep Level ${i}`,
          sortOrder: i,
          isDefault: false,
          parentId: lastParentId
        })
        lastParentId = id
      }

      // Attach feed and article at leaf level (level 4) and root level (level 0)
      repository.upsertFeed(createTestFeed('feed-root', 'deep-g-0', 'Root Feed', 1))
      repository.upsertFeed(createTestFeed('feed-leaf', 'deep-g-4', 'Leaf Feed', 1))
      repository.upsertArticle(
        createTestArticle({
          id: 'art-root',
          accountId: 1,
          feedId: 'feed-root',
          title: 'Root Article',
          contentHtml: 'root',
          createdAt: 200,
          updatedAt: 200
        })
      )
      repository.upsertArticle(
        createTestArticle({
          id: 'art-leaf',
          accountId: 1,
          feedId: 'feed-leaf',
          title: 'Leaf Article',
          contentHtml: 'leaf',
          createdAt: 100,
          updatedAt: 100
        })
      )

      const rootSummaries = repository.listArticleSummaries({ kind: 'group', id: 'deep-g-0' })
      expect(rootSummaries.map((a) => a.id)).toEqual(['art-root', 'art-leaf'])

      const midSummaries = repository.listArticleSummaries({ kind: 'group', id: 'deep-g-2' })
      expect(midSummaries.map((a) => a.id)).toEqual(['art-leaf'])
    })
  })
})
