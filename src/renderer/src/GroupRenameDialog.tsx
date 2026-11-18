import { formatGroupOperationError } from './group-operation-error'
import { FolderInput, FolderPlus, Pencil, RefreshCw, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccountType } from '../../shared/account'
import { getGroupDescendantIds } from '../../shared/group-tree'
import type { GroupRecord } from '../../shared/library'
import { getGroupRecordDisplayPath } from './group-display-path'

export interface GroupContextMenuProps {
  /** 目标分组记录 */
  group: GroupRecord
  /** 当前活动账户是否为本地账户（向后兼容保留） */
  isLocalAccount?: boolean
  /** 当前活动账户类型 */
  accountType?: AccountType
  /** 菜单定位样式（left / top） */
  style: CSSProperties
  /** 关闭上下文菜单回调 */
  onClose: () => void
  /** 触发重命名对话框回调 */
  onRename: () => void
  /** 刷新分组回调 */
  onRefresh?: () => void
  /** 是否正在刷新 */
  refreshing?: boolean
  refreshDisabled?: boolean
  /** 触发创建子分组回调 */
  onCreateSubgroup?: () => void
  /** 触发移动分组回调 */
  onMoveGroup?: () => void
}

/**
 * 判断指定账户类型是否支持重命名分组。
 * 本地账户、Google Reader 与 FreshRSS 支持重命名，Fever 不支持。
 * 若未提供 accountType，则降级按 isLocalAccount 判断以保持向后兼容。
 */
export function isGroupRenameSupported(accountType?: AccountType, isLocalAccount?: boolean): boolean {
  if (accountType !== undefined) {
    return accountType !== 'fever'
  }
  return isLocalAccount ?? true
}

/**
 * 获取分组不可重命名的明确限制原因，若允许重命名则返回 null。
 */
export function getGroupRenameDisabledReason(
  group: GroupRecord,
  accountType: AccountType | undefined,
  isLocalAccount: boolean | undefined,
  t: (key: string) => string
): string | null {
  const isDefault = group.isDefault || group.id === '__ungrouped__'
  if (isDefault) return null
  if (accountType === 'fever') return t('feverGroupCannotRename')
  if (!isGroupRenameSupported(accountType, isLocalAccount)) {
    return t('remoteGroupCannotRename')
  }
  return null
}

/**
 * 分组右键及明确操作菜单。
 * 支持展示重命名入口，并在远端不支持场景给出明确限制原因。
 */
