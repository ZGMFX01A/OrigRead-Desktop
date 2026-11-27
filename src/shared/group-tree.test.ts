import { describe, expect, it } from 'vitest'
import type { GroupRecord } from './library'
import {
  buildGroupTree,
  getGroupDescendantIds,
  getGroupPath,
  getGroupPathSegments,
  validateGroupParent,
  findSiblingGroupByName,
  checkSiblingNameConflict,
  assertNoSiblingNameConflict,
  validateGroupHierarchy,
  MAX_GROUP_TREE_DEPTH
} from './group-tree'

describe('group-tree pure functions', () => {
  const sampleGroups: GroupRecord[] = [
    { id: 'root-1', accountId: 1, name: 'Root 1', sortOrder: 0, isDefault: true, parentId: null },
    { id: 'tech', accountId: 1, name: 'Tech/Dev', sortOrder: 1, isDefault: false, parentId: null },
    { id: 'frontend', accountId: 1, name: 'Frontend', sortOrder: 0, isDefault: false, parentId: 'tech' },
    { id: 'backend', accountId: 1, name: 'Backend', sortOrder: 1, isDefault: false, parentId: 'tech' },
    { id: 'react', accountId: 1, name: 'React', sortOrder: 0, isDefault: false, parentId: 'frontend' },
    { id: 'vue', accountId: 1, name: 'Vue', sortOrder: 1, isDefault: false, parentId: 'frontend' },
    { id: 'news', accountId: 1, name: 'News', sortOrder: 2, isDefault: false, parentId: null },
    { id: 'daily', accountId: 1, name: 'Daily/Weekly', sortOrder: 0, isDefault: false, parentId: 'news' }
  ]

  describe('getGroupDescendantIds', () => {
    it('returns all descendant IDs in breadth-first order and deduplicated', () => {
      const techDescendants = getGroupDescendantIds('tech', sampleGroups)
      expect(techDescendants).toEqual(['frontend', 'backend', 'react', 'vue'])

      const frontendDescendants = getGroupDescendantIds('frontend', sampleGroups)
      expect(frontendDescendants).toEqual(['react', 'vue'])

      const leafDescendants = getGroupDescendantIds('react', sampleGroups)
      expect(leafDescendants).toEqual([])
    })

    it('detects cycles and throws error', () => {
      const cyclicGroups: GroupRecord[] = [
        { id: 'a', accountId: 1, name: 'A', sortOrder: 0, isDefault: false, parentId: 'c' },
        { id: 'b', accountId: 1, name: 'B', sortOrder: 0, isDefault: false, parentId: 'a' },
        { id: 'c', accountId: 1, name: 'C', sortOrder: 0, isDefault: false, parentId: 'b' }
      ]
      expect(() => getGroupDescendantIds('a', cyclicGroups)).toThrow('检测到分组循环嵌套引用')
    })

    it('enforces maximum depth limit', () => {
      const deepGroups: GroupRecord[] = []
      for (let i = 0; i < 40; i++) {
        deepGroups.push({
          id: `g-${i}`,
          accountId: 1,
          name: `Group ${i}`,
          sortOrder: 0,
          isDefault: false,
          parentId: i === 0 ? null : `g-${i - 1}`
        })
      }
      expect(() => getGroupDescendantIds('g-0', deepGroups, { maxDepth: 10 })).toThrow('分组层级深度超过最大限制')
    })

    it('allows legal boundary where descendant depth equals maxDepth exactly', () => {
      // g-0 (layer 1) -> g-1 (layer 2) -> g-2 (layer 3)
      const chain: GroupRecord[] = [
        { id: 'g-0', accountId: 1, name: 'Root', sortOrder: 0, isDefault: true, parentId: null },
        { id: 'g-1', accountId: 1, name: 'Child', sortOrder: 0, isDefault: false, parentId: 'g-0' },
        { id: 'g-2', accountId: 1, name: 'Grandchild', sortOrder: 0, isDefault: false, parentId: 'g-1' }
      ]
      // Three layers include the root.
      expect(getGroupDescendantIds('g-0', chain, { maxDepth: 3 })).toEqual(['g-1', 'g-2'])
      // Two layers reject the third layer.
      expect(() => getGroupDescendantIds('g-0', chain, { maxDepth: 2 })).toThrow('分组层级深度超过最大限制')
    })
  })

  describe('getGroupPath & getGroupPathSegments', () => {
    it('returns full path from root to current group', () => {
      const path = getGroupPath('react', sampleGroups)
      expect(path.map((g) => g.id)).toEqual(['tech', 'frontend', 'react'])
    })

    it('retains literal slashes in group names without splitting', () => {
      const segments = getGroupPathSegments('daily', sampleGroups)
      expect(segments).toEqual(['News', 'Daily/Weekly'])
      expect(segments[1]).toBe('Daily/Weekly')

      const techSegments = getGroupPathSegments('react', sampleGroups)
      expect(techSegments).toEqual(['Tech/Dev', 'Frontend', 'React'])
      expect(techSegments[0]).toBe('Tech/Dev')
    })

    it('handles root groups and non-existent groups safely', () => {
      expect(getGroupPathSegments('tech', sampleGroups)).toEqual(['Tech/Dev'])
      expect(getGroupPathSegments('non-existent', sampleGroups)).toEqual([])
    })

    it('handles legacy orphan groups safely by stopping at current group', () => {
      const orphanGroups: GroupRecord[] = [
        { id: 'orphan', accountId: 1, name: 'Orphan', sortOrder: 0, isDefault: false, parentId: 'missing-parent' }
      ]
      expect(getGroupPathSegments('orphan', orphanGroups)).toEqual(['Orphan'])
    })

    it('detects cycles during path traversal and throws', () => {
      const cyclicGroups: GroupRecord[] = [
        { id: 'a', accountId: 1, name: 'A', sortOrder: 0, isDefault: false, parentId: 'b' },
        { id: 'b', accountId: 1, name: 'B', sortOrder: 0, isDefault: false, parentId: 'a' }
      ]
      expect(() => getGroupPath('a', cyclicGroups)).toThrow('检测到分组循环嵌套引用')
    })
  })

  describe('buildGroupTree', () => {
    it('builds a tree structure with proper sorting and depth', () => {
      const tree = buildGroupTree(sampleGroups)

      // Top level should be root-1, tech, news (sorted by sortOrder)
      expect(tree.map((node) => node.id)).toEqual(['root-1', 'tech', 'news'])
      expect(tree[0]!.depth).toBe(0)

      const techNode = tree.find((node) => node.id === 'tech')!
      expect(techNode.children.map((c) => c.id)).toEqual(['frontend', 'backend'])
      expect(techNode.children[0]!.depth).toBe(1)
      expect(techNode.children[0]!.children.map((c) => c.id)).toEqual(['react', 'vue'])
      expect(techNode.children[0]!.children[0]!.depth).toBe(2)
    })

    it('safely presents legacy orphan groups as root groups', () => {
      const groupsWithOrphan: GroupRecord[] = [
        { id: 'root', accountId: 1, name: 'Root', sortOrder: 0, isDefault: true, parentId: null },
        { id: 'orphan-1', accountId: 1, name: 'Orphan 1', sortOrder: 1, isDefault: false, parentId: 'lost-parent' }
      ]
      const tree = buildGroupTree(groupsWithOrphan)
      expect(tree.map((n) => n.id)).toEqual(['root', 'orphan-1'])
      expect(tree[1]!.depth).toBe(0)
    })

    it('safely handles circular structures without hanging or infinite loops', () => {
      const cyclicGroups: GroupRecord[] = [
        { id: 'x', accountId: 1, name: 'X', sortOrder: 0, isDefault: false, parentId: 'y' },
        { id: 'y', accountId: 1, name: 'Y', sortOrder: 0, isDefault: false, parentId: 'x' }
      ]
      const tree = buildGroupTree(cyclicGroups)
      expect(tree.length).toBeGreaterThan(0)
    })

    it('does not duplicate render truncated deep nodes as roots', () => {
      // Root(0) -> Child(1) -> Grandchild(2) -> GreatGrandchild(3)
      const fourLevelChain: GroupRecord[] = [
        { id: 'lvl-0', accountId: 1, name: 'Lvl 0', sortOrder: 0, isDefault: false, parentId: null },
        { id: 'lvl-1', accountId: 1, name: 'Lvl 1', sortOrder: 0, isDefault: false, parentId: 'lvl-0' },
        { id: 'lvl-2', accountId: 1, name: 'Lvl 2', sortOrder: 0, isDefault: false, parentId: 'lvl-1' },
        { id: 'lvl-3', accountId: 1, name: 'Lvl 3', sortOrder: 0, isDefault: false, parentId: 'lvl-2' }
      ]
      // maxDepth = 2: Only lvl-0 and lvl-1 can be rendered. lvl-2 and lvl-3 must NOT appear as root!
      const tree = buildGroupTree(fourLevelChain, { maxDepth: 2 })
      expect(tree).toHaveLength(1)
      expect(tree[0]!.id).toBe('lvl-0')
      expect(tree[0]!.children).toHaveLength(1)
      expect(tree[0]!.children[0]!.id).toBe('lvl-1')
      // lvl-1 children truncated
      expect(tree[0]!.children[0]!.children).toHaveLength(0)
      // lvl-2 and lvl-3 are completely absent, never duplicated into roots!
      const rootIds = tree.map((t) => t.id)
      expect(rootIds).not.toContain('lvl-2')
      expect(rootIds).not.toContain('lvl-3')
    })

    it('explicitly rejects invalid trees when throwOnInvalid option is true', () => {
      const cyclicGroups: GroupRecord[] = [
        { id: 'x', accountId: 1, name: 'X', sortOrder: 0, isDefault: false, parentId: 'y' },
        { id: 'y', accountId: 1, name: 'Y', sortOrder: 0, isDefault: false, parentId: 'x' }
      ]
      expect(() => buildGroupTree(cyclicGroups, { throwOnInvalid: true })).toThrow('检测到无效的分组树结构或循环嵌套引用')
    })
  })

  describe('validateGroupParent', () => {
    it('allows valid local parent relationship', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'new-sub',
          parentId: 'tech',
          allGroups: sampleGroups,
          isLocalAccount: true,
          accountId: 1
        })
      ).not.toThrow()

      // Root level (null or undefined parent) is always allowed
      expect(() =>
        validateGroupParent({
          groupId: 'new-root',
          parentId: null,
          allGroups: sampleGroups,
          isLocalAccount: true,
          accountId: 1
        })
      ).not.toThrow()
    })

    it('rejects remote accounts with non-null parentId', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'remote-child',
          parentId: 'tech',
          allGroups: sampleGroups,
          isLocalAccount: false,
          accountId: 2
        })
      ).toThrow('远程账户分组不支持层级结构')

      // Remote accounts with null parentId are fine
      expect(() =>
        validateGroupParent({
          groupId: 'remote-root',
          parentId: null,
          allGroups: sampleGroups,
          isLocalAccount: false,
          accountId: 2
        })
      ).not.toThrow()
    })

    it('rejects setting parent on default group', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'root-1',
          parentId: 'tech',
          allGroups: sampleGroups,
          isDefault: true,
          accountId: 1
        })
      ).toThrow('默认分组不允许设置父分组')
    })

    it('rejects setting default group as parent', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'child',
          parentId: 'root-1', // root-1 is default
          allGroups: sampleGroups,
          accountId: 1
        })
      ).toThrow('默认分组不允许作为父分组')
    })

    it('rejects setting self as parent', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'tech',
          parentId: 'tech',
          allGroups: sampleGroups,
          accountId: 1
        })
      ).toThrow('分组不能将自身设为父分组')
    })

    it('rejects non-existent parent (rejects orphan)', () => {
      expect(() =>
        validateGroupParent({
          groupId: 'child',
          parentId: 'missing-parent-id',
          allGroups: sampleGroups,
          accountId: 1
        })
      ).toThrow('指定的父分组不存在')
    })

    it('rejects cross-account parent', () => {
      const groupsWithMultiAccounts: GroupRecord[] = [
        ...sampleGroups,
        { id: 'acc2-group', accountId: 2, name: 'Acc2 Group', sortOrder: 0, isDefault: false, parentId: null }
      ]
      expect(() =>
        validateGroupParent({
          groupId: 'child-acc1',
          parentId: 'acc2-group',
          allGroups: groupsWithMultiAccounts,
          accountId: 1
        })
      ).toThrow('父分组必须属于同一账户')
    })

    it('rejects circular nesting when moving ancestor under its descendant', () => {
      // Tech is ancestor of React. Moving Tech under React must fail.
      expect(() =>
        validateGroupParent({
          groupId: 'tech',
          parentId: 'react',
          allGroups: sampleGroups,
          accountId: 1
        })
      ).toThrow('检测到分组循环嵌套引用')

      // Frontend is parent of React. Moving Frontend under React must fail.
      expect(() =>
        validateGroupParent({
          groupId: 'frontend',
          parentId: 'react',
          allGroups: sampleGroups,
          accountId: 1
        })
      ).toThrow('检测到分组循环嵌套引用')
    })

    it('rejects depth exceeding maximum limit', () => {
      const deepGroups: GroupRecord[] = []
      for (let i = 0; i <= MAX_GROUP_TREE_DEPTH + 2; i++) {
        deepGroups.push({
          id: `node-${i}`,
          accountId: 1,
          name: `Node ${i}`,
          sortOrder: 0,
          isDefault: false,
          parentId: i === 0 ? null : `node-${i - 1}`
        })
      }
      expect(() =>
        validateGroupParent({
          groupId: 'new-deep',
          parentId: `node-${MAX_GROUP_TREE_DEPTH + 1}`,
          allGroups: deepGroups,
          accountId: 1
        })
      ).toThrow('分组层级深度超过最大限制')
    })

    it('rejects moving a subtree when new parent depth + subtree height exceeds 32', () => {
      // Build a parent chain of 30 levels: p-1 (root, depth 1) -> ... -> p-30 (depth 30)
      const chain: GroupRecord[] = []
      for (let i = 1; i <= 30; i++) {
        chain.push({
          id: `p-${i}`,
          accountId: 1,
          name: `P ${i}`,
          sortOrder: 0,
          isDefault: i === 1,
          parentId: i === 1 ? null : `p-${i - 1}`
        })
      }

      // Subtree rooted at target-sub: target-sub -> sub-child -> sub-grandchild (subtree height = 3)
      const subtree: GroupRecord[] = [
        { id: 'target-sub', accountId: 1, name: 'Target Sub', sortOrder: 0, isDefault: false, parentId: null },
        { id: 'sub-child', accountId: 1, name: 'Sub Child', sortOrder: 0, isDefault: false, parentId: 'target-sub' },
        { id: 'sub-grandchild', accountId: 1, name: 'Sub Grandchild', sortOrder: 0, isDefault: false, parentId: 'sub-child' }
      ]
      const allGroups = [...chain, ...subtree]

      // Moving target-sub under p-30: parent depth is 30, subtree height is 3 -> total depth 30 + 3 = 33 > 32!
      expect(() =>
        validateGroupParent({
          groupId: 'target-sub',
          parentId: 'p-30',
          allGroups,
          accountId: 1
        })
      ).toThrow('分组层级深度超过最大限制')

      // Moving target-sub under p-29: parent depth is 29, subtree height is 3 -> total depth 29 + 3 = 32 <= 32!
      expect(() =>
        validateGroupParent({
          groupId: 'target-sub',
          parentId: 'p-29',
          allGroups,
          accountId: 1
        })
      ).not.toThrow()
    })

    it('validates target subtree height and cycle detection when moving to root', () => {
      // A tree with 33 levels moving to root (parentId: null) must fail
      const tallSubtree: GroupRecord[] = []
      for (let i = 1; i <= 33; i++) {
        tallSubtree.push({
          id: `tall-${i}`,
          accountId: 1,
          name: `Tall ${i}`,
          sortOrder: 0,
          isDefault: false,
          parentId: i === 1 ? 'old-parent' : `tall-${i - 1}`
        })
      }
      expect(() =>
        validateGroupParent({
          groupId: 'tall-1',
          parentId: null,
          allGroups: tallSubtree,
          accountId: 1
        })
      ).toThrow('分组层级深度超过最大限制')

      // A subtree with internal cycle moving to root must fail
      const cyclicSubtree: GroupRecord[] = [
        { id: 'sub-root', accountId: 1, name: 'Sub Root', sortOrder: 0, isDefault: false, parentId: 'sub-b' },
        { id: 'sub-a', accountId: 1, name: 'Sub A', sortOrder: 0, isDefault: false, parentId: 'sub-root' },
        { id: 'sub-b', accountId: 1, name: 'Sub B', sortOrder: 0, isDefault: false, parentId: 'sub-a' }
      ]
      expect(() =>
        validateGroupParent({
          groupId: 'sub-root',
          parentId: null,
          allGroups: cyclicSubtree,
          accountId: 1
        })
      ).toThrow('检测到分组循环嵌套引用')
    })
  })

  describe('sibling name conflict helper', () => {
    it('rejects same name under the same parent', () => {
      expect(checkSiblingNameConflict(sampleGroups, 'Frontend', 'tech')).toBe(true)
      expect(checkSiblingNameConflict(sampleGroups, '  Frontend  ', 'tech')).toBe(true)
      expect(() => assertNoSiblingNameConflict(sampleGroups, 'Frontend', 'tech')).toThrow('同一层级下已存在同名分组')
    })

    it('allows same name under different parents', () => {
      // Under 'news', there is no 'Frontend'
      expect(checkSiblingNameConflict(sampleGroups, 'Frontend', 'news')).toBe(false)
      expect(() => assertNoSiblingNameConflict(sampleGroups, 'Frontend', 'news')).not.toThrow()

      // At root level (parentId: null), there is no 'Frontend'
      expect(checkSiblingNameConflict(sampleGroups, 'Frontend', null)).toBe(false)
    })

    it('ignores self during renaming when excludeGroupId is passed', () => {
      expect(checkSiblingNameConflict(sampleGroups, 'Frontend', 'tech', 'frontend')).toBe(false)
    })
  })

  describe('validateGroupHierarchy', () => {
    it('validates a complete tree hierarchy', () => {
      expect(() => validateGroupHierarchy(sampleGroups, { isLocalAccount: true, accountId: 1 })).not.toThrow()
    })

    it('rejects duplicate sibling names across hierarchy', () => {
      const duplicateSiblings: GroupRecord[] = [
        ...sampleGroups,
        { id: 'frontend-duplicate', accountId: 1, name: 'Frontend', sortOrder: 9, isDefault: false, parentId: 'tech' }
      ]
      expect(() => validateGroupHierarchy(duplicateSiblings, { isLocalAccount: true, accountId: 1 })).toThrow(
        '同一层级下存在重复分组名称'
      )
    })

    it('rejects duplicate group ids', () => {
      const duplicateIds: GroupRecord[] = [
        { id: 'same-id', accountId: 1, name: 'Group 1', sortOrder: 0, isDefault: false, parentId: null },
        { id: 'same-id', accountId: 1, name: 'Group 2', sortOrder: 1, isDefault: false, parentId: null }
      ]
      expect(() => validateGroupHierarchy(duplicateIds, { isLocalAccount: true, accountId: 1 })).toThrow(
        '存在重复的分组 ID: same-id'
      )
    })

    it('avoids key collision between ROOT as parentId and null root using nested Map', () => {
      // Group A has parentId: null, name: "Special"
      // Group B has parentId: "ROOT", name: "Special"
      // In string concatenation `${pid}::${name}`, both would be "ROOT::Special" and incorrectly conflict!
      // With nested Map, they are in different parent buckets (null vs "ROOT"), so no conflict.
      const groupsWithRootNamedParent: GroupRecord[] = [
        { id: 'ROOT', accountId: 1, name: 'Root Category', sortOrder: 0, isDefault: false, parentId: null },
        { id: 'child-under-root-named', accountId: 1, name: 'Special', sortOrder: 1, isDefault: false, parentId: 'ROOT' },
        { id: 'group-at-null-root', accountId: 1, name: 'Special', sortOrder: 2, isDefault: false, parentId: null }
      ]
      expect(() =>
        validateGroupHierarchy(groupsWithRootNamedParent, { isLocalAccount: true, accountId: 1 })
      ).not.toThrow()
    })

    it('rejects root groups that do not belong to the specified accountId', () => {
      const mixedAccountRoots: GroupRecord[] = [
        { id: 'root-acc-1', accountId: 1, name: 'Acc 1 Root', sortOrder: 0, isDefault: false, parentId: null },
        { id: 'root-acc-2', accountId: 2, name: 'Acc 2 Root', sortOrder: 1, isDefault: false, parentId: null }
      ]
      expect(() =>
        validateGroupHierarchy(mixedAccountRoots, { isLocalAccount: true, accountId: 1 })
      ).toThrow('分组 root-acc-2 不属于指定账户 1')
    })
  })
})


it('counts the descendant root as layer one at the 32 layer boundary', () => {
  const groups = Array.from({length:33}, (_, i) => ({id:`depth-${i}`,name:`Depth ${i}`,parentId:i ? `depth-${i-1}` : null,sortOrder:i,isDefault:false}))
  expect(getGroupDescendantIds('depth-0', groups.slice(0,32))).toHaveLength(31)
  expect(() => getGroupDescendantIds('depth-0', groups)).toThrow(/32/)
})
