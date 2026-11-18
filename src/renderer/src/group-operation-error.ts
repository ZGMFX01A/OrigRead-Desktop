type TranslateGroupError = (key: string, options?: Record<string, string>) => string

const errorKeys: Readonly<Record<string, string>> = {
  '分组名称不能为空': 'groupNameRequired',
  '分组名称不能超过 200 个字符': 'groupNameTooLong',
  '分组名称已存在': 'groupNameExists',
  '同一层级下已存在同名分组': 'groupNameExists',
  '分组不存在': 'groupNotFound',
  '目标分组不存在': 'groupNotFound',
  '指定的父分组不存在': 'groupParentNotFound',
  '父分组必须属于同一账户': 'groupParentAccountMismatch',
  '分组不能将自身设为父分组': 'groupCannotParentItself',
  '检测到分组循环嵌套引用': 'groupTreeInvalid',
  '检测到无效的分组树结构或循环嵌套引用': 'groupTreeInvalid',
  '分组层级中存在无效的父引用': 'groupTreeInvalid',
  '默认分组不允许作为父分组': 'defaultGroupCannotHaveSubgroup',
  '默认分组不允许设置父分组': 'defaultGroupCannotMove',
  '默认分组不允许移动': 'defaultGroupCannotMove',
  '远程账户分组不支持层级结构': 'groupRemoteHierarchyUnsupported',
  '当前同步器不支持分组刷新': 'groupRefreshUnsupported',
  'Fever 账户不支持在客户端重命名分组': 'feverGroupCannotRename',
  'Fever 账户不支持在客户端新建分组': 'feverGroupCannotCreate',
  '分组重命名远端已成功，但无法确认最新分组，请刷新': 'groupRenameUnconfirmed',
  '远端已响应成功但无法确认最新分组，请刷新': 'groupRenameUnconfirmed'
}

/** Translate known group constraints at the UI boundary; preserve unknown server diagnostics. */
export function formatGroupOperationError(reason: unknown, t: TranslateGroupError): string {
  const original = reason instanceof Error ? reason.message : String(reason)
  const message = original.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
  const key = Object.hasOwn(errorKeys, message) ? errorKeys[message] : undefined
  if (key) return t(key)
  if (/^分组不存在或不属于当前账户：.+$/.test(message)) return t('groupNotFound')
  const depth = /^分组层级深度超过最大限制 \((\d+)\)$/.exec(message)
  if (depth) return t('groupDepthExceeded', { depth: depth[1]! })
  const sync = /^分组重命名远端已成功，但后续同步失败：([\s\S]*)$/.exec(message)
  if (sync) return t('groupRenameSyncFailed', { detail: sync[1]! })
  return original
}