export function GroupContextMenu({
  group,
  isLocalAccount,
  accountType,
  style,
  onClose,
  onRename,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  onCreateSubgroup,
  onMoveGroup
}: GroupContextMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const disabledReason = getGroupRenameDisabledReason(group, accountType, isLocalAccount, t)
  const disabled = disabledReason !== null
  const isLocal = accountType ? accountType === 'local' : (isLocalAccount ?? true)
  const isDefault = group.isDefault || group.id === '__ungrouped__'

  return (
    <div
      className="desktop-context-menu"
      style={style}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {onRefresh && (
        <button
          type="button"
          role="menuitem"
          disabled={refreshing || refreshDisabled}
          title={!isLocal ? t('refreshRemoteGroupTooltip') : undefined}
          onClick={() => {
            onClose()
            onRefresh()
          }}
        >
          <RefreshCw size={14} className={refreshing ? 'spinning' : ''} />
          <span>{isLocal ? t('refreshGroup') : t('refreshRemoteGroup')}</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        title={disabledReason ?? undefined}
        onClick={() => {
          if (!disabled) {
            onClose()
            onRename()
          }
        }}
      >
        <Pencil size={14} />
        <span>{t('renameGroup')}</span>
      </button>
      {isLocal && onCreateSubgroup && (
        <button
          type="button"
          role="menuitem"
          disabled={isDefault}
          title={isDefault ? t('defaultGroupCannotHaveSubgroup') : undefined}
          onClick={() => {
            if (!isDefault) {
              onClose()
              onCreateSubgroup()
            }
          }}
        >
          <FolderPlus size={14} />
          <span>{t('createSubgroup')}</span>
        </button>
      )}
      {isLocal && onMoveGroup && (
        <button
          type="button"
          role="menuitem"
          disabled={isDefault}
          title={isDefault ? t('defaultGroupCannotMove') : undefined}
          onClick={() => {
            if (!isDefault) {
              onClose()
              onMoveGroup()
            }
          }}
        >
          <FolderInput size={14} />
          <span>{t('moveGroup')}</span>
        </button>
      )}
      {disabledReason && <div className="context-menu-label">{disabledReason}</div>}
    </div>
  )
}

interface GroupRenameDialogProps {
  /** 正在被编辑的分组 */
  group: GroupRecord
  /** 当前活动账户是否为本地账户（向后兼容保留） */
  isLocalAccount?: boolean
  /** 当前活动账户类型 */
  accountType?: AccountType
  /** 打开对话框时的当前账户 ID，用于并发切换账户后的响应隔离 */
  currentAccountId: number | null
  /** 关闭对话框 */
  onClose: () => void
  /** 重命名成功回调，返回更新后的 GroupRecord */
  onSuccess: (updated: GroupRecord) => void | Promise<void>
}

/**
 * 分组重命名编辑模态对话框。
 * 遵循非 window.prompt 规范，具备正在保存防重提交、账户切换隔离、输入保持与错误提示能力。
 */
export function GroupRenameDialog({
  group,
  isLocalAccount,
  accountType,
  currentAccountId,
  onClose,
  onSuccess
}: GroupRenameDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(group.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 绑定打开时的账户 ID 与分组 ID，防止异步响应返回时账户已切换导致旧响应污染
  const initialAccountIdRef = useRef(currentAccountId)
  const initialGroupIdRef = useRef(group.id)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const latestRef = useRef({ currentAccountId, groupId: group.id, onClose, onSuccess })

  latestRef.current = { currentAccountId, groupId: group.id, onClose, onSuccess }

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const unsupportedReason = getGroupRenameDisabledReason(group, accountType, isLocalAccount, t)
  const renameUnsupported = unsupportedReason !== null

  const trimmedName = name.trim()
  const isLengthValid = trimmedName.length > 0 && trimmedName.length <= 200
  const canSubmit = !renameUnsupported && isLengthValid
    && (group.accountId === undefined || group.accountId === currentAccountId)

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return

    // 在 API 发起前检查归属与挂载状态
    if (
      !mountedRef.current ||
      latestRef.current.currentAccountId !== initialAccountIdRef.current ||
      latestRef.current.groupId !== initialGroupIdRef.current
    ) {
      return
    }

    generationRef.current += 1
    const currentGeneration = generationRef.current

    setBusy(true)
    setError(null)

    try {
      const updated = await window.origread.renameGroup(group.id, trimmedName)
      // 若组件已卸载、发起新一轮请求，或账户/分组在保存过程中被切换，则丢弃旧响应
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.groupId !== initialGroupIdRef.current
      ) {
        return
      }
      await latestRef.current.onSuccess(updated)
    } catch (reason) {
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.groupId !== initialGroupIdRef.current
      ) {
        return
      }
      setError(formatGroupOperationError(reason, t))
    } finally {
      // finally 也不能更新已卸载组件或已失效轮次
      if (mountedRef.current && generationRef.current === currentGeneration) {
        setBusy(false)
      }
    }
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && canSubmit && !busy) {
      event.preventDefault()
      void handleSave()
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) {
            onClose()
          }
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose()
        }
      }}
    >
      <section
        className="source-dialog group-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-group-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="rename-group-title">{t('renameGroupTitle')}</h2>
            <p>{t('renameGroupDescription')}</p>
          </div>
          <button
            type="button"
            className="dialog-close"
            data-escape-close
            aria-label={t('close')}
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            <X size={16} />
          </button>
        </header>

        <label className="dialog-field">
          <span>{t('groupName')}</span>
          <input
            autoFocus
            value={name}
            disabled={busy || renameUnsupported}
            placeholder={t('groupNamePlaceholder')}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={handleInputKeyDown}
          />
        </label>

        {renameUnsupported ? (
          <div className="dialog-error" role="alert">
            {unsupportedReason}
          </div>
        ) : error ? (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        ) : null}

        <footer className="dialog-footer">
          <span className="dialog-footer-spacer" />
          <button
            type="button"
            className="dialog-cancel"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="dialog-submit"
            disabled={busy || !canSubmit}
            onClick={() => void handleSave()}
          >
            {busy && <RefreshCw size={14} className="spinning" />}
            {t('save')}
          </button>
        </footer>
      </section>
    </div>
  )
}

