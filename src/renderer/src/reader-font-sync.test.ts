import { describe, expect, it, vi } from 'vitest'
import type { ReaderFontEntry } from '../../shared/reader-font'
import { isCustomReaderFontId, resolveMissingCustomReaderFont } from './reader-font-sync'

const font: ReaderFontEntry = { id: 'custom:new', name: 'New', cssFamily: 'New', source: 'custom', dataUrl: 'origread-font://new' }
function setup(fontId: string, returnedFonts: ReaderFontEntry[] = [], currentFonts: ReaderFontEntry[] = []) {
  const state = { currentFonts, lastCheckedMissingFontId: null as string | null }
  const listReaderFonts = vi.fn(async () => returnedFonts)
  const onFallbackToDefault = vi.fn(async () => {})
  const onError = vi.fn()
  const onFontsUpdated = vi.fn((fonts: ReaderFontEntry[]) => { state.currentFonts = fonts })
  const check = async () => {
    const result = await resolveMissingCustomReaderFont({ fontId, ...state, listReaderFonts, onFallbackToDefault, onFontsUpdated, onError })
    state.lastCheckedMissingFontId = result.nextCheckedMissingFontId
    return result
  }
  return { state, check, listReaderFonts, onFallbackToDefault, onError, onFontsUpdated }
}

describe('missing custom reader fonts', () => {
  it('checks deleted fonts only once and falls back once across repeated checks', async () => {
    const fixture = setup('custom:deleted')
    expect(await fixture.check()).toEqual({ nextCheckedMissingFontId: 'custom:deleted', fetched: true, fellBack: true })
    for (let index = 0; index < 5; index += 1) expect(await fixture.check()).toEqual({ nextCheckedMissingFontId: 'custom:deleted', fetched: false, fellBack: false })
    expect(fixture.listReaderFonts).toHaveBeenCalledTimes(1)
    expect(fixture.onFallbackToDefault).toHaveBeenCalledTimes(1)
  })
  it('discovers a newly imported font and reuses the updated list', async () => {
    const fixture = setup(font.id, [font])
    expect(await fixture.check()).toEqual({ nextCheckedMissingFontId: null, fetched: true, fellBack: false })
    await fixture.check()
    expect(fixture.onFontsUpdated).toHaveBeenCalledWith([font])
    expect(fixture.listReaderFonts).toHaveBeenCalledTimes(1)
    expect(fixture.onFallbackToDefault).not.toHaveBeenCalled()
  })
  it('makes no IPC for built-in or already listed fonts', async () => {
    for (const id of ['system', 'serif', font.id]) {
      const fixture = setup(id, [], [font])
      expect(await fixture.check()).toEqual({ nextCheckedMissingFontId: null, fetched: false, fellBack: false })
      expect(fixture.listReaderFonts).not.toHaveBeenCalled()
    }
    expect(isCustomReaderFontId(null)).toBe(false)
    expect(isCustomReaderFontId(undefined)).toBe(false)
    expect(isCustomReaderFontId('custom:new')).toBe(true)
  })
  it('records IPC failure once and suppresses repeated retries', async () => {
    const fixture = setup('custom:broken')
    const error = new Error('IPC failed')
    fixture.listReaderFonts.mockRejectedValue(error)
    expect(await fixture.check()).toEqual({ nextCheckedMissingFontId: 'custom:broken', fetched: true, fellBack: false })
    await fixture.check()
    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(fixture.listReaderFonts).toHaveBeenCalledTimes(1)
    expect(fixture.onFallbackToDefault).not.toHaveBeenCalled()
  })
  it('records fallback persistence errors without retrying the IPC', async () => {
    const fixture = setup('custom:broken')
    fixture.onFallbackToDefault.mockRejectedValue(new Error('persist failed'))
    await fixture.check()
    await fixture.check()
    expect(fixture.onError).toHaveBeenCalledTimes(1)
    expect(fixture.listReaderFonts).toHaveBeenCalledTimes(1)
  })
})
