export type LlmQuickMessageBuiltin = 'explain' | 'evidence'

export interface LlmQuickMessage {
  id: string
  title: string
  content: string
  enabled: boolean
  order: number
  builtin: LlmQuickMessageBuiltin | null
}

export interface LlmQuickMessageText {
  title: string
  content: string
}

export interface LlmQuickMessageContext {
  articleTitle: string
  articleUrl: string | null
  selection: string | null
  summary: string | null
}

export interface LlmQuickMessageResolution {
  content: string | null
  unavailableVariables: string[]
  unsupportedVariables: string[]
  ready: boolean
}

export const QUICK_MESSAGE_BUILTIN_IDS: Record<LlmQuickMessageBuiltin, string> = Object.freeze({
  explain: 'builtin:explain',
  evidence: 'builtin:evidence'
})

const BUILTIN_TEXT: Record<'zh' | 'en', Record<LlmQuickMessageBuiltin, LlmQuickMessageText>> = {
  zh: {
    explain: { title: '解释难点', content: '请解释这篇文章最难理解的部分，用更直白的方式说明。' },
    evidence: { title: '检查证据', content: '列出这篇文章支持主要结论的关键证据，并指出证据不足之处。' }
  },
  en: {
    explain: { title: 'Explain it', content: 'Explain the hardest parts of this article in clearer, more direct language.' },
    evidence: { title: 'Check evidence', content: 'List the key evidence supporting the article’s main conclusions and point out where the evidence is weak.' }
  }
}

export function resolveQuickMessageText(message: LlmQuickMessage, language: string): LlmQuickMessageText {
  if (!message.builtin) return { title: message.title, content: message.content }
  return { ...BUILTIN_TEXT[language.toLowerCase().startsWith('zh') ? 'zh' : 'en'][message.builtin] }
}

const QUICK_MESSAGE_VARIABLE = /\{\{([a-zA-Z0-9_]+)\}\}/g

export function resolveQuickMessageTemplate(template: string, context: LlmQuickMessageContext): LlmQuickMessageResolution {
  const values: Record<string, string> = {
    article_title: context.articleTitle.trim(),
    article_url: context.articleUrl?.trim() ?? '',
    selection: context.selection?.trim() ?? '',
    summary: context.summary?.trim() ?? ''
  }
  const requested = [...new Set([...template.matchAll(QUICK_MESSAGE_VARIABLE)].map((match) => match[1]!))]
  const unsupportedVariables = requested.filter((variable) => !(variable in values))
  const unavailableVariables = requested.filter((variable) => variable in values && !values[variable]!.trim())
  if (unsupportedVariables.length || unavailableVariables.length) {
    return { content: null, unsupportedVariables, unavailableVariables, ready: false }
  }
  let resolved = template
  for (const variable of requested) resolved = resolved.replaceAll(`{{${variable}}}`, values[variable]!)
  const content = resolved.trim() || null
  return { content, unsupportedVariables: [], unavailableVariables: [], ready: content !== null }
}