export interface CreateGroupDialogProps {
  /** 父分组记录；null 表示新建根分组 */
  parentGroup: GroupRecord | null
  /** 当前账户下的所有可用分组（用于显示完整父分组路径） */
  allGroups?: readonly GroupRecord[]
  /** 打开对话框时的当前账户 ID，用于并发切换账户后的响应隔离 */
  currentAccountId: number | null
  /** 关闭对话框 */
  onClose: () => void
  /** 创建成功回调，返回父分组 ID 与更新后的分组列表 */
  onSuccess: (parentId: string | null, groups: GroupRecord[]) => void | Promise<void>
}

/**
 * 创建根分组或子分组的共用对话框。
 * 支持输入子分组名称（<=200），具备默认组限制、并发防重、账户隔离与错误展示。
 */
export function CreateGroupDialog({
  parentGroup,
  allGroups,
  currentAccountId,
  onClose,
  onSuccess
}: CreateGroupDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const parentId = parentGroup?.id ?? null
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const initialAccountIdRef = useRef(currentAccountId)
  const initialParentIdRef = useRef(parentId)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const latestRef = useRef({ currentAccountId, parentId, onClose, onSuccess })

  latestRef.current = { currentAccountId, parentId, onClose, onSuccess }

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isDefault = parentGroup?.isDefault || parentId === '__ungrouped__'
  const trimmedName = name.trim()
  const isLengthValid = trimmedName.length > 0 && trimmedName.length <= 200
  const canSubmit = !isDefault && isLengthValid
    && (!parentGroup || parentGroup.accountId === undefined || parentGroup.accountId === currentAccountId)

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return

    if (
      !mountedRef.current ||
      latestRef.current.currentAccountId !== initialAccountIdRef.current ||
      latestRef.current.parentId !== initialParentIdRef.current
    ) {
      return
    }

    generationRef.current += 1
    const currentGeneration = generationRef.current

    setBusy(true)
    setError(null)

    try {
      const updatedGroups = await window.origread.addGroup(trimmedName, parentId)
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.parentId !== initialParentIdRef.current
      ) {
        return
      }
      await latestRef.current.onSuccess(parentId, updatedGroups)
    } catch (reason) {
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.parentId !== initialParentIdRef.current
      ) {
        return
      }
      setError(formatGroupOperationError(reason, t))
    } finally {
      if (mountedRef.current && generationRef.current === currentGeneration) {
        setBusy(false)
      }
    }
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && canSubmit && !busy) {
      event.preventDefault()
      void handleSave()
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) {
            onClose()
          }
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose()
        }
      }}
    >
      <section
        className="source-dialog create-subgroup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-subgroup-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="create-subgroup-title">{t(parentGroup ? 'createSubgroupTitle' : 'addGroup')}</h2>
            {parentGroup && <p>{t('createSubgroupDescription')}</p>}
          </div>
          <button
            type="button"
            className="dialog-close"
            data-escape-close
            aria-label={t('close')}
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            <X size={16} />
          </button>
        </header>

        {parentGroup && <div className="dialog-field">
          <span>{t('parentGroup')}</span>
          <input value={getGroupRecordDisplayPath(parentGroup, allGroups ?? [parentGroup], t)} disabled readOnly />
        </div>}

        <label className="dialog-field">
          <span>{t(parentGroup ? 'subgroupName' : 'groupName')}</span>
          <input
            autoFocus
            value={name}
            disabled={busy || isDefault}
            placeholder={t('groupNamePlaceholder')}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={handleInputKeyDown}
          />
        </label>

        {isDefault ? (
          <div className="dialog-error" role="alert">
            {t('defaultGroupCannotHaveSubgroup')}
          </div>
        ) : error ? (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        ) : null}

        <footer className="dialog-footer">
          <span className="dialog-footer-spacer" />
          <button
            type="button"
            className="dialog-cancel"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="dialog-submit"
            disabled={busy || !canSubmit}
            onClick={() => void handleSave()}
          >
            {busy && <RefreshCw size={14} className="spinning" />}
            {t('create')}
          </button>
        </footer>
      </section>
    </div>
  )
}

