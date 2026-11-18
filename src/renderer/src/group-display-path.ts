import type { GroupRecord } from '../../shared/library'
import { getGroupPath } from '../../shared/group-tree'

export type GroupTranslate = (key: string) => string

/**
 * 转义分组名称中的反斜杠和正斜杠。
 * 与备份格式化规则完全一致：先将 \ 转义为 \\，再将 / 转义为 \/。
 */
export function escapeGroupSegment(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\//g, '\\/')
}

/**
 * 反转义分组名称中的正斜杠和反斜杠。
 * 先将 \/ 还原为 /，再将 \\ 还原为 \。
 */
export function unescapeGroupSegment(segment: string): string {
  return segment.replace(/\\\//g, '/').replace(/\\\\/g, '\\')
}

/**
 * 将路径片段列表使用无歧义转义格式化为平面路径字符串。
 * 片段之间使用固定 ' / ' 分隔。
 */
export function formatEscapedGroupPath(pathSegments: readonly string[]): string {
  return pathSegments.map(escapeGroupSegment).join(' / ')
}

/**
 * 获取从根到当前分组的显示名称片段列表。
 * - 默认分组保留出厂名称 Default 时可使用翻译文案；自定义名称始终按原名显示。
 * - 远端分组或未知分组单段返回原名。
 * - 组名内部包含的斜杠保持原样，不作拆分。
 */
export function getGroupDisplaySegments(
  groupId: string,
  allGroups: readonly GroupRecord[],
  t?: GroupTranslate
): string[] {
  try {
    const path = getGroupPath(groupId, allGroups)
    if (path.length === 0) return []
    return path.map((record) => {
      if (record.isDefault && record.name === 'Default' && t) {
        return t('defaultGroup')
      }
      return record.name
    })
  } catch {
    // 遇到嵌套环引用等异常时安全降级
    const target = allGroups.find((g) => g.id === groupId)
    if (!target) return []
    const name = target.isDefault && target.name === 'Default' && t ? t('defaultGroup') : target.name
    return [name]
  }
}

export interface FormatGroupDisplayPathOptions {
  t?: GroupTranslate
  fallbackName?: string
}

/**
 * 获取分组的完整显示路径字符串（转义斜杠以区分单节点名称与层级关系）。
 */
export function formatGroupDisplayPath(
  groupId: string,
  allGroups: readonly GroupRecord[],
  options?: FormatGroupDisplayPathOptions | GroupTranslate
): string {
  const t = typeof options === 'function' ? options : options?.t
  const fallbackName = typeof options === 'object' ? options?.fallbackName : undefined

  const segments = getGroupDisplaySegments(groupId, allGroups, t)
  if (segments.length === 0) {
    if (fallbackName !== undefined) {
      return escapeGroupSegment(fallbackName)
    }
    return ''
  }
  return formatEscapedGroupPath(segments)
}

/**
 * 针对已有的 GroupRecord 实例获取其完整显示路径。
 * 若不在 allGroups 中则降级使用 group.name（或默认分组文案）。
 */
export function getGroupRecordDisplayPath(
  group: GroupRecord,
  allGroups: readonly GroupRecord[],
  t?: GroupTranslate
): string {
  const segments = getGroupDisplaySegments(group.id, allGroups, t)
  if (segments.length > 0) {
    return formatEscapedGroupPath(segments)
  }
  const name = group.isDefault && group.name === 'Default' && t ? t('defaultGroup') : group.name
  return escapeGroupSegment(name)
}
