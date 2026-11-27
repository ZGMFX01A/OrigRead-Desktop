import { EventEmitter } from 'node:events'
import { shell, dialog } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { OriginalArticleViewController, validateOriginalViewBounds } from './original-article-view-controller'

describe('validateOriginalViewBounds', () => {
  it('rounds finite renderer CSS-pixel bounds', () => {
    expect(validateOriginalViewBounds({ x: 420.4, y: 56.2, width: 900.6, height: 700.3 })).toEqual({
      x: 420,
      y: 56,
      width: 901,
      height: 700
    })
  })

  it('rejects malformed IPC bounds', () => {
    expect(() => validateOriginalViewBounds({ x: 0, y: 0, width: '900', height: 700 })).toThrow(TypeError)
  })
})


vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      session: Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn() }),
      setUserAgent: vi.fn(), setAudioMuted: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined), isDestroyed: () => false, close: vi.fn()
    })
    setBounds = vi.fn()
  }
}))

describe('original article downloads', () => {
  it.each([false, true])('opens an HTTP download only after confirmation (%s)', async (confirmed) => {
    vi.mocked(shell.openExternal).mockClear()
    let view: { webContents: EventEmitter & { session: EventEmitter } } | undefined
    const window = { contentView: { addChildView: (value: typeof view) => { view = value }, removeChildView: vi.fn() }, getContentSize: () => [1000, 800] }
    const confirm = vi.fn(async () => confirmed)
    const controller = new OriginalArticleViewController(window as never, undefined, confirm)
    controller.open('https://example.com/article', { x: 0, y: 0, width: 900, height: 700 })
    const preventDefault = vi.fn()
    view!.webContents.session.emit('will-download', { preventDefault }, { getURL: () => 'https://example.com/file.zip' }, view!.webContents)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('https://example.com/file.zip'))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenCalledTimes(confirmed ? 1 : 0)
    if (confirmed) expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/file.zip')
    vi.mocked(shell.openExternal).mockClear()
    confirm.mockClear()
    view!.webContents.session.emit('will-download', { preventDefault }, { getURL: () => 'javascript:evil()' }, view!.webContents)
    expect(confirm).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
    controller.dispose()
    expect(view!.webContents.session.listenerCount('will-download')).toBe(0)
  })

  it('uses a cancel-by-default dialog when no confirmation is injected', async () => {
    vi.mocked(shell.openExternal).mockClear()
    let view: { webContents: EventEmitter & { session: EventEmitter } } | undefined
    const window = { contentView: { addChildView: (value: typeof view) => { view = value }, removeChildView: vi.fn() }, getContentSize: () => [1000, 800] }
    const controller = new OriginalArticleViewController(window as never)
    controller.open('https://example.com/article', { x: 0, y: 0, width: 900, height: 700 })
    view!.webContents.session.emit('will-download', { preventDefault: vi.fn() }, { getURL: () => 'https://example.com/file.zip' }, view!.webContents)
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalled())
    expect((vi.mocked(dialog.showMessageBox).mock.calls.at(-1) as unknown as [unknown, unknown])[1]).toMatchObject({ defaultId: 0, cancelId: 0 })
    expect(shell.openExternal).not.toHaveBeenCalled()
    controller.dispose()
  })
})
