import { describe, expect, it } from 'vitest'
import type { GroupRecord } from '../../shared/library'
import {
  escapeGroupSegment,
  unescapeGroupSegment,
  formatEscapedGroupPath,
  getGroupDisplaySegments,
  formatGroupDisplayPath,
  getGroupRecordDisplayPath
} from './group-display-path'

describe('group-display-path helper', () => {
  const mockTranslate = (key: string) => {
    if (key === 'defaultGroup') return '默认分组'
    return key
  }

  describe('escapeGroupSegment & unescapeGroupSegment & formatEscapedGroupPath', () => {
    it('escapes backslash and slash in order', () => {
      expect(escapeGroupSegment('Tech/Dev')).toBe('Tech\\/Dev')
      expect(escapeGroupSegment('C:\\Windows')).toBe('C:\\\\Windows')
      expect(escapeGroupSegment('A\\/B')).toBe('A\\\\\\/B')
    })

    it('unescapes backslash and slash reversibly', () => {
      expect(unescapeGroupSegment('Tech\\/Dev')).toBe('Tech/Dev')
      expect(unescapeGroupSegment('C:\\\\Windows')).toBe('C:\\Windows')
      expect(unescapeGroupSegment(escapeGroupSegment('Complex\\Path/Test'))).toBe('Complex\\Path/Test')
    })

    it('formats escaped group path with fixed " / " separator', () => {
      expect(formatEscapedGroupPath(['Tech', 'Frontend'])).toBe('Tech / Frontend')
      expect(formatEscapedGroupPath(['Tech/Dev', 'Web'])).toBe('Tech\\/Dev / Web')
    })
  })

  describe('cross-parent same name disambiguation (跨父同名)', () => {
    const groups: GroupRecord[] = [
      { id: 'tech', name: 'Tech', sortOrder: 0, isDefault: false },
      { id: 'design', name: 'Design', sortOrder: 1, isDefault: false },
      { id: 'tech-frontend', name: 'Frontend', parentId: 'tech', sortOrder: 0, isDefault: false },
      { id: 'design-frontend', name: 'Frontend', parentId: 'design', sortOrder: 0, isDefault: false }
    ]

    it('distinguishes identical subgroup names under different parents', () => {
      const path1 = formatGroupDisplayPath('tech-frontend', groups)
      const path2 = formatGroupDisplayPath('design-frontend', groups)

      expect(path1).toBe('Tech / Frontend')
      expect(path2).toBe('Design / Frontend')
      expect(path1).not.toBe(path2)
    })
  })

  describe('slash and backslash disambiguation (区分字面斜杠与层级路径)', () => {
    const groups: GroupRecord[] = [
      // 单独的根分组，名称自带斜杠 "A / B"
      { id: 'root-slash', name: 'A / B', sortOrder: 0, isDefault: false },
      // 真实层级：父分组 "A"，子分组 "B"
      { id: 'parent-a', name: 'A', sortOrder: 1, isDefault: false },
      { id: 'child-b', name: 'B', parentId: 'parent-a', sortOrder: 0, isDefault: false },
      // 包含反斜杠
      { id: 'parent-slash', name: 'Dev\\Ops', sortOrder: 2, isDefault: false },
      { id: 'child-c', name: 'CI/CD', parentId: 'parent-slash', sortOrder: 0, isDefault: false }
    ]

    it('disambiguates root group with literal "A / B" from parent "A" child "B"', () => {
      const rootPath = formatGroupDisplayPath('root-slash', groups)
      const childPath = formatGroupDisplayPath('child-b', groups)

      // 根组 'A / B' 的斜杠被转义为 'A \/ B'
      expect(rootPath).toBe('A \\/ B')
      // 父子层级通过 ' / ' 分隔
      expect(childPath).toBe('A / B')
      expect(rootPath).not.toBe(childPath)
    })

    it('properly escapes both backslash and slash across hierarchy', () => {
      const path = formatGroupDisplayPath('child-c', groups)
      expect(path).toBe('Dev\\\\Ops / CI\\/CD')
    })
  })

  describe('defaultGroup handling & fallback (默认组国际化与降级)', () => {
    const groups: GroupRecord[] = [
      { id: 'default-id', name: 'Default', sortOrder: 0, isDefault: true },
      { id: 'normal-id', name: 'Normal', sortOrder: 1, isDefault: false }
    ]

    it('uses t("defaultGroup") when translation function is provided', () => {
      const pathWithT = formatGroupDisplayPath('default-id', groups, mockTranslate)
      expect(pathWithT).toBe('默认分组')

      const recordPathWithT = getGroupRecordDisplayPath(groups[0]!, groups, mockTranslate)
      expect(recordPathWithT).toBe('默认分组')
    })

    it('falls back to group.name when t is not provided', () => {
      const pathWithoutT = formatGroupDisplayPath('default-id', groups)
      expect(pathWithoutT).toBe('Default')

      const recordPathWithoutT = getGroupRecordDisplayPath(groups[0]!, groups)
      expect(recordPathWithoutT).toBe('Default')
    })
  })

  describe('root fallback & unknown group resilience (根降级与未知分组容错)', () => {
    const groups: GroupRecord[] = [
      { id: 'root-1', name: 'Root Only', sortOrder: 0, isDefault: false }
    ]

    it('returns escaped single name for root groups without parents', () => {
      expect(formatGroupDisplayPath('root-1', groups)).toBe('Root Only')
    })

    it('handles unknown groupId safely with options.fallbackName or empty string', () => {
      expect(formatGroupDisplayPath('unknown-id', groups)).toBe('')
      expect(formatGroupDisplayPath('unknown-id', groups, { fallbackName: 'Fallback/Name' })).toBe('Fallback\\/Name')
    })

    it('handles getGroupRecordDisplayPath for group not in allGroups', () => {
      const detachedGroup: GroupRecord = {
        id: 'detached',
        name: 'Detached/Group',
        sortOrder: 0,
        isDefault: false
      }
      expect(getGroupRecordDisplayPath(detachedGroup, groups)).toBe('Detached\\/Group')
    })

    it('handles legacy orphan group with missing parent without throwing', () => {
      const orphanGroups: GroupRecord[] = [
        { id: 'orphan', name: 'Orphan Group', parentId: 'non-existent-parent', sortOrder: 0, isDefault: false }
      ]
      expect(formatGroupDisplayPath('orphan', orphanGroups)).toBe('Orphan Group')
    })

    it('handles cyclic groups without throwing', () => {
      const cyclicGroups: GroupRecord[] = [
        { id: 'c1', name: 'Cycle 1', parentId: 'c2', sortOrder: 0, isDefault: false },
        { id: 'c2', name: 'Cycle 2', parentId: 'c1', sortOrder: 0, isDefault: false }
      ]
      expect(() => formatGroupDisplayPath('c1', cyclicGroups)).not.toThrow()
      expect(formatGroupDisplayPath('c1', cyclicGroups)).toBe('Cycle 1')
    })
  })

  describe('remote flat groups (远端扁平分组单段保留斜杠)', () => {
    const remoteGroups: GroupRecord[] = [
      { id: 'remote-1', accountId: 2, name: 'Remote/Category', sortOrder: 0, isDefault: false },
      { id: 'remote-2', accountId: 2, name: 'Regular', sortOrder: 1, isDefault: false }
    ]

    it('retains remote group names as single segments without hierarchical split', () => {
      const segments1 = getGroupDisplaySegments('remote-1', remoteGroups)
      expect(segments1).toEqual(['Remote/Category'])

      const path1 = formatGroupDisplayPath('remote-1', remoteGroups)
      expect(path1).toBe('Remote\\/Category')
    })
  })
})


describe('renamed default group labels', () => {
  it('keeps custom default names in selectors and when the record is absent from the catalog', () => {
    const group: GroupRecord = { id: 'default', name: 'Personal / RSS', isDefault: true, sortOrder: 0 }
    const t = () => 'Default group'
    expect(getGroupRecordDisplayPath(group, [group], t)).toBe('Personal \\/ RSS')
    expect(getGroupRecordDisplayPath(group, [], t)).toBe('Personal \\/ RSS')
  })
})
