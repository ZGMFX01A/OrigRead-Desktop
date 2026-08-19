export type ReaderToolFeedbackCode =
  | 'aiSetupRequired'
  | 'translationSetupRequired'
  | 'translationAiSetupRequired'
  | 'aiSummaryNoContent'
  | 'translationNoContent'
  | 'serviceAuthenticationFailed'
  | 'serviceRateLimited'
  | 'serviceTimeout'
  | 'aiSummaryFailedFriendly'
  | 'translationFailedFriendly'

export type ReaderToolSettingsPage = 'ai' | 'translation'

export interface ReaderToolFeedback {
  code: ReaderToolFeedbackCode
  settingsPage?: ReaderToolSettingsPage
}

export function readerToolFeedback(error: unknown, tool: 'ai' | 'translation'): ReaderToolFeedback {
  const message = unwrapElectronInvokeError(error)

  if (tool === 'ai') {
    if (/AI 功能尚未启用|AI Provider 尚未完成配置|AI Provider 尚未选择模型|所选 AI Provider 不可用|所选模型不属于当前 AI Provider/i.test(message)) {
      return { code: 'aiSetupRequired', settingsPage: 'ai' }
    }
    if (/当前文章没有可用于摘要的正文|文章不存在/i.test(message)) return { code: 'aiSummaryNoContent' }
  } else {
    if (/Google ML Kit|ML Kit|当前翻译服务已停用|翻译服务配置不存在|尚未填写 Endpoint|尚未填写 API Key/i.test(message)) {
      return { code: 'translationSetupRequired', settingsPage: 'translation' }
    }
    if (/请先启用 AI 阅读|所选 AI 服务或模型尚未完成配置|AI 服务不存在/i.test(message)) {
      return { code: 'translationAiSetupRequired', settingsPage: 'ai' }
    }
    if (/当前文章没有可翻译正文|文章不存在/i.test(message)) return { code: 'translationNoContent' }
  }

  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i.test(message)) {
    return { code: 'serviceAuthenticationFailed', settingsPage: tool === 'ai' ? 'ai' : 'translation' }
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return { code: 'serviceRateLimited' }
  if (/timeout|timed out|aborted due to timeout|ETIMEDOUT/i.test(message)) return { code: 'serviceTimeout' }

  return { code: tool === 'ai' ? 'aiSummaryFailedFriendly' : 'translationFailedFriendly' }
}

export function unwrapElectronInvokeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  message = message.replace(/^Error:\s*/i, '')
  return message.trim()
}
