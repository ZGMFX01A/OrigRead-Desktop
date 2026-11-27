import type { GroupRecord } from './library'
import { normalizeGroupName } from './group-name'

export const MAX_GROUP_TREE_DEPTH = 32

export interface GroupTreeNode<T extends GroupRecord = GroupRecord> {
  id: string
  name: string
  group: T
  parentId: string | null
  children: GroupTreeNode<T>[]
  depth: number
}

/**
 * 获取指定分组的所有后代分组 ID（不含自身）。
 * 按层级顺序返回，使用 visited 保证去重并防止循环引用，支持最大深度限制。
 */
export function getGroupDescendantIds(
  groupId: string,
  allGroups: readonly GroupRecord[],
  options?: { maxDepth?: number }
): string[] {
  const maxDepth = options?.maxDepth ?? MAX_GROUP_TREE_DEPTH
  const childrenMap = new Map<string, string[]>()
  for (const group of allGroups) {
    const parentId = group.parentId ?? null
    if (parentId) {
      const list = childrenMap.get(parentId)
      if (list) {
        list.push(group.id)
      } else {
        childrenMap.set(parentId, [group.id])
      }
    }
  }

  const result: string[] = []
  const visited = new Set<string>([groupId])
  const queue: Array<{ id: string; depth: number }> = []

  const directChildren = childrenMap.get(groupId) ?? []
  for (const childId of directChildren) {
    if (childId === groupId) {
      throw new Error('检测到分组循环嵌套引用')
    }
    queue.push({ id: childId, depth: 2 })
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id)) {
      throw new Error('检测到分组循环嵌套引用')
    }
    visited.add(id)
    if (depth > maxDepth) {
      throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
    }

    result.push(id)

    const nextChildren = childrenMap.get(id) ?? []
    for (const nextChildId of nextChildren) {
      queue.push({ id: nextChildId, depth: depth + 1 })
    }
  }

  return result
}

/**
 * 获取从根分组到当前分组的完整路径 Record 列表（包含自身）。
 */
export function getGroupPath(
  groupId: string,
  allGroups: readonly GroupRecord[],
  options?: { maxDepth?: number }
): GroupRecord[] {
  const maxDepth = options?.maxDepth ?? MAX_GROUP_TREE_DEPTH
  const groupMap = new Map<string, GroupRecord>(allGroups.map((g) => [g.id, g]))
  const target = groupMap.get(groupId)
  if (!target) return []

  const path: GroupRecord[] = [target]
  const visited = new Set<string>([groupId])
  let current: GroupRecord = target
  let depth = 1

  while (current.parentId) {
    if (visited.has(current.parentId)) {
      throw new Error('检测到分组循环嵌套引用')
    }
    visited.add(current.parentId)
    depth++
    if (depth > maxDepth) {
      throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
    }
    const parent = groupMap.get(current.parentId)
    if (!parent) {
      // 遗留孤儿分组：父分组不存在时安全截止于当前节点
      break
    }
    path.unshift(parent)
    current = parent
  }

  return path
}

/**
 * 获取从根分组到当前分组的路径片段（名称列表，保持原样不按 / 拆分）。
 */
export function getGroupPathSegments(
  groupId: string,
  allGroups: readonly GroupRecord[],
  options?: { maxDepth?: number }
): string[] {
  return getGroupPath(groupId, allGroups, options).map((group) => group.name)
}

/**
 * 构建展示用的分组树结构。
 * 遗留孤儿分组（找不到父级）安全当根展示；
 * 具备环与深度防护，子节点按 sortOrder, name 排序。
 */
