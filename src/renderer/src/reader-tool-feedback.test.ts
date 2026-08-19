import { describe, expect, it } from 'vitest'
import { readerToolFeedback, unwrapElectronInvokeError } from './reader-tool-feedback'

describe('reader tool feedback', () => {
  it('strips Electron invoke wrappers from main-process errors', () => {
    expect(unwrapElectronInvokeError(new Error("Error invoking remote method 'ai:summary:generate': Error: AI 功能尚未启用"))).toBe('AI 功能尚未启用')
  })

  it('routes disabled AI summaries to AI settings', () => {
    expect(readerToolFeedback(new Error("Error invoking remote method 'ai:summary:generate': Error: AI 功能尚未启用"), 'ai')).toEqual({
      code: 'aiSetupRequired',
      settingsPage: 'ai'
    })
  })

  it('routes legacy ML Kit translation failures to Desktop translation settings', () => {
    expect(readerToolFeedback(new Error("Error invoking remote method 'translation:article:translate': Error: Google ML Kit 仅支持 Android，请在 Desktop 选择其他翻译服务"), 'translation')).toEqual({
      code: 'translationSetupRequired',
      settingsPage: 'translation'
    })
  })
})
