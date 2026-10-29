import type { GroupRecord } from './library'

export function normalizeGroupName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('分组名称不能为空')
  return normalized
}

/** 创建与导入共用名称比较；兼容旧数据中的首尾空白，默认组优先。 */
export function findGroupByName(groups: readonly GroupRecord[], name: string): GroupRecord | undefined {
  const normalized = normalizeGroupName(name)
  return groups.find(group => group.isDefault && group.name.trim() === normalized)
    ?? groups.find(group => group.name.trim() === normalized)
}