export interface MoveGroupDialogProps {
  /** 正在被移动的分组 */
  group: GroupRecord
  /** 当前账户下的所有可用分组 */
  allGroups: readonly GroupRecord[]
  /** 打开对话框时的当前账户 ID，用于并发切换账户后的响应隔离 */
  currentAccountId: number | null
  /** 关闭对话框 */
  onClose: () => void
  /** 移动成功回调，返回目标父分组 ID（根目录为 null）与更新后的 GroupRecord */
  onSuccess: (targetParentId: string | null, updated: GroupRecord) => void | Promise<void>
}

/**
 * 移动分组选择父目录对话框。
 * 自动排除自身及全部后代、排除默认组，可移回根目录。
 */
export function MoveGroupDialog({
  group,
  allGroups,
  currentAccountId,
  onClose,
  onSuccess
}: MoveGroupDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [selectedParentId, setSelectedParentId] = useState<string>(group.parentId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const initialAccountIdRef = useRef(currentAccountId)
  const initialGroupIdRef = useRef(group.id)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const latestRef = useRef({ currentAccountId, groupId: group.id, onClose, onSuccess })

  latestRef.current = { currentAccountId, groupId: group.id, onClose, onSuccess }

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const descendantIds = useMemo(() => {
    try {
      return new Set([group.id, ...getGroupDescendantIds(group.id, allGroups)])
    } catch {
      return new Set([group.id])
    }
  }, [group.id, allGroups])

  const candidateGroups = useMemo(() => {
    return allGroups.filter((g) => {
      if (descendantIds.has(g.id)) return false
      if (g.isDefault || g.id === '__ungrouped__') return false
      return true
    })
  }, [allGroups, descendantIds])

  const isDefault = group.isDefault || group.id === '__ungrouped__'
  const canSubmit = !isDefault
    && (group.accountId === undefined || group.accountId === currentAccountId)

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return

    if (
      !mountedRef.current ||
      latestRef.current.currentAccountId !== initialAccountIdRef.current ||
      latestRef.current.groupId !== initialGroupIdRef.current
    ) {
      return
    }

    generationRef.current += 1
    const currentGeneration = generationRef.current

    setBusy(true)
    setError(null)

    const targetParentId = selectedParentId ? selectedParentId : null

    try {
      const updated = await window.origread.moveGroup(group.id, targetParentId)
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.groupId !== initialGroupIdRef.current
      ) {
        return
      }
      await latestRef.current.onSuccess(targetParentId, updated)
    } catch (reason) {
      if (
        !mountedRef.current ||
        generationRef.current !== currentGeneration ||
        latestRef.current.currentAccountId !== initialAccountIdRef.current ||
        latestRef.current.groupId !== initialGroupIdRef.current
      ) {
        return
      }
      setError(formatGroupOperationError(reason, t))
    } finally {
      if (mountedRef.current && generationRef.current === currentGeneration) {
        setBusy(false)
      }
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) {
            onClose()
          }
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose()
        }
      }}
    >
      <section
        className="source-dialog move-group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-group-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="move-group-title">{t('moveGroupTitle')}</h2>
            <p>{t('moveGroupDescription')}</p>
          </div>
          <button
            type="button"
            className="dialog-close"
            data-escape-close
            aria-label={t('close')}
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div className="dialog-field">
          <span>{t('groupName')}</span>
          <input value={group.name} disabled readOnly />
        </div>

        <label className="dialog-field">
          <span>{t('selectParentGroup')}</span>
          <select
            value={selectedParentId}
            disabled={busy || isDefault}
            onChange={(event) => {
              setSelectedParentId(event.target.value)
              setError(null)
            }}
          >
            <option value="">{t('rootGroup')}</option>
            {candidateGroups.map((candidate) => {
              const label = getGroupRecordDisplayPath(candidate, allGroups, t)
              return (
                <option key={candidate.id} value={candidate.id}>
                  {label}
                </option>
              )
            })}
          </select>
        </label>

        {isDefault ? (
          <div className="dialog-error" role="alert">
            {t('defaultGroupCannotMove')}
          </div>
        ) : error ? (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        ) : null}

        <footer className="dialog-footer">
          <span className="dialog-footer-spacer" />
          <button
            type="button"
            className="dialog-cancel"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="dialog-submit"
            disabled={busy || !canSubmit}
            onClick={() => void handleSave()}
          >
            {busy && <RefreshCw size={14} className="spinning" />}
            {t('move')}
          </button>
        </footer>
      </section>
    </div>
  )
}