export function buildGroupTree<T extends GroupRecord>(
  groups: readonly T[],
  options?: { maxDepth?: number; throwOnInvalid?: boolean }
): GroupTreeNode<T>[] {
  const maxDepth = options?.maxDepth ?? MAX_GROUP_TREE_DEPTH
  const nodeMap = new Map<string, GroupTreeNode<T>>()

  for (const group of groups) {
    nodeMap.set(group.id, {
      id: group.id,
      name: group.name,
      group,
      parentId: group.parentId ?? null,
      children: [],
      depth: 0
    })
  }

  const roots: GroupTreeNode<T>[] = []

  for (const group of groups) {
    const node = nodeMap.get(group.id)!
    const parentId = group.parentId ?? null
    if (!parentId || !nodeMap.has(parentId) || parentId === group.id) {
      // 根分组、孤儿分组或自引用的异常分组：安全作为根展示
      roots.push(node)
    } else {
      const parentNode = nodeMap.get(parentId)!
      parentNode.children.push(node)
    }
  }

  const visited = new Set<string>()

  function markSubtreeVisited(startNode: GroupTreeNode<T>): void {
    const queue = [startNode]
    while (queue.length > 0) {
      const item = queue.shift()!
      visited.add(item.id)
      for (const c of item.children) {
        if (!visited.has(c.id)) {
          queue.push(c)
        }
      }
    }
  }

  function walk(node: GroupTreeNode<T>, currentDepth: number): void {
    if (visited.has(node.id)) {
      node.children = []
      return
    }
    visited.add(node.id)
    node.depth = currentDepth

    node.children.sort(
      (a, b) => a.group.sortOrder - b.group.sortOrder || a.group.name.localeCompare(b.group.name)
    )

    node.children = node.children.filter((child) => !visited.has(child.id))

    // 检查子节点深度限制：若下一层深度将达到或超过 maxDepth，截断并标记子树已访问，防止在孤立环逻辑中重复当根渲染
    if (currentDepth + 1 >= maxDepth) {
      for (const child of node.children) {
        markSubtreeVisited(child)
      }
      node.children = []
      return
    }

    for (const child of node.children) {
      walk(child, currentDepth + 1)
    }
  }

  for (const root of roots) {
    walk(root, 0)
  }

  // 若存在脱离根的环结构（所有节点均有非空 parentId 且在 map 中）
  for (const [id, node] of nodeMap.entries()) {
    if (!visited.has(id)) {
      if (options?.throwOnInvalid) {
        throw new Error('检测到无效的分组树结构或循环嵌套引用')
      }
      roots.push(node)
      walk(node, 0)
    }
  }

  roots.sort(
    (a, b) => a.group.sortOrder - b.group.sortOrder || a.group.name.localeCompare(b.group.name)
  )

  return roots
}

export interface ValidateGroupParentOptions {
  groupId: string
  parentId?: string | null
  allGroups: readonly GroupRecord[]
  isLocalAccount?: boolean
  accountId?: number
  isDefault?: boolean
  maxDepth?: number
}

/**
 * 显式校验写入或导入时的父子关系合法性。
 * 明确拒绝孤儿、环、自引用、默认组嵌套与远程层级。
 * 深度定义：根节点 depth = 1。
 * 校验新父级深度 parentDepth + 目标子树高度 targetSubtreeHeight <= maxDepth (32)。
 */
export function validateGroupParent(options: ValidateGroupParentOptions): void {
  const {
    groupId,
    parentId,
    allGroups,
    isLocalAccount = true,
    accountId,
    isDefault = false,
    maxDepth = MAX_GROUP_TREE_DEPTH
  } = options

  const groupMap = new Map<string, GroupRecord>(allGroups.map((g) => [g.id, g]))

  // 1. 构建 childrenMap 用于分析以 groupId 为根的目标子树高度及环检测
  const childrenMap = new Map<string, string[]>()
  for (const g of allGroups) {
    const pid = g.parentId ?? null
    if (pid) {
      const list = childrenMap.get(pid)
      if (list) {
        list.push(g.id)
      } else {
        childrenMap.set(pid, [g.id])
      }
    }
  }

  // 2. 计算目标子树自身高度 targetSubtreeHeight，并检测子树内部是否有环（循环有界）
  const subtreeVisited = new Set<string>([groupId])
  let subtreeHeight = 1
  const subtreeQueue: Array<{ id: string; height: number }> = [{ id: groupId, height: 1 }]

  while (subtreeQueue.length > 0) {
    const { id, height } = subtreeQueue.shift()!
    if (height > subtreeHeight) {
      subtreeHeight = height
    }
    if (height > maxDepth) {
      throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
    }
    const children = childrenMap.get(id) ?? []
    for (const childId of children) {
      if (subtreeVisited.has(childId)) {
        throw new Error('检测到分组循环嵌套引用')
      }
      subtreeVisited.add(childId)
      subtreeQueue.push({ id: childId, height: height + 1 })
    }
  }

  const targetParentId = parentId ?? null

  // 3. 根移动校验：若移到根（targetParentId 为 null），根深度为 1，子树总深度即为 subtreeHeight
  if (!targetParentId) {
    if (subtreeHeight > maxDepth) {
      throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
    }
    return
  }

  // 4. 挂载到父节点时的规则校验
  if (!isLocalAccount) {
    throw new Error('远程账户分组不支持层级结构')
  }

  if (isDefault) {
    throw new Error('默认分组不允许设置父分组')
  }

  if (targetParentId === groupId) {
    throw new Error('分组不能将自身设为父分组')
  }

  // 禁止将分组移动到自身的后代节点下造成环
  if (subtreeVisited.has(targetParentId)) {
    throw new Error('检测到分组循环嵌套引用')
  }

  const parent = groupMap.get(targetParentId)
  if (!parent) {
    throw new Error('指定的父分组不存在')
  }

  if (accountId !== undefined && parent.accountId !== undefined && parent.accountId !== accountId) {
    throw new Error('父分组必须属于同一账户')
  }

  if (parent.isDefault) {
    throw new Error('默认分组不允许作为父分组')
  }

  // 5. 向上追踪父链，计算 parentDepth（根节点深度为 1）并检测祖先环
  const ancestorVisited = new Set<string>([groupId])
  let current: GroupRecord | undefined = parent
  let parentDepth = 1

  while (current) {
    if (ancestorVisited.has(current.id)) {
      throw new Error('检测到分组循环嵌套引用')
    }
    ancestorVisited.add(current.id)

    const nextParentId = current.parentId ?? null
    if (!nextParentId) break

    if (nextParentId === groupId) {
      throw new Error('检测到分组循环嵌套引用')
    }

    parentDepth++
    if (parentDepth > maxDepth) {
      throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
    }

    current = groupMap.get(nextParentId)
    if (!current) {
      throw new Error('分组层级中存在无效的父引用')
    }
  }

  // 6. 核心检查：parentDepth + subtreeHeight <= maxDepth
  if (parentDepth + subtreeHeight > maxDepth) {
    throw new Error(`分组层级深度超过最大限制 (${maxDepth})`)
  }
}

