import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupRecord } from '../../shared/library'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import {
  CreateGroupDialog,
  GroupContextMenu,
  GroupRenameDialog,
  MoveGroupDialog,
  getGroupRenameDisabledReason,
  isGroupRenameSupported
} from './GroupRenameDialog'

const roots = new Set<Root>()

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount())
  roots.clear()
  vi.unstubAllGlobals()
})

function setupDom() {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>')
  const win = dom.window as unknown as Window & typeof globalThis

  class KeyboardEventMock extends win.Event {
    key: string
    constructor(type: string, dict: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, { bubbles: dict.bubbles ?? true, cancelable: dict.cancelable ?? true })
      this.key = dict.key ?? ''
    }
  }

  class MouseEventMock extends win.Event {
    clientX: number
    clientY: number
    constructor(type: string, dict: { clientX?: number; clientY?: number; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, { bubbles: dict.bubbles ?? true, cancelable: dict.cancelable ?? true })
      this.clientX = dict.clientX ?? 0
      this.clientY = dict.clientY ?? 0
    }
  }

  ;(win as any).KeyboardEvent = KeyboardEventMock
  ;(win as any).MouseEvent = MouseEventMock
  ;(globalThis as any).KeyboardEvent = KeyboardEventMock
  ;(globalThis as any).MouseEvent = MouseEventMock

  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', { platform: 'Win32' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = win.document.getElementById('root')!
  const root = createRoot(container)
  roots.add(root)
  return { root, container, window: win }
}

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    id: 'grp-1',
    accountId: 1,
    name: 'Tech News',
    sortOrder: 1,
    isDefault: false,
    ...overrides
  }
}

