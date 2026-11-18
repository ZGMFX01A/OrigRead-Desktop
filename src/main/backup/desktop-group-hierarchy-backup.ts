import type { BackupGroup, DesktopGroupHierarchyBackup } from '../../shared/configuration-backup'
import { normalizeGroupName } from '../../shared/group-name'

export const MAX_BACKUP_GROUP_DEPTH = 32
export const MAX_GROUP_NAME_LENGTH = 200

export interface ValidatedHierarchyGroup {
  id: string
  name: string
  parentId: string | null
  isDefault: boolean
  depth: number
}

export interface ValidatedGroupHierarchy {
  version: 1
  orderedGroups: ValidatedHierarchyGroup[]
  groupMap: Map<string, ValidatedHierarchyGroup>
}

export interface ValidateDesktopGroupHierarchyOptions {
  isLocalAccount?: boolean
}

/**
 * 转义分组名称中的反斜杠和正斜杠。
 * 顺序：先将 \ 转义为 \\，再将 / 转义为 \/。
 */
export function escapeGroupSegment(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\//g, '\\/')
}

/**
 * 反转义分组名称中的正斜杠和反斜杠。
 * 顺序：先将 \/ 还原为 /，再将 \\ 还原为 \。
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
 * 为给定的分组列表计算从根到每个节点的完整 escaped 路径名。
 * 对根节点也转义以保证降级无碰撞。
 */
export function buildGroupPathMap(
  groups: ReadonlyArray<{ id: string; parentId?: string | null; name: string }>
): Map<string, string> {
  const groupMap = new Map<string, { id: string; parentId?: string | null; name: string }>()
  for (const g of groups) {
    groupMap.set(g.id, g)
  }

  const pathMap = new Map<string, string>()

  for (const group of groups) {
    const segments: string[] = [group.name]
    const visited = new Set<string>([group.id])
    let current = group

    while (current.parentId) {
      if (visited.has(current.parentId)) break
      visited.add(current.parentId)
      const parent = groupMap.get(current.parentId)
      if (!parent) break
      segments.unshift(parent.name)
      current = parent
    }

    pathMap.set(group.id, formatEscapedGroupPath(segments))
  }

  return pathMap
}

/**
 * 严格校验配置备份中的 desktopGroupHierarchy 元数据：
 * 1. 无元数据旧备份返回 null，保持兼容平铺读取；
 * 2. 校验元数据格式与版本（version: 1）；
 * 3. 校验 metadata groups ID 集合与 subscriptions.groups 严格完全一致（完全覆盖，无重复 ID）；
 * 4. 校验分组名称非空、非空白且长度 <= 200；
 * 5. 校验默认分组限制（default parent 必须为 null，任何其他组不得以 default 组为 parent）；
 * 6. 校验父分组存在（拒绝孤儿与自引用）；
 * 7. 环检测与层级深度防护（最大支持 32 层）；
 * 8. 校验同一父分组下的兄弟同级重名（基于 normalizeGroupName 归一化）；
 * 9. 若为远程账户且存在嵌套层级，明确拒绝；
 * 10. 输出经拓扑排序（Parent-first order）的有序合法分组列表供恢复模块消费。
 */