/**
 * 查找同级同名分组（同父同名冲突）。
 * 同一父级下同名拒绝，不同父级允许。
 */
export function findSiblingGroupByName(
  allGroups: readonly GroupRecord[],
  name: string,
  parentId: string | null | undefined,
  excludeGroupId?: string
): GroupRecord | undefined {
  const normalized = normalizeGroupName(name)
  const targetParentId = parentId ?? null
  const matching = allGroups.filter((g) => {
    if (excludeGroupId && g.id === excludeGroupId) return false
    const gParentId = g.parentId ?? null
    if (gParentId !== targetParentId) return false
    return g.name.trim() === normalized
  })
  return matching.find((g) => g.isDefault) ?? matching[0]
}

export function checkSiblingNameConflict(
  allGroups: readonly GroupRecord[],
  name: string,
  parentId: string | null | undefined,
  excludeGroupId?: string
): boolean {
  return findSiblingGroupByName(allGroups, name, parentId, excludeGroupId) !== undefined
}

export function assertNoSiblingNameConflict(
  allGroups: readonly GroupRecord[],
  name: string,
  parentId: string | null | undefined,
  excludeGroupId?: string
): void {
  if (checkSiblingNameConflict(allGroups, name, parentId, excludeGroupId)) {
    throw new Error('同一层级下已存在同名分组')
  }
}

/**
 * 校验整批分组树（用于导入、备份还原等场景）。
 */
export function validateGroupHierarchy(
  groups: readonly GroupRecord[],
  options?: { isLocalAccount?: boolean; accountId?: number; maxDepth?: number }
): void {
  // 1. 拒绝重复 ID（防止 Map 覆盖）
  const idSet = new Set<string>()
  for (const group of groups) {
    if (idSet.has(group.id)) {
      throw new Error(`存在重复的分组 ID: ${group.id}`)
    }
    idSet.add(group.id)
  }

  // 2. 验证提供 accountId 时拒绝任何组（包含根组）跨账户
  if (options?.accountId !== undefined) {
    for (const group of groups) {
      if (group.accountId !== undefined && group.accountId !== options.accountId) {
        throw new Error(`分组 ${group.id} 不属于指定账户 ${options.accountId}`)
      }
    }
  }

  // 3. 校验每个组的父子关系
  for (const group of groups) {
    validateGroupParent({
      groupId: group.id,
      parentId: group.parentId,
      allGroups: groups,
      isLocalAccount: options?.isLocalAccount,
      accountId: options?.accountId ?? group.accountId,
      isDefault: group.isDefault,
      maxDepth: options?.maxDepth
    })
  }

  // 4. 同级同名校验（仅本地账户），使用嵌套 Map 避免字符串拼接碰撞 (ROOT/::)
  if (options?.isLocalAccount !== false) {
    const siblingMap = new Map<string | null, Set<string>>()
    for (const group of groups) {
      const pid = group.parentId ?? null
      const normalizedName = normalizeGroupName(group.name)
      let nameSet = siblingMap.get(pid)
      if (!nameSet) {
        nameSet = new Set<string>()
        siblingMap.set(pid, nameSet)
      }
      if (nameSet.has(normalizedName)) {
        throw new Error(`同一层级下存在重复分组名称: ${group.name.trim()}`)
      }
      nameSet.add(normalizedName)
    }
  }
}
