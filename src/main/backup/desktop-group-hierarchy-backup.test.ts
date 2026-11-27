import { describe, expect, it } from 'vitest'
import {
  escapeGroupSegment,
  unescapeGroupSegment,
  formatEscapedGroupPath,
  buildGroupPathMap,
  validateDesktopGroupHierarchyBackup,
  MAX_BACKUP_GROUP_DEPTH,
  MAX_GROUP_NAME_LENGTH
} from './desktop-group-hierarchy-backup'
import type { BackupGroup, ConfigurationBackup } from '../../shared/configuration-backup'
import type { FeedRecord } from '../../shared/library'
import { createConfigurationBackupFixture } from '../../../tests/helpers/configuration-backup-test-support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('desktop-group-hierarchy-backup', () => {
  describe('Path escaping & unescaping', () => {
    it('escapes and unescapes plain text without modification', () => {
      const name = 'General Tech'
      const escaped = escapeGroupSegment(name)
      expect(escaped).toBe('General Tech')
      expect(unescapeGroupSegment(escaped)).toBe(name)
    })

    it('unambiguously escapes and roundtrips slash and backslash', () => {
      const inputs = [
        'A/B',
        'A\\B',
        'A/B\\C',
        'A\\/B',
        'A\\\\B',
        'A / B / C',
        '///',
        '\\\\\\',
        'Tech / AI \\ ML'
      ]

      for (const input of inputs) {
        const escaped = escapeGroupSegment(input)
        // 校验转义规则：反斜杠先变为 \\，斜杠再变为 \/
        expect(escaped).not.toContain('//')
        expect(unescapeGroupSegment(escaped)).toBe(input)
      }
    })

    it('formats escaped group paths using fixed " / " delimiter', () => {
      expect(formatEscapedGroupPath(['Tech'])).toBe('Tech')
      expect(formatEscapedGroupPath(['News/Daily'])).toBe('News\\/Daily')
      expect(formatEscapedGroupPath(['Tech', 'AI'])).toBe('Tech / AI')
      expect(formatEscapedGroupPath(['Tech/Science', 'AI\\Robotics'])).toBe(
        'Tech\\/Science / AI\\\\Robotics'
      )
    })

    it('builds full escaped path map across tree levels', () => {
      const groups = [
        { id: 'root-1', name: 'Tech', parentId: null },
        { id: 'sub-1', name: 'AI', parentId: 'root-1' },
        { id: 'sub-2', name: 'LLM/GPT', parentId: 'sub-1' },
        { id: 'root-2', name: 'News/Local', parentId: null }
      ]

      const pathMap = buildGroupPathMap(groups)
      expect(pathMap.get('root-1')).toBe('Tech')
      expect(pathMap.get('sub-1')).toBe('Tech / AI')
      expect(pathMap.get('sub-2')).toBe('Tech / AI / LLM\\/GPT')
      expect(pathMap.get('root-2')).toBe('News\\/Local')
    })
  })

  describe('validateDesktopGroupHierarchyBackup', () => {
    const validSubscriptionGroups: BackupGroup[] = [
      { id: 'default-group', name: 'Default', isDefault: true },
      { id: 'g-root', name: 'Tech', isDefault: false },
      { id: 'g-child', name: 'Tech / AI', isDefault: false }
    ]

    const validMetadata = {
      version: 1,
      groups: [
        { id: 'default-group', parentId: null, name: 'Default' },
        { id: 'g-root', parentId: null, name: 'Tech' },
        { id: 'g-child', parentId: 'g-root', name: 'AI' }
      ]
    }

    it('returns null for undefined or null metadata (legacy flat backup compatibility)', () => {
      expect(validateDesktopGroupHierarchyBackup(undefined, validSubscriptionGroups)).toBeNull()
      expect(validateDesktopGroupHierarchyBackup(null, validSubscriptionGroups)).toBeNull()
    })

    it('validates and topological-sorts valid hierarchy (parent-first order contract)', () => {
      const result = validateDesktopGroupHierarchyBackup(validMetadata, validSubscriptionGroups)
      expect(result).not.toBeNull()
      expect(result?.version).toBe(1)
      expect(result?.orderedGroups).toHaveLength(3)

      const orderedIds = result!.orderedGroups.map((g) => g.id)
      // Parent 必须在 Child 之前
      expect(orderedIds.indexOf('g-root')).toBeLessThan(orderedIds.indexOf('g-child'))
      expect(result?.orderedGroups.find((g) => g.id === 'g-child')?.depth).toBe(2)
      expect(result?.orderedGroups.find((g) => g.id === 'g-root')?.depth).toBe(1)
      // 权威名称使用 metadata 原名（而非 subscriptions.groups 的 escaped 路径名）
      expect(result?.groupMap.get('g-child')?.name).toBe('AI')
    })

    it('rejects invalid metadata envelope and unsupported versions', () => {
      expect(() => validateDesktopGroupHierarchyBackup('not-object', validSubscriptionGroups)).toThrow(
        /元数据无效/
      )
      expect(() =>
        validateDesktopGroupHierarchyBackup({ version: 2, groups: [] }, validSubscriptionGroups)
      ).toThrow(/不支持的分组层级元数据版本/)
      expect(() =>
        validateDesktopGroupHierarchyBackup({ version: 1 }, validSubscriptionGroups)
      ).toThrow(/缺少 groups 列表/)
    })

    it('rejects duplicate IDs in metadata', () => {
      const invalid = {
        version: 1,
        groups: [
          { id: 'dup', parentId: null, name: 'Group 1' },
          { id: 'dup', parentId: null, name: 'Group 2' }
        ]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(invalid, [
          { id: 'dup', name: 'Group 1', isDefault: false }
        ])
      ).toThrow(/重复的分组 ID/)
    })

    it('rejects blank names and names exceeding 200 characters', () => {
      const emptyNameMeta = {
        version: 1,
        groups: [{ id: 'g1', parentId: null, name: '   ' }]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(emptyNameMeta, [
          { id: 'g1', name: 'g1', isDefault: false }
        ])
      ).toThrow(/名称不能为空/)

      const tooLongNameMeta = {
        version: 1,
        groups: [{ id: 'g1', parentId: null, name: 'a'.repeat(MAX_GROUP_NAME_LENGTH + 1) }]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(tooLongNameMeta, [
          { id: 'g1', name: 'g1', isDefault: false }
        ])
      ).toThrow(/超过最大长度限制/)
    })

    it('rejects mismatch between metadata IDs and subscription groups (must be exact match)', () => {
      // metadata 缺少一个 group
      const missingInMeta = {
        version: 1,
        groups: [{ id: 'default-group', parentId: null, name: 'Default' }]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(missingInMeta, validSubscriptionGroups)
      ).toThrow(/数量.*不一致/)

      // ID 不匹配
      const idMismatch = {
        version: 1,
        groups: [
          { id: 'default-group', parentId: null, name: 'Default' },
          { id: 'g-root', parentId: null, name: 'Tech' },
          { id: 'unknown-id', parentId: null, name: 'Other' }
        ]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(idMismatch, validSubscriptionGroups)
      ).toThrow(/在订阅分组中不存在/)
    })

    it('rejects default group as child or default group having a parent', () => {
      // 默认分组有父级
      const defaultHasParent = {
        version: 1,
        groups: [
          { id: 'default-group', parentId: 'g-root', name: 'Default' },
          { id: 'g-root', parentId: null, name: 'Tech' }
        ]
      }
      const subs: BackupGroup[] = [
        { id: 'default-group', name: 'Default', isDefault: true },
        { id: 'g-root', name: 'Tech', isDefault: false }
      ]
      expect(() => validateDesktopGroupHierarchyBackup(defaultHasParent, subs)).toThrow(
        /默认分组.*不允许设置父分组/
      )

      // 其它分组以默认分组为父级
      const defaultAsParent = {
        version: 1,
        groups: [
          { id: 'default-group', parentId: null, name: 'Default' },
          { id: 'g-root', parentId: 'default-group', name: 'Tech' }
        ]
      }
      expect(() => validateDesktopGroupHierarchyBackup(defaultAsParent, subs)).toThrow(
        /默认分组.*不允许作为父分组/
      )
    })

    it('rejects orphaned parent references and self-references', () => {
      const selfRef = {
        version: 1,
        groups: [{ id: 'g1', parentId: 'g1', name: 'Self' }]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(selfRef, [{ id: 'g1', name: 'Self', isDefault: false }])
      ).toThrow(/不能将自身设为父分组/)

      const orphan = {
        version: 1,
        groups: [{ id: 'g1', parentId: 'non-existent', name: 'Orphan' }]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(orphan, [{ id: 'g1', name: 'Orphan', isDefault: false }])
      ).toThrow(/引用的父分组.*不存在/)
    })

    it('rejects cycles in group hierarchy', () => {
      const cycle = {
        version: 1,
        groups: [
          { id: 'a', parentId: 'b', name: 'A' },
          { id: 'b', parentId: 'c', name: 'B' },
          { id: 'c', parentId: 'a', name: 'C' }
        ]
      }
      const subs: BackupGroup[] = [
        { id: 'a', name: 'A', isDefault: false },
        { id: 'b', name: 'B', isDefault: false },
        { id: 'c', name: 'C', isDefault: false }
      ]
      expect(() => validateDesktopGroupHierarchyBackup(cycle, subs)).toThrow(
        /检测到分组循环嵌套引用/
      )
    })

    it('enforces maximum tree depth of 32', () => {
      // 构造独立的默认分组与恰好 32 层链
      const groups32: Array<{ id: string; parentId: string | null; name: string }> = [
        { id: 'g-default', parentId: null, name: 'Default' }
      ]
      const subs32: BackupGroup[] = [
        { id: 'g-default', name: 'Default', isDefault: true }
      ]
      for (let i = 1; i <= MAX_BACKUP_GROUP_DEPTH; i++) {
        groups32.push({
          id: `g-${i}`,
          parentId: i === 1 ? null : `g-${i - 1}`,
          name: `Level ${i}`
        })
        subs32.push({ id: `g-${i}`, name: `Level ${i}`, isDefault: false })
      }

      const okResult = validateDesktopGroupHierarchyBackup({ version: 1, groups: groups32 }, subs32)
      expect(okResult).not.toBeNull()
      expect(okResult!.orderedGroups[okResult!.orderedGroups.length - 1]!.depth).toBe(32)

      // 构造 33 层
      groups32.push({
        id: 'g-33',
        parentId: 'g-32',
        name: 'Level 33'
      })
      subs32.push({ id: 'g-33', name: 'Level 33', isDefault: false })
      expect(() =>
        validateDesktopGroupHierarchyBackup({ version: 1, groups: groups32 }, subs32)
      ).toThrow(/分组层级深度超过最大限制/)
    })

    it('rejects sibling duplicate names under same parent, but allows under different parents', () => {
      const siblingDup = {
        version: 1,
        groups: [
          { id: 'p1', parentId: null, name: 'Parent 1' },
          { id: 'c1', parentId: 'p1', name: 'SubGroup' },
          { id: 'c2', parentId: 'p1', name: ' SubGroup ' }
        ]
      }
      const subs: BackupGroup[] = [
        { id: 'p1', name: 'Parent 1', isDefault: false },
        { id: 'c1', name: 'SubGroup', isDefault: false },
        { id: 'c2', name: 'SubGroup', isDefault: false }
      ]
      expect(() => validateDesktopGroupHierarchyBackup(siblingDup, subs)).toThrow(
        /同一层级下存在重复分组名称/
      )

      // 不同 parent 下同名应允许
      const differentParents = {
        version: 1,
        groups: [
          { id: 'p1', parentId: null, name: 'Parent 1' },
          { id: 'p2', parentId: null, name: 'Parent 2' },
          { id: 'c1', parentId: 'p1', name: 'Common' },
          { id: 'c2', parentId: 'p2', name: 'Common' }
        ]
      }
      const subs2: BackupGroup[] = [
        { id: 'p1', name: 'Parent 1', isDefault: false },
        { id: 'p2', name: 'Parent 2', isDefault: false },
        { id: 'c1', name: 'Common', isDefault: false },
        { id: 'c2', name: 'Common', isDefault: false }
      ]
      expect(() => validateDesktopGroupHierarchyBackup(differentParents, subs2)).not.toThrow()
    })

    it('rejects nested hierarchy for remote accounts', () => {
      expect(() =>
        validateDesktopGroupHierarchyBackup(validMetadata, validSubscriptionGroups, {
          isLocalAccount: false
        })
      ).toThrow(/远程账户不支持导入层级分组/)

      // 远程账户允许所有 parentId 为 null 的平面结构
      const flatForRemote = {
        version: 1,
        groups: [
          { id: 'default-group', parentId: null, name: 'Default' },
          { id: 'g-root', parentId: null, name: 'Tech' },
          { id: 'g-child', parentId: null, name: 'AI' }
        ]
      }
      expect(() =>
        validateDesktopGroupHierarchyBackup(flatForRemote, validSubscriptionGroups, {
          isLocalAccount: false
        })
      ).not.toThrow()
    })
  })

  describe('Real ConfigurationBackupService export & inspect integration', () => {
    const dirs: string[] = []
    const createFixture = () => {
      const dir = mkdtempSync(join(tmpdir(), 'origread-c7-test-'))
      dirs.push(dir)
      return createConfigurationBackupFixture(dir)
    }

    it('exports metadata and escaped flat paths for nested groups and inspects cleanly', async () => {
      const fixture = createFixture()
      const defaultGroup = fixture.library.getCurrentDefaultGroup()

      // 添加嵌套分组
      const rootGroup = {
        id: 'group-tech',
        name: 'Tech / IT',
        sortOrder: 2,
        isDefault: false,
        parentId: null
      }
      const childGroup = {
        id: 'group-ai',
        name: 'AI\\ML',
        sortOrder: 3,
        isDefault: false,
        parentId: 'group-tech'
      }
      const grandChildGroup = {
        id: 'group-llm',
        name: 'DeepSeek/GPT',
        sortOrder: 4,
        isDefault: false,
        parentId: 'group-ai'
      }

      fixture.library.upsertGroup(rootGroup)
      fixture.library.upsertGroup(childGroup)
      fixture.library.upsertGroup(grandChildGroup)

      const exportedJson = await fixture.backup.exportBackup('')
      const parsed = JSON.parse(exportedJson)

      // 1. schemaVersion 保持为 1
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.appName).toBe('OrigRead')

      // 2. desktopGroupHierarchy 存在且版本为 1
      expect(parsed.desktopGroupHierarchy).toBeDefined()
      expect(parsed.desktopGroupHierarchy.version).toBe(1)

      const metaGroups: Array<{ id: string; parentId: string | null; name: string }> =
        parsed.desktopGroupHierarchy.groups
      expect(metaGroups).toHaveLength(4) // default + 3 added

      // 校验 metadata 中的真实名称与 parentId
      const metaTech = metaGroups.find((g) => g.id === 'group-tech')
      expect(metaTech).toEqual({ id: 'group-tech', parentId: null, name: 'Tech / IT' })

      const metaAi = metaGroups.find((g) => g.id === 'group-ai')
      expect(metaAi).toEqual({ id: 'group-ai', parentId: 'group-tech', name: 'AI\\ML' })

      const metaLlm = metaGroups.find((g) => g.id === 'group-llm')
      expect(metaLlm).toEqual({ id: 'group-llm', parentId: 'group-ai', name: 'DeepSeek/GPT' })

      // 3. subscriptions.groups 输出无歧义转义的平面完整路径
      const subGroups: Array<{ id: string; name: string; isDefault: boolean }> =
        parsed.subscriptions.groups

      const subTech = subGroups.find((g) => g.id === 'group-tech')
      expect(subTech?.name).toBe('Tech \\/ IT')

      const subAi = subGroups.find((g) => g.id === 'group-ai')
      expect(subAi?.name).toBe('Tech \\/ IT / AI\\\\ML')

      const subLlm = subGroups.find((g) => g.id === 'group-llm')
      expect(subLlm?.name).toBe('Tech \\/ IT / AI\\\\ML / DeepSeek\\/GPT')

      // 4. inspect 可以正常解析并验证导出的内容
      const inspected = fixture.backup.inspect(exportedJson)
      expect(inspected.groups).toBe(4)
      expect(inspected.sourceVersion).toBe('0.1.0')

      // 清理临时文件
      fixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('inspects legacy backup without desktopGroupHierarchy successfully', async () => {
      const fixture = createFixture()
      const exportedJson = await fixture.backup.exportBackup('')
      const parsed = JSON.parse(exportedJson)

      // 模拟旧版 Android 或桌面备份（删除 desktopGroupHierarchy）
      delete parsed.desktopGroupHierarchy
      const legacyJson = JSON.stringify(parsed)

      const inspected = fixture.backup.inspect(legacyJson)
      expect(inspected.groups).toBe(1)

      fixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })
  })

  describe('restoreSubscriptions & Atomic Rollback (C7b)', () => {
    const dirs: string[] = []
    const createFixture = () => {
      const dir = mkdtempSync(join(tmpdir(), 'origread-c7b-test-'))
      dirs.push(dir)
      return createConfigurationBackupFixture(dir)
    }

    const createTestFeed = (overrides: Partial<FeedRecord>): FeedRecord => ({
      id: overrides.id ?? `feed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      groupId: overrides.groupId ?? 'default-group',
      name: overrides.name ?? 'Test Feed',
      url: overrides.url ?? 'https://example.com/feed.xml',
      sourcePageUrl: overrides.sourcePageUrl ?? 'https://example.com',
      sourceType: overrides.sourceType ?? 'rss',
      icon: overrides.icon ?? null,
      isNotification: overrides.isNotification ?? false,
      isFullContent: overrides.isFullContent ?? false,
      isBrowser: overrides.isBrowser ?? false,
      dynamicRendering: overrides.dynamicRendering ?? false,
      createdAt: overrides.createdAt ?? Date.now(),
      updatedAt: overrides.updatedAt ?? Date.now(),
      ...overrides
    })

    it('rejects a custom root name colliding with the destination default before writing groups', async () => {
      const fixture = createFixture()
      try {
        const backup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
        const defaultId = backup.subscriptions.groups.find(group => group.isDefault)!.id
        backup.subscriptions.groups.push({ id: 'custom-default', name: 'Default', isDefault: false })
        backup.desktopGroupHierarchy = { version: 1, groups: [
          { id: defaultId, name: '默认分组', parentId: null },
          { id: 'custom-default', name: 'Default', parentId: null }
        ] }
        const before = fixture.library.listGroups()
        await expect(fixture.backup.restoreBackup(JSON.stringify(backup))).rejects.toThrow('默认分组冲突')
        expect(fixture.library.listGroups()).toEqual(before)
      } finally { fixture.database.close() }
    })

    it('round-trips full tree from local export to clean DB and repeated restore is idempotent', async () => {
      const sourceFixture = createFixture()

      // 构造源数据库中的层级树与订阅 feeds
      sourceFixture.library.upsertGroup({
        id: 'g-tech',
        name: 'Tech / IT',
        sortOrder: 2,
        isDefault: false,
        parentId: null
      })
      sourceFixture.library.upsertGroup({
        id: 'g-ai',
        name: 'AI\\ML',
        sortOrder: 3,
        isDefault: false,
        parentId: 'g-tech'
      })
      sourceFixture.library.upsertGroup({
        id: 'g-llm',
        name: 'DeepSeek/GPT',
        sortOrder: 4,
        isDefault: false,
        parentId: 'g-ai'
      })
      sourceFixture.library.upsertGroup({
        id: 'g-news',
        name: 'News',
        sortOrder: 5,
        isDefault: false,
        parentId: null
      })

      const defaultGroupId = sourceFixture.library.getCurrentDefaultGroup().id
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-default',
          name: 'Default Feed',
          url: 'https://example.com/default.xml',
          groupId: defaultGroupId
        })
      )
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-tech',
          name: 'Tech Feed',
          url: 'https://example.com/tech.xml',
          groupId: 'g-tech'
        })
      )
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-ai',
          name: 'AI Feed',
          url: 'https://example.com/ai.xml',
          groupId: 'g-ai'
        })
      )
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-llm',
          name: 'LLM Feed',
          url: 'https://example.com/llm.xml',
          groupId: 'g-llm'
        })
      )
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-news',
          name: 'News Feed',
          url: 'https://example.com/news.xml',
          groupId: 'g-news'
        })
      )

      const backupContent = await sourceFixture.backup.exportBackup('')

      // 在全新的目标数据库中恢复
      const targetFixture = createFixture()
      const restoreResult1 = await targetFixture.backup.restoreBackup(backupContent)

      expect(restoreResult1.groupsAdded).toBe(4)
      expect(restoreResult1.feedsAdded).toBe(5)
      expect(restoreResult1.feedsUpdated).toBe(1)

      // 验证恢复出来的完整树结构
      const targetGroups = targetFixture.library.listGroups()
      expect(targetGroups).toHaveLength(5) // default + 4

      const restoredDefault = targetGroups.find((g) => g.isDefault)!
      expect(restoredDefault.parentId).toBeNull()

      const restoredTech = targetGroups.find((g) => !g.isDefault && g.name === 'Tech / IT')!
      expect(restoredTech).toBeDefined()
      expect(restoredTech.parentId).toBeNull()

      const restoredAi = targetGroups.find((g) => !g.isDefault && g.name === 'AI\\ML')!
      expect(restoredAi).toBeDefined()
      expect(restoredAi.parentId).toBe(restoredTech.id)

      const restoredLlm = targetGroups.find((g) => !g.isDefault && g.name === 'DeepSeek/GPT')!
      expect(restoredLlm).toBeDefined()
      expect(restoredLlm.parentId).toBe(restoredAi.id)

      const restoredNews = targetGroups.find((g) => !g.isDefault && g.name === 'News')!
      expect(restoredNews).toBeDefined()
      expect(restoredNews.parentId).toBeNull()

      // 验证 feeds 准确映射到了目标树的正确分组 ID（非源备份 ID）
      expect(targetFixture.library.findFeedByUrl('https://example.com/default.xml')?.groupId).toBe(
        restoredDefault.id
      )
      expect(targetFixture.library.findFeedByUrl('https://example.com/tech.xml')?.groupId).toBe(
        restoredTech.id
      )
      expect(targetFixture.library.findFeedByUrl('https://example.com/ai.xml')?.groupId).toBe(
        restoredAi.id
      )
      expect(targetFixture.library.findFeedByUrl('https://example.com/llm.xml')?.groupId).toBe(
        restoredLlm.id
      )
      expect(targetFixture.library.findFeedByUrl('https://example.com/news.xml')?.groupId).toBe(
        restoredNews.id
      )

      // 重复 restore 幂等性验证
      const restoreResult2 = await targetFixture.backup.restoreBackup(backupContent)
      expect(restoreResult2.groupsAdded).toBe(0)
      expect(restoreResult2.feedsAdded).toBe(0)
      expect(restoreResult2.feedsUpdated).toBe(6)

      const afterGroups = targetFixture.library.listGroups()
      expect(afterGroups).toHaveLength(5)
      expect(afterGroups.map((g) => g.id).sort()).toEqual(targetGroups.map((g) => g.id).sort())

      sourceFixture.database.close()
      targetFixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('restores flattened root groups when metadata is stripped (legacy downgrade)', async () => {
      const sourceFixture = createFixture()
      sourceFixture.library.upsertGroup({
        id: 'g-tech',
        name: 'Tech / IT',
        sortOrder: 2,
        isDefault: false,
        parentId: null
      })
      sourceFixture.library.upsertGroup({
        id: 'g-ai',
        name: 'AI\\ML',
        sortOrder: 3,
        isDefault: false,
        parentId: 'g-tech'
      })
      sourceFixture.library.upsertGroup({
        id: 'g-news',
        name: 'News',
        sortOrder: 4,
        isDefault: false,
        parentId: null
      })
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-ai',
          name: 'AI Feed',
          url: 'https://example.com/ai.xml',
          groupId: 'g-ai'
        })
      )

      const exported = JSON.parse(await sourceFixture.backup.exportBackup('')) as ConfigurationBackup
      // 模拟移除 metadata 降级为旧版平铺备份
      delete (exported as { desktopGroupHierarchy?: unknown }).desktopGroupHierarchy
      const flatBackupContent = JSON.stringify(exported)

      const targetFixture = createFixture()
      const result = await targetFixture.backup.restoreBackup(flatBackupContent)

      expect(result.groupsAdded).toBe(3)
      expect(result.feedsAdded).toBe(1)

      const groups = targetFixture.library.listGroups()
      expect(groups).toHaveLength(4) // default + 3

      // 所有恢复的分组 parentId 均必须为 null (纯根分组)
      for (const group of groups) {
        expect(group.parentId).toBeNull()
      }

      // 名称为平铺转义路径
      const groupNames = groups.map((g) => g.name)
      expect(groupNames).toContain('Tech \\/ IT')
      expect(groupNames).toContain('Tech \\/ IT / AI\\\\ML')
      expect(groupNames).toContain('News')

      // Feed 正确指向对应的平铺根分组
      const aiFlatGroup = groups.find((g) => g.name === 'Tech \\/ IT / AI\\\\ML')!
      expect(targetFixture.library.findFeedByUrl('https://example.com/ai.xml')?.groupId).toBe(
        aiFlatGroup.id
      )

      sourceFixture.database.close()
      targetFixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('legacy flat backup without metadata matches only root groups and does not steal child leaf groups', async () => {
      const fixture = createFixture()

      // 现有数据库中存在父分组 A 与子分组 B，但不存在根分组 B
      fixture.library.upsertGroup({
        id: 'g-parent-a',
        name: 'ParentA',
        sortOrder: 2,
        isDefault: false,
        parentId: null
      })
      fixture.library.upsertGroup({
        id: 'g-child-b',
        name: 'TargetLeaf',
        sortOrder: 3,
        isDefault: false,
        parentId: 'g-parent-a'
      })

      // 旧版平铺备份中有一个同名为 'TargetLeaf' 的平铺根分组
      const legacyBackup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
      delete (legacyBackup as { desktopGroupHierarchy?: unknown }).desktopGroupHierarchy
      legacyBackup.subscriptions.groups = [
        { id: 'default-id', name: 'Default', isDefault: true },
        { id: 'legacy-leaf-id', name: 'TargetLeaf', isDefault: false }
      ]
      legacyBackup.subscriptions.feeds = [
        createTestFeed({
          id: 'legacy-feed',
          name: 'Leaf Sub',
          url: 'https://example.com/leaf-feed.xml',
          groupId: 'legacy-leaf-id'
        }) as unknown as ConfigurationBackup['subscriptions']['feeds'][number]
      ]

      const result = await fixture.backup.restoreBackup(JSON.stringify(legacyBackup))
      // 必须新建一个根分组 TargetLeaf，而不能误匹配到 ParentA 下的子分组 TargetLeaf
      expect(result.groupsAdded).toBe(1)
      expect(result.feedsAdded).toBe(1)

      const groups = fixture.library.listGroups()
      const targetLeafGroups = groups.filter((g) => g.name === 'TargetLeaf')
      expect(targetLeafGroups).toHaveLength(2)

      const childLeaf = targetLeafGroups.find((g) => g.parentId === 'g-parent-a')!
      const rootLeaf = targetLeafGroups.find((g) => g.parentId === null)!
      expect(childLeaf).toBeDefined()
      expect(rootLeaf).toBeDefined()

      // 订阅源必须进入根分组 rootLeaf，绝不能落入 childLeaf
      expect(fixture.library.findFeedByUrl('https://example.com/leaf-feed.xml')?.groupId).toBe(
        rootLeaf.id
      )

      fixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('distinguishes root group and child group with the same name across tree levels', async () => {
      const sourceFixture = createFixture()
      sourceFixture.library.upsertGroup({
        id: 'g-category',
        name: 'Category',
        sortOrder: 2,
        isDefault: false,
        parentId: null
      })
      sourceFixture.library.upsertGroup({
        id: 'g-root-b',
        name: 'SharedItem',
        sortOrder: 3,
        isDefault: false,
        parentId: null
      })
      sourceFixture.library.upsertGroup({
        id: 'g-child-b',
        name: 'SharedItem',
        sortOrder: 4,
        isDefault: false,
        parentId: 'g-category'
      })
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-root',
          name: 'Feed Root',
          url: 'https://example.com/root.xml',
          groupId: 'g-root-b'
        })
      )
      sourceFixture.library.upsertFeed(
        createTestFeed({
          id: 'f-child',
          name: 'Feed Child',
          url: 'https://example.com/child.xml',
          groupId: 'g-child-b'
        })
      )

      const backupContent = await sourceFixture.backup.exportBackup('')

      const targetFixture = createFixture()
      const result1 = await targetFixture.backup.restoreBackup(backupContent)
      expect(result1.groupsAdded).toBe(3)
      expect(result1.feedsAdded).toBe(2)
      expect(result1.feedsUpdated).toBe(1)

      const targetGroups = targetFixture.library.listGroups()
      const catGroup = targetGroups.find((g) => g.name === 'Category')!
      const rootItem = targetGroups.find((g) => g.name === 'SharedItem' && g.parentId === null)!
      const childItem = targetGroups.find(
        (g) => g.name === 'SharedItem' && g.parentId === catGroup.id
      )!

      expect(rootItem).toBeDefined()
      expect(childItem).toBeDefined()
      expect(rootItem.id).not.toBe(childItem.id)

      expect(targetFixture.library.findFeedByUrl('https://example.com/root.xml')?.groupId).toBe(
        rootItem.id
      )
      expect(targetFixture.library.findFeedByUrl('https://example.com/child.xml')?.groupId).toBe(
        childItem.id
      )

      // 重复恢复保持完全幂等
      const result2 = await targetFixture.backup.restoreBackup(backupContent)
      expect(result2.groupsAdded).toBe(0)
      expect(result2.feedsAdded).toBe(0)
      expect(result2.feedsUpdated).toBe(3)

      sourceFixture.database.close()
      targetFixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('rejects invalid metadata atomically before any database, preference, or secret mutations', async () => {
      const fixture = createFixture()
      fixture.settings.update({ readerFontSize: 16, theme: 'light' })
      const initialGroups = fixture.library.listGroups()
      const initialFeeds = fixture.library.listFeeds()

      const baseBackup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
      baseBackup.preferences = {
        'origread.desktop.readerFontSize': 32,
        'origread.desktop.theme': 'dark'
      }
      baseBackup.subscriptions.groups.push(
        { id: 'g1', name: 'Group1', isDefault: false },
        { id: 'g2', name: 'Group2', isDefault: false }
      )
      // 构造循环引用的 invalid metadata
      baseBackup.desktopGroupHierarchy = {
        version: 1,
        groups: [
          { id: initialGroups[0]!.id, parentId: null, name: 'Default' },
          { id: 'g1', parentId: 'g2', name: 'Group1' },
          { id: 'g2', parentId: 'g1', name: 'Group2' }
        ]
      }

      await expect(fixture.backup.restoreBackup(JSON.stringify(baseBackup))).rejects.toThrow(
        /循环嵌套引用/
      )

      // 验证原子性：完全未发生任何写入或偏好修改
      expect(fixture.settings.current().readerFontSize).toBe(16)
      expect(fixture.settings.current().theme).toBe('light')
      expect(fixture.library.listGroups()).toEqual(initialGroups)
      expect(fixture.library.listFeeds()).toEqual(initialFeeds)

      fixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })

    it('restoring backup in current account does not affect other accounts in same DB', async () => {
      const fixture = createFixture()

      // 在同一 SQLite 数据库中预置 account 2 的私自分组与订阅
      fixture.database.connection.exec(`
        INSERT INTO accounts (id, name, type, created_at) VALUES (2, 'OtherAccount', 'local', 1000);
        INSERT INTO groups (id, account_id, name, sort_order, is_default, parent_id)
        VALUES ('other-g1', 2, 'OtherPrivateGroup', 1, 0, NULL);
        INSERT INTO feeds (id, account_id, group_id, name, url, source_page_url, source_type, created_at, updated_at)
        VALUES ('other-f1', 2, 'other-g1', 'OtherFeed', 'https://other.example/feed.xml', 'https://other.example', 'rss', 1000, 1000);
      `)

      // 在当前账户 (account 1) 恢复备份
      const backup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
      backup.subscriptions.groups.push({ id: 'acc1-tech', name: 'Acc1Tech', isDefault: false })
      backup.subscriptions.feeds.push(
        createTestFeed({
          id: 'acc1-f1',
          name: 'Acc1Feed',
          url: 'https://acc1.example/feed.xml',
          groupId: 'acc1-tech'
        }) as unknown as ConfigurationBackup['subscriptions']['feeds'][number]
      )
      backup.desktopGroupHierarchy = {
        version: 1,
        groups: [
          { id: backup.subscriptions.groups[0]!.id, parentId: null, name: 'Default' },
          { id: 'acc1-tech', parentId: null, name: 'Acc1Tech' }
        ]
      }

      const result = await fixture.backup.restoreBackup(JSON.stringify(backup))
      expect(result.groupsAdded).toBe(1)
      expect(result.feedsAdded).toBe(1)

      // 校验 account 2 的分组与订阅完全未被篡改
      const otherGroups = fixture.database.connection
        .prepare('SELECT id, account_id, name FROM groups WHERE account_id = 2')
        .all() as Array<{ id: string; account_id: number; name: string }>
      expect(otherGroups).toEqual([
        { id: 'other-g1', account_id: 2, name: 'OtherPrivateGroup' }
      ])

      const otherFeeds = fixture.database.connection
        .prepare('SELECT id, account_id, name, url FROM feeds WHERE account_id = 2')
        .all() as Array<{ id: string; account_id: number; name: string; url: string }>
      expect(otherFeeds).toEqual([
        {
          id: 'other-f1',
          account_id: 2,
          name: 'OtherFeed',
          url: 'https://other.example/feed.xml'
        }
      ])

      fixture.database.close()
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    })
  })
})