export function validateDesktopGroupHierarchyBackup(
  metadata: unknown,
  subscriptionGroups: readonly BackupGroup[],
  options?: ValidateDesktopGroupHierarchyOptions
): ValidatedGroupHierarchy | null {
  // 1. 无元数据旧备份依旧可读
  if (metadata === undefined || metadata === null) {
    return null
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('备份中的分组层级元数据无效')
  }

  const meta = metadata as Partial<DesktopGroupHierarchyBackup>
  if (meta.version !== 1) {
    throw new Error(`不支持的分组层级元数据版本：${String(meta.version)}`)
  }

  if (!Array.isArray(meta.groups)) {
    throw new Error('备份中的分组层级元数据缺少 groups 列表')
  }

  const metaGroups = meta.groups

  // 2. 校验 metadata groups 格式与重复 ID
  const metaGroupMap = new Map<string, { id: string; parentId: string | null; name: string }>()
  for (const g of metaGroups) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      throw new Error('备份中的分组层级元数据项无效')
    }
    if (typeof g.id !== 'string' || !g.id.trim()) {
      throw new Error('分组元数据包含无效的分组 ID')
    }
    if (metaGroupMap.has(g.id)) {
      throw new Error(`分组元数据存在重复的分组 ID: ${g.id}`)
    }
    if (g.parentId !== null && (typeof g.parentId !== 'string' || !g.parentId.trim())) {
      throw new Error(`分组 ${g.id} 的 parentId 无效`)
    }
    if (typeof g.name !== 'string' || !g.name.trim()) {
      throw new Error(`分组 ${g.id} 的名称不能为空`)
    }
    if (g.name.length > MAX_GROUP_NAME_LENGTH) {
      throw new Error(`分组 ${g.id} 的名称超过最大长度限制 (${MAX_GROUP_NAME_LENGTH} 字符)`)
    }
    metaGroupMap.set(g.id, {
      id: g.id,
      parentId: g.parentId ?? null,
      name: g.name
    })
  }

  // 3. 检查与 subscriptions.groups 的完全一致性（完全覆盖，集合精确相等）
  const subGroupMap = new Map<string, BackupGroup>()
  for (const sg of subscriptionGroups) {
    if (subGroupMap.has(sg.id)) {
      throw new Error(`订阅数据存在重复的分组 ID: ${sg.id}`)
    }
    subGroupMap.set(sg.id, sg)
  }

  if (metaGroupMap.size !== subGroupMap.size) {
    throw new Error(
      `分组层级元数据数量 (${metaGroupMap.size}) 与订阅分组数量 (${subGroupMap.size}) 不一致`
    )
  }

  for (const id of metaGroupMap.keys()) {
    if (!subGroupMap.has(id)) {
      throw new Error(`分组层级元数据中的分组 ${id} 在订阅分组中不存在`)
    }
  }

  // 4. 远程账户校验：远程账户不支持嵌套层级
  if (options?.isLocalAccount === false) {
    for (const mg of metaGroupMap.values()) {
      if (mg.parentId !== null) {
        throw new Error('远程账户不支持导入层级分组')
      }
    }
  }

  // 5. 检查默认分组限制：
  // default 组 parentId 必须为 null
  // 任何组不能以 default 组作为 parent (defaultchildren 限制)
  const defaultGroupIds = new Set<string>()
  for (const sg of subscriptionGroups) {
    if (sg.isDefault) {
      defaultGroupIds.add(sg.id)
      const mg = metaGroupMap.get(sg.id)
      if (mg && mg.parentId !== null) {
        throw new Error(`默认分组 ${sg.id} 不允许设置父分组`)
      }
    }
  }

  for (const mg of metaGroupMap.values()) {
    if (mg.parentId !== null && defaultGroupIds.has(mg.parentId)) {
      throw new Error(`默认分组 ${mg.parentId} 不允许作为父分组`)
    }
  }

  // 6. 检查父节点存在（orphans 检查）与自引用
  for (const mg of metaGroupMap.values()) {
    if (mg.parentId !== null) {
      if (mg.parentId === mg.id) {
        throw new Error(`分组 ${mg.id} 不能将自身设为父分组`)
      }
      if (!metaGroupMap.has(mg.parentId)) {
        throw new Error(`分组 ${mg.id} 引用的父分组 ${mg.parentId} 不存在`)
      }
    }
  }

  // 7. 环检测与层级深度检查（<= 32），计算每个节点的 depth（根节点 depth = 1）
  const depthMap = new Map<string, number>()
  for (const mg of metaGroupMap.values()) {
    const chainVisited = new Set<string>([mg.id])
    let currentId = mg.parentId
    let depth = 1

    while (currentId !== null) {
      if (chainVisited.has(currentId)) {
        throw new Error(`检测到分组循环嵌套引用：${mg.id}`)
      }
      chainVisited.add(currentId)
      depth++
      if (depth > MAX_BACKUP_GROUP_DEPTH) {
        throw new Error(`分组层级深度超过最大限制 (${MAX_BACKUP_GROUP_DEPTH})`)
      }
      const parent = metaGroupMap.get(currentId)
      if (!parent) {
        throw new Error(`分组层级中存在无效的父引用：${currentId}`)
      }
      currentId = parent.parentId
    }

    depthMap.set(mg.id, depth)
  }

  // 8. 同级重名检查 (siblingduplicate)
  // 同一 parentId 下，经 normalizeGroupName 后的 name 不能重复
  const siblingNameMap = new Map<string | null, Set<string>>()
  for (const mg of metaGroupMap.values()) {
    const pid = mg.parentId
    let nameSet = siblingNameMap.get(pid)
    if (!nameSet) {
      nameSet = new Set<string>()
      siblingNameMap.set(pid, nameSet)
    }
    const normalized = normalizeGroupName(mg.name)
    if (nameSet.has(normalized)) {
      throw new Error(`同一层级下存在重复分组名称: ${mg.name.trim()}`)
    }
    nameSet.add(normalized)
  }

  // 9. 生成拓扑排序 (Parent-first ordered groups)
  // 必须按 depth 升序排序，确保恢复时所有父分组先于其子分组被处理和创建
  const orderedGroups: ValidatedHierarchyGroup[] = []
  const groupMap = new Map<string, ValidatedHierarchyGroup>()

  const sortedMetaGroups = Array.from(metaGroupMap.values()).sort((a, b) => {
    const da = depthMap.get(a.id) ?? 1
    const db = depthMap.get(b.id) ?? 1
    if (da !== db) return da - db
    return a.name.localeCompare(b.name)
  })

  for (const mg of sortedMetaGroups) {
    const sub = subGroupMap.get(mg.id)!
    const validGroup: ValidatedHierarchyGroup = {
      id: mg.id,
      name: mg.name,
      parentId: mg.parentId,
      isDefault: Boolean(sub.isDefault),
      depth: depthMap.get(mg.id) ?? 1
    }
    orderedGroups.push(validGroup)
    groupMap.set(validGroup.id, validGroup)
  }

  return {
    version: 1,
    orderedGroups,
    groupMap
  }
}