function changeInput(input: HTMLInputElement, value: string) {
  input.value = value
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'))
  if (reactPropsKey && (input as any)[reactPropsKey]?.onChange) {
    (input as any)[reactPropsKey].onChange({ target: { value }, currentTarget: input })
  } else {
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
}

function changeSelect(select: HTMLSelectElement, value: string) {
  const reactPropsKey = Object.keys(select).find((key) => key.startsWith('__reactProps$'))
  if (reactPropsKey && (select as any)[reactPropsKey]?.onChange) {
    (select as any)[reactPropsKey].onChange({ target: { value }, currentTarget: { value } })
  }
}

describe('GroupContextMenu', () => {
  it('enables rename for a local non-default group and triggers onRename', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const group = makeGroup()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          isLocalAccount={true}
          style={{ left: 100, top: 200 }}
          onClose={onClose}
          onRename={onRename}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[role="menuitem"]')!
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(false)
    expect(container.querySelector('.context-menu-label')).toBeNull()

    await act(async () => {
      button.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('enables rename for default groups', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const defaultGroup = makeGroup({ isDefault: true })

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={defaultGroup}
          isLocalAccount={true}
          style={{ left: 0, top: 0 }}
          onClose={onClose}
          onRename={onRename}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[role="menuitem"]')!
    expect(button.disabled).toBe(false)
    const label = container.querySelector('.context-menu-label')
    expect(label).toBeNull()

    await act(async () => {
      button.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledOnce()
    expect(onRename).toHaveBeenCalledOnce()
  })

  it('disables rename for remote accounts with reason', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const group = makeGroup()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          isLocalAccount={false}
          style={{ left: 0, top: 0 }}
          onClose={onClose}
          onRename={onRename}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[role="menuitem"]')!
    expect(button.disabled).toBe(true)
    const label = container.querySelector('.context-menu-label')
    expect(label?.textContent).toBe('remoteGroupCannotRename')
  })

  it('triggers onRefresh when refresh button in context menu is clicked', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const onRefresh = vi.fn()
    const group = makeGroup()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          isLocalAccount={true}
          style={{ left: 0, top: 0 }}
          onClose={onClose}
          onRename={onRename}
          onRefresh={onRefresh}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    const refreshBtn = buttons.find((btn) => btn.textContent?.includes('refreshGroup'))
    expect(refreshBtn).toBeDefined()
    expect(refreshBtn?.disabled).toBe(false)

    await act(async () => {
      refreshBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalled()
  })

  it('renders remote group sync label and tooltip for remote account context menu', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const onRefresh = vi.fn()
    const group = makeGroup()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          isLocalAccount={false}
          style={{ left: 0, top: 0 }}
          onClose={onClose}
          onRename={onRename}
          onRefresh={onRefresh}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    const refreshBtn = buttons.find((btn) => btn.textContent?.includes('refreshRemoteGroup'))
    expect(refreshBtn).toBeDefined()
    expect(refreshBtn?.title).toBe('refreshRemoteGroupTooltip')
  })

  it('enables rename for GoogleReader and FreshRSS accounts', async () => {
    for (const accountType of ['google_reader', 'fresh_rss'] as const) {
      const { root, container } = setupDom()
      const onClose = vi.fn()
      const onRename = vi.fn()
      const group = makeGroup()

      await act(async () => {
        root.render(
          <GroupContextMenu
            group={group}
            accountType={accountType}
            isLocalAccount={false}
            style={{ left: 0, top: 0 }}
            onClose={onClose}
            onRename={onRename}
          />
        )
      })

      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      const renameBtn = buttons.find((btn) => btn.textContent?.includes('renameGroup'))
      expect(renameBtn).toBeDefined()
      expect(renameBtn?.disabled).toBe(false)
      expect(container.querySelector('.context-menu-label')).toBeNull()

      await act(async () => {
        renameBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
      })
      expect(onRename).toHaveBeenCalled()
    }
  })

  it('disables rename for Fever accounts with feverGroupCannotRename reason', async () => {
    const { root, container } = setupDom()
    const onClose = vi.fn()
    const onRename = vi.fn()
    const group = makeGroup()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          accountType="fever"
          isLocalAccount={false}
          style={{ left: 0, top: 0 }}
          onClose={onClose}
          onRename={onRename}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    const renameBtn = buttons.find((btn) => btn.textContent?.includes('renameGroup'))
    expect(renameBtn?.disabled).toBe(true)
    const label = container.querySelector('.context-menu-label')
    expect(label?.textContent).toBe('feverGroupCannotRename')

    await act(async () => {
      renameBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(onRename).not.toHaveBeenCalled()
  })
})

describe('GroupRenameDialog', () => {
  it('renders with initial group name and allows editing and saving', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Old Name' })
    const onClose = vi.fn()
    const onSuccess = vi.fn()
    const updatedRecord = { ...group, name: 'New Name' }

    const renameGroupMock = vi.fn().mockResolvedValue(updatedRecord)
    ;(window as any).origread = { renameGroup: renameGroupMock }

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input')!
    expect(input.value).toBe('Old Name')

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    expect(submitBtn.disabled).toBe(false)

    // Change to new name
    await act(async () => {
      changeInput(input, 'New Name')
    })
    expect(input.value).toBe('New Name')

    // Click save
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(renameGroupMock).toHaveBeenCalledWith('grp-1', 'New Name')
    expect(onSuccess).toHaveBeenCalledWith(updatedRecord)
  })

  it('validates name length (empty/whitespace disabled, > 200 disabled)', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Initial' })
    ;(window as any).origread = { renameGroup: vi.fn() }

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    // Empty
    await act(async () => {
      changeInput(input, '   ')
    })
    expect(submitBtn.disabled).toBe(true)

    // Over 200 chars
    await act(async () => {
      changeInput(input, 'a'.repeat(201))
    })
    expect(submitBtn.disabled).toBe(true)

    // Valid
    await act(async () => {
      changeInput(input, 'Valid Group')
    })
    expect(submitBtn.disabled).toBe(false)
  })

  it('allows default group editing and still blocks unsupported remote categories', async () => {
    const { root, container } = setupDom()
    const defaultGroup = makeGroup({ isDefault: true })
    ;(window as any).origread = { renameGroup: vi.fn() }

    // Test default group
    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={defaultGroup}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    let input = container.querySelector<HTMLInputElement>('input')!
    let submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    let error = container.querySelector('.dialog-error')!

    expect(input.disabled).toBe(false)
    expect(submitBtn.disabled).toBe(false)
    expect(error).toBeNull()

    // Test remote account
    const normalGroup = makeGroup()
    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={normalGroup}
          isLocalAccount={false}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    input = container.querySelector<HTMLInputElement>('input')!
    submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    error = container.querySelector('.dialog-error')!

    expect(input.disabled).toBe(true)
    expect(submitBtn.disabled).toBe(true)
    expect(error.textContent).toBe('remoteGroupCannotRename')
  })

  it.each([['Network error', 'Network error'], ['分组名称已存在', 'groupNameExists']])('shows the localized or original API error %s and allows retry', async (message, expected) => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Old' })
    const renameGroupMock = vi.fn().mockRejectedValue(new Error(message))
    ;(window as any).origread = { renameGroup: renameGroupMock }

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    const error = container.querySelector('.dialog-error')
    expect(error?.textContent).toBe(expected)
    expect(submitBtn.disabled).toBe(false)
  })

  it('guards duplicate submissions and locks buttons while busy', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Old' })
    let resolveRename: (res: GroupRecord) => void = () => {}
    const renamePromise = new Promise<GroupRecord>((resolve) => {
      resolveRename = resolve
    })
    const renameGroupMock = vi.fn().mockReturnValue(renamePromise)
    ;(window as any).origread = { renameGroup: renameGroupMock }
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={vi.fn()}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    const closeBtn = container.querySelector<HTMLButtonElement>('.dialog-close')!
    const cancelBtn = container.querySelector<HTMLButtonElement>('.dialog-cancel')!
    const backdrop = container.querySelector<HTMLDivElement>('.dialog-backdrop')!
    const input = container.querySelector<HTMLInputElement>('input')!

    // First click triggers busy
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(renameGroupMock).toHaveBeenCalledTimes(1)
    expect(submitBtn.disabled).toBe(true)
    expect(closeBtn.disabled).toBe(true)
    expect(cancelBtn.disabled).toBe(true)
    expect(input.disabled).toBe(true)

    // Second click during busy ignored
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(renameGroupMock).toHaveBeenCalledTimes(1)

    // Enter in input during busy ignored
    await act(async () => {
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      input.dispatchEvent(enterEvent)
    })
    expect(renameGroupMock).toHaveBeenCalledTimes(1)

    // Backdrop click during busy does not close
    await act(async () => {
      backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    // Escape during busy does not close
    await act(async () => {
      const escEvent = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      window.dispatchEvent(escEvent)
    })
    expect(onClose).not.toHaveBeenCalled()

    // Resolve promise
    await act(async () => {
      resolveRename({ ...group, name: 'Renamed' })
    })
  })

  it('discards response if unmounted during in-flight rename', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Old' })
    let resolveRename: (res: GroupRecord) => void = () => {}
    const renamePromise = new Promise<GroupRecord>((resolve) => {
      resolveRename = resolve
    })
    const renameGroupMock = vi.fn().mockReturnValue(renamePromise)
    ;(window as any).origread = { renameGroup: renameGroupMock }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    // Unmount before resolve
    await act(async () => {
      root.unmount()
      roots.delete(root)
    })

    // Resolve now
    await act(async () => {
      resolveRename({ ...group, name: 'Renamed' })
    })

    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('discards response if account changes during in-flight rename', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ name: 'Old' })
    let resolveRename: (res: GroupRecord) => void = () => {}
    const renamePromise = new Promise<GroupRecord>((resolve) => {
      resolveRename = resolve
    })
    const renameGroupMock = vi.fn().mockReturnValue(renamePromise)
    ;(window as any).origread = { renameGroup: renameGroupMock }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    // Change currentAccountId prop
    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={2}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    // Resolve now
    await act(async () => {
      resolveRename({ ...group, name: 'Renamed' })
    })

    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('handles Escape key, cancel button, close button and backdrop click', async () => {
    const { root, container } = setupDom()
    const group = makeGroup()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          isLocalAccount={true}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={vi.fn()}
        />
      )
    })

    // 1. Close button
    const closeBtn = container.querySelector<HTMLButtonElement>('.dialog-close')!
    await act(async () => {
      closeBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    // 2. Cancel button
    const cancelBtn = container.querySelector<HTMLButtonElement>('.dialog-cancel')!
    await act(async () => {
      cancelBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)

    // 3. Backdrop click
    const backdrop = container.querySelector<HTMLDivElement>('.dialog-backdrop')!
    await act(async () => {
      backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(3)

    // 4. Escape key
    const onUnderlyingKeyDown = vi.fn()
    window.addEventListener('keydown', onUnderlyingKeyDown)
    await act(async () => {
      const escEvent = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      container.querySelector('input')!.dispatchEvent(escEvent)
    })
    window.removeEventListener('keydown', onUnderlyingKeyDown)
    expect(onClose).toHaveBeenCalledTimes(4)
    expect(onUnderlyingKeyDown).not.toHaveBeenCalled()
  })

  it('allows remote rename for GoogleReader and FreshRSS with migration to new group ID', async () => {
    for (const accountType of ['google_reader', 'fresh_rss'] as const) {
      const { root, container } = setupDom()
      const group = makeGroup({ id: '1:user/-/label/OldGroup', name: 'OldGroup' })
      const onClose = vi.fn()
      const onSuccess = vi.fn()
      const updatedRecord = { ...group, id: '1:user/-/label/NewGroup', name: 'NewGroup' }

      const renameGroupMock = vi.fn().mockResolvedValue(updatedRecord)
      ;(window as any).origread = { renameGroup: renameGroupMock }

      await act(async () => {
        root.render(
          <GroupRenameDialog
            group={group}
            accountType={accountType}
            isLocalAccount={false}
            currentAccountId={1}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        )
      })

      const input = container.querySelector<HTMLInputElement>('input')!
      const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

      expect(input.disabled).toBe(false)
      expect(submitBtn.disabled).toBe(false)
      expect(container.querySelector('.dialog-error')).toBeNull()

      await act(async () => {
        changeInput(input, 'NewGroup')
      })

      await act(async () => {
        submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
      })

      expect(renameGroupMock).toHaveBeenCalledWith('1:user/-/label/OldGroup', 'NewGroup')
      expect(onSuccess).toHaveBeenCalledWith(updatedRecord)
    }
  })

  it('disables editing and submit for Fever account with feverGroupCannotRename', async () => {
    const { root, container } = setupDom()
    const group = makeGroup()
    ;(window as any).origread = { renameGroup: vi.fn() }

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          accountType="fever"
          isLocalAccount={false}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    const error = container.querySelector('.dialog-error')!

    expect(input.disabled).toBe(true)
    expect(submitBtn.disabled).toBe(true)
    expect(error.textContent).toBe('feverGroupCannotRename')
  })

  it('displays accurate message when remote rename succeeds but subsequent sync fails', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ id: '1:user/-/label/Tech', name: 'Tech' })
    const syncErrorMessage = '分组重命名远端已成功，但后续同步失败：网络连接超时'
    const renameGroupMock = vi.fn().mockRejectedValue(new Error(syncErrorMessage))
    ;(window as any).origread = { renameGroup: renameGroupMock }

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          accountType="google_reader"
          isLocalAccount={false}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    await act(async () => {
      changeInput(input, 'Tech Updated')
    })

    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    const error = container.querySelector('.dialog-error')
    expect(error?.textContent).toBe('groupRenameSyncFailed')
    expect(input.value).toBe('Tech Updated')
    expect(submitBtn.disabled).toBe(false)
  })

  it('discards remote rename response when account switches in-flight and does not call onSuccess', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ id: '1:user/-/label/Tech', name: 'Tech' })
    let resolveRename: (res: GroupRecord) => void = () => {}
    const renamePromise = new Promise<GroupRecord>((resolve) => {
      resolveRename = resolve
    })
    const renameGroupMock = vi.fn().mockReturnValue(renamePromise)
    ;(window as any).origread = { renameGroup: renameGroupMock }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          accountType="google_reader"
          isLocalAccount={false}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    // Simulate account switch to account 2
    await act(async () => {
      root.render(
        <GroupRenameDialog
          group={group}
          accountType="google_reader"
          isLocalAccount={false}
          currentAccountId={2}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    // Remote call finally resolves
    await act(async () => {
      resolveRename({ ...group, id: '1:user/-/label/NewTech', name: 'NewTech' })
    })

    // Response must not be applied to Account 2
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe('isGroupRenameSupported and getGroupRenameDisabledReason', () => {
  it('correctly reports supported and unsupported account types', () => {
    expect(isGroupRenameSupported('local')).toBe(true)
    expect(isGroupRenameSupported('google_reader')).toBe(true)
    expect(isGroupRenameSupported('fresh_rss')).toBe(true)
    expect(isGroupRenameSupported('fever')).toBe(false)
    expect(isGroupRenameSupported(undefined, true)).toBe(true)
    expect(isGroupRenameSupported(undefined, false)).toBe(false)
  })

  it('returns appropriate disabled reasons', () => {
    const t = (k: string) => k
    const defaultGroup = makeGroup({ isDefault: true })
    const normalGroup = makeGroup({ isDefault: false })

    expect(getGroupRenameDisabledReason(defaultGroup, 'google_reader', false, t)).toBeNull()
    expect(getGroupRenameDisabledReason(defaultGroup, 'fever', false, t)).toBeNull()
    expect(getGroupRenameDisabledReason(normalGroup, 'fever', false, t)).toBe('feverGroupCannotRename')
    expect(getGroupRenameDisabledReason(normalGroup, 'google_reader', false, t)).toBeNull()
    expect(getGroupRenameDisabledReason(normalGroup, 'fresh_rss', false, t)).toBeNull()
    expect(getGroupRenameDisabledReason(normalGroup, 'local', true, t)).toBeNull()
    expect(getGroupRenameDisabledReason(normalGroup, undefined, false, t)).toBe('remoteGroupCannotRename')
  })
})

describe('GroupContextMenu hierarchy items (C4)', () => {
  it('renders create subgroup and move group buttons for local account', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ isDefault: false })
    const onCreateSubgroup = vi.fn()
    const onMoveGroup = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          accountType="local"
          style={{}}
          onClose={onClose}
          onRename={vi.fn()}
          onCreateSubgroup={onCreateSubgroup}
          onMoveGroup={onMoveGroup}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    const createBtn = buttons.find((btn) => btn.textContent?.includes('createSubgroup'))
    const moveBtn = buttons.find((btn) => btn.textContent?.includes('moveGroup'))

    expect(createBtn).toBeDefined()
    expect(moveBtn).toBeDefined()
    expect(createBtn?.disabled).toBe(false)
    expect(moveBtn?.disabled).toBe(false)

    await act(async () => {
      createBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalled()
    expect(onCreateSubgroup).toHaveBeenCalled()

    await act(async () => {
      moveBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(onMoveGroup).toHaveBeenCalled()
  })

  it('hides create subgroup and move group buttons for remote accounts', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ isDefault: false })

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={group}
          accountType="google_reader"
          style={{}}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onCreateSubgroup={vi.fn()}
          onMoveGroup={vi.fn()}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    const createBtn = buttons.find((btn) => btn.textContent?.includes('createSubgroup'))
    const moveBtn = buttons.find((btn) => btn.textContent?.includes('moveGroup'))

    expect(createBtn).toBeUndefined()
    expect(moveBtn).toBeUndefined()
  })

  it('disables hierarchy buttons for default group and prevents clicks', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const defaultGroup = makeGroup({ isDefault: true })
    const onCreateSubgroup = vi.fn()
    const onMoveGroup = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <GroupContextMenu
          group={defaultGroup}
          accountType="local"
          style={{}}
          onClose={onClose}
          onRename={vi.fn()}
          onCreateSubgroup={onCreateSubgroup}
          onMoveGroup={onMoveGroup}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    const createBtn = buttons.find((btn) => btn.textContent?.includes('createSubgroup'))
    const moveBtn = buttons.find((btn) => btn.textContent?.includes('moveGroup'))

    expect(createBtn?.disabled).toBe(true)
    expect(moveBtn?.disabled).toBe(true)

    await act(async () => {
      createBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
      moveBtn?.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(onCreateSubgroup).not.toHaveBeenCalled()
    expect(onMoveGroup).not.toHaveBeenCalled()
  })
})

describe('CreateGroupDialog (C4)', () => {
  it('submits addGroup with trimmed name and parentId on save', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const parent = makeGroup({ id: 'parent-1', name: 'Parent Group' })
    const addGroupMock = vi.fn().mockResolvedValue([parent, { id: 'child-1', name: 'Sub', parentId: 'parent-1' }])
    ;(window as any).origread = { addGroup: addGroupMock }
    const onSuccess = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[placeholder="groupNamePlaceholder"]')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    expect(submitBtn.disabled).toBe(true)

    await act(async () => {
      changeInput(input, '  New Subgroup  ')
    })
    expect(submitBtn.disabled).toBe(false)

    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    expect(addGroupMock).toHaveBeenCalledWith('New Subgroup', 'parent-1')
    expect(onSuccess).toHaveBeenCalledWith('parent-1', expect.any(Array))
  })

  it('displays full parent path when allGroups is provided (C4b)', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const grandParent = makeGroup({ id: 'grandparent', name: 'GrandParent' })
    const parent = makeGroup({ id: 'parent-1', name: 'Parent', parentId: 'grandparent' })
    const allGroups = [grandParent, parent]

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          allGroups={allGroups}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const parentInput = container.querySelector<HTMLInputElement>('.dialog-field input[disabled]')!
    expect(parentInput.value).toBe('GrandParent / Parent')
  })

  it('closes on Escape key press when not busy', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const parent = makeGroup({ id: 'parent-1' })
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={vi.fn()}
        />
      )
    })

    const backdrop = container.querySelector<HTMLDivElement>('.dialog-backdrop')!
    await act(async () => {
      backdrop.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('isolates concurrent account switch during addGroup response', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const parent = makeGroup({ id: 'parent-1', accountId: 1 })
    let resolveAdd!: (val: any) => void
    const addPromise = new Promise((resolve) => {
      resolveAdd = resolve
    })
    ;(window as any).origread = { addGroup: vi.fn().mockReturnValue(addPromise) }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[placeholder="groupNamePlaceholder"]')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    await act(async () => {
      changeInput(input, 'Valid Sub')
    })

    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    // Switch account to 2 before IPC completes
    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={2}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    await act(async () => {
      resolveAdd([parent])
    })

    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('displays error message when addGroup fails', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const parent = makeGroup({ id: 'parent-1' })
    ;(window as any).origread = { addGroup: vi.fn().mockRejectedValue(new Error('名称重复')) }

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[placeholder="groupNamePlaceholder"]')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    await act(async () => {
      changeInput(input, 'Existing')
    })

    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    const errorAlert = container.querySelector<HTMLDivElement>('.dialog-error')
    expect(errorAlert?.textContent).toContain('名称重复')
  })

  it('disables submit when input exceeds 200 chars', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const parent = makeGroup({ id: 'parent-1' })

    await act(async () => {
      root.render(
        <CreateGroupDialog
          parentGroup={parent}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[placeholder="groupNamePlaceholder"]')!
    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!

    await act(async () => {
      changeInput(input, 'a'.repeat(201))
    })
    expect(submitBtn.disabled).toBe(true)
  })
})

describe('MoveGroupDialog (C4)', () => {
  it('excludes itself, all descendants, and default groups from parent options', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ id: 'target', name: 'Target' })
    const child = makeGroup({ id: 'child', name: 'Child', parentId: 'target' })
    const grandChild = makeGroup({ id: 'grandchild', name: 'GrandChild', parentId: 'child' })
    const sibling = makeGroup({ id: 'sibling', name: 'Sibling' })
    const defGroup = makeGroup({ id: '__ungrouped__', name: 'Default', isDefault: true })

    const allGroups = [group, child, grandChild, sibling, defGroup]

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={group}
          allGroups={allGroups}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const select = container.querySelector<HTMLSelectElement>('select')!
    const options = Array.from(select.querySelectorAll('option'))

    // Should include root option ("") and sibling, but NOT target, child, grandchild, or default
    const values = options.map((opt) => opt.value)
    expect(values).toContain('')
    expect(values).toContain('sibling')
    expect(values).not.toContain('target')
    expect(values).not.toContain('child')
    expect(values).not.toContain('grandchild')
    expect(values).not.toContain('__ungrouped__')
  })

  it('renders full path in candidate options distinguishing same-name groups across parents (C4b)', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const target = makeGroup({ id: 'target', name: 'Target' })
    const parentA = makeGroup({ id: 'pA', name: 'Section A' })
    const parentB = makeGroup({ id: 'pB', name: 'Section B' })
    const childA = makeGroup({ id: 'childA', name: 'Common', parentId: 'pA' })
    const childB = makeGroup({ id: 'childB', name: 'Common', parentId: 'pB' })
    const slashRoot = makeGroup({ id: 'slashRoot', name: 'A / B' })

    const allGroups = [target, parentA, parentB, childA, childB, slashRoot]

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={target}
          allGroups={allGroups}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const select = container.querySelector<HTMLSelectElement>('select')!
    const options = Array.from(select.querySelectorAll('option'))

    const childAOpt = options.find((opt) => opt.value === 'childA')
    const childBOpt = options.find((opt) => opt.value === 'childB')
    const slashRootOpt = options.find((opt) => opt.value === 'slashRoot')

    expect(childAOpt?.textContent).toBe('Section A / Common')
    expect(childBOpt?.textContent).toBe('Section B / Common')
    expect(slashRootOpt?.textContent).toBe('A \\/ B')
  })

  it('moves group to root and calls onSuccess with null parentId', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ id: 'target', name: 'Target', parentId: 'some-parent' })
    const sibling = makeGroup({ id: 'sibling', name: 'Sibling' })
    const moveGroupMock = vi.fn().mockResolvedValue({ ...group, parentId: null })
    ;(window as any).origread = { moveGroup: moveGroupMock }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={group}
          allGroups={[group, sibling]}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const select = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      changeSelect(select, '')
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    expect(moveGroupMock).toHaveBeenCalledWith('target', null)
    expect(onSuccess).toHaveBeenCalledWith(null, expect.objectContaining({ id: 'target', parentId: null }))
  })

  it('moves group to another valid parent', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ id: 'target', name: 'Target' })
    const otherParent = makeGroup({ id: 'other-parent', name: 'Other Parent' })
    const moveGroupMock = vi.fn().mockResolvedValue({ ...group, parentId: 'other-parent' })
    ;(window as any).origread = { moveGroup: moveGroupMock }
    const onSuccess = vi.fn()

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={group}
          allGroups={[group, otherParent]}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      )
    })

    const select = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      changeSelect(select, 'other-parent')
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    expect(moveGroupMock).toHaveBeenCalledWith('target', 'other-parent')
    expect(onSuccess).toHaveBeenCalledWith('other-parent', expect.objectContaining({ parentId: 'other-parent' }))
  })

  it('prevents moving default group', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const defGroup = makeGroup({ id: '__ungrouped__', isDefault: true })
    const other = makeGroup({ id: 'other' })
    const moveGroupMock = vi.fn()
    ;(window as any).origread = { moveGroup: moveGroupMock }

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={defGroup}
          allGroups={[defGroup, other]}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    expect(submitBtn.disabled).toBe(true)

    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    expect(moveGroupMock).not.toHaveBeenCalled()
  })

  it('closes on Escape key press when not busy', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ id: 'target' })
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={group}
          allGroups={[group]}
          currentAccountId={1}
          onClose={onClose}
          onSuccess={vi.fn()}
        />
      )
    })

    const backdrop = container.querySelector<HTMLDivElement>('.dialog-backdrop')!
    await act(async () => {
      backdrop.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('displays error message when moveGroup fails', async () => {
    const { container, root } = setupDom()
    roots.add(root)
    const group = makeGroup({ id: 'target' })
    ;(window as any).origread = { moveGroup: vi.fn().mockRejectedValue(new Error('移动分组失败')) }

    await act(async () => {
      root.render(
        <MoveGroupDialog
          group={group}
          allGroups={[group]}
          currentAccountId={1}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      )
    })

    const submitBtn = container.querySelector<HTMLButtonElement>('.dialog-submit')!
    await act(async () => {
      submitBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }))
    })

    const errorAlert = container.querySelector<HTMLDivElement>('.dialog-error')
    expect(errorAlert?.textContent).toContain('移动分组失败')
  })
})


describe('CreateGroupDialog root groups', () => {
  it('creates a root group without a parent and reports the refreshed catalog', async () => {
    const { root, container } = setupDom()
    const groups = [makeGroup({ name: 'Work', parentId: null })]
    const addGroup = vi.fn().mockResolvedValue(groups)
    ;(window as any).origread = { addGroup }
    const onSuccess = vi.fn()
    await act(async () => root.render(<CreateGroupDialog parentGroup={null} currentAccountId={1} onClose={vi.fn()} onSuccess={onSuccess} />))
    expect(container.querySelector('h2')?.textContent).toBe('addGroup')
    expect(container.querySelectorAll('input')).toHaveLength(1)
    await act(async () => { changeInput(container.querySelector('input')!, ' Work ') })
    await act(async () => { container.querySelector('.dialog-submit')!.dispatchEvent(new window.Event('click', { bubbles: true })) })
    expect(addGroup).toHaveBeenCalledWith('Work', null)
    expect(onSuccess).toHaveBeenCalledWith(null, groups)
  })

  it('saves a default group name through the same rename dialog', async () => {
    const { root, container } = setupDom()
    const group = makeGroup({ id: '__ungrouped__', isDefault: true })
    const updated = { ...group, name: 'Personal' }
    const renameGroup = vi.fn().mockResolvedValue(updated)
    ;(window as any).origread = { renameGroup }
    const onSuccess = vi.fn()
    await act(async () => root.render(<GroupRenameDialog group={group} accountType="fever" currentAccountId={1} onClose={vi.fn()} onSuccess={onSuccess} />))
    await act(async () => { changeInput(container.querySelector('input')!, ' Personal ') })
    await act(async () => { container.querySelector('.dialog-submit')!.dispatchEvent(new window.Event('click', { bubbles: true })) })
    expect(renameGroup).toHaveBeenCalledWith(group.id, 'Personal')
    expect(onSuccess).toHaveBeenCalledWith(updated)
  })
})
