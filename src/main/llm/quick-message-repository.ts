import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  QUICK_MESSAGE_BUILTIN_IDS,
  resolveQuickMessageText,
  type LlmQuickMessage,
  type LlmQuickMessageBuiltin,
  type LlmQuickMessageText
} from '../../shared/llm-quick-message'

const SETTINGS_KEY = 'llm.quick-messages'
const BACKUP_KEY = 'llm.quick-messages.backup'
export const MAX_QUICK_MESSAGES = 100
export const MAX_QUICK_MESSAGE_TITLE_LENGTH = 80
export const MAX_QUICK_MESSAGE_CONTENT_LENGTH = 4_000

interface StoredMessage {
  id: string
  source: 'custom' | `builtin:${LlmQuickMessageBuiltin}`
  title: string
  content: string
  enabled: boolean
  order: number
}

export class LlmQuickMessageRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(): LlmQuickMessage[] {
    const primary = this.read(SETTINGS_KEY)
    if (primary) {
      const decoded = tryDecode(primary)
      if (decoded) return normalizeOrder(decoded)
    }
    const backup = this.read(BACKUP_KEY)
    const recovered = backup ? tryDecode(backup) : null
    return recovered ? normalizeOrder(recovered) : defaultMessages()
  }

  enabledMessages(): LlmQuickMessage[] {
    return this.current().filter((message) => message.enabled)
  }

  resolveText(message: LlmQuickMessage, language: string): LlmQuickMessageText {
    return resolveQuickMessageText(message, language)
  }

  create(title: string, content: string): LlmQuickMessage {
    validateDraft(title, content)
    const current = this.current()
    if (current.length >= MAX_QUICK_MESSAGES) throw new Error(`Quick Messages 已达到上限 ${MAX_QUICK_MESSAGES}`)
    const message: LlmQuickMessage = {
      id: randomUUID(),
      title: title.trim(),
      content: content.trim(),
      enabled: true,
      order: current.length,
      builtin: null
    }
    this.save([...current, message])
    return { ...message }
  }

  update(id: string, title: string, content: string): LlmQuickMessage[] {
    validateDraft(title, content)
    const current = this.current()
    if (!current.some((message) => message.id === id)) return current
    return this.save(current.map((message) => message.id === id
      ? { ...message, title: title.trim(), content: content.trim(), builtin: null }
      : message))
  }

  setEnabled(id: string, enabled: boolean): LlmQuickMessage[] {
    const current = this.current()
    if (!current.some((message) => message.id === id)) return current
    return this.save(current.map((message) => message.id === id ? { ...message, enabled } : message))
  }

  delete(id: string): LlmQuickMessage[] {
    return this.save(this.current().filter((message) => message.id !== id))
  }

  move(id: string, direction: -1 | 1): LlmQuickMessage[] {
    const current = normalizeOrder(this.current())
    const index = current.findIndex((message) => message.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= current.length) return current
    const reordered = [...current]
    const [item] = reordered.splice(index, 1)
    reordered.splice(target, 0, item!)
    return this.save(reordered)
  }

  exportBackupState(): string {
    return encode(this.current())
  }

  validateBackupState(raw: string): void {
    decode(raw)
  }

  restoreBackupState(raw: string): LlmQuickMessage[] {
    return this.save(decode(raw))
  }

  private save(messages: LlmQuickMessage[]): LlmQuickMessage[] {
    const normalized = normalizeOrder(messages)
    validateMessages(normalized)
    const encoded = encode(normalized)
    const previous = this.read(SETTINGS_KEY)
    this.database.exec('SAVEPOINT llm_quick_message_save')
    try {
      if (previous && tryDecode(previous)) this.write(BACKUP_KEY, previous)
      this.write(SETTINGS_KEY, encoded)
      this.database.exec('RELEASE SAVEPOINT llm_quick_message_save')
    } catch (error) {
      this.database.exec('ROLLBACK TO SAVEPOINT llm_quick_message_save')
      this.database.exec('RELEASE SAVEPOINT llm_quick_message_save')
      throw error
    }
    return normalized.map((message) => ({ ...message }))
  }

  private read(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private write(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(key, value, Date.now())
  }
}

function defaultMessages(): LlmQuickMessage[] {
  return (['explain', 'evidence'] as const).map((builtin, order) => ({
    id: QUICK_MESSAGE_BUILTIN_IDS[builtin],
    title: '',
    content: '',
    enabled: true,
    order,
    builtin
  }))
}

function normalizeOrder(messages: readonly LlmQuickMessage[]): LlmQuickMessage[] {
  return [...messages]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((message, order) => ({ ...message, order }))
}

function validateDraft(title: string, content: string): void {
  const normalizedTitle = title.trim()
  const normalizedContent = content.trim()
  if (!normalizedTitle) throw new Error('Quick Message 标题不能为空')
  if (!normalizedContent) throw new Error('Quick Message 内容不能为空')
  if (normalizedTitle.length > MAX_QUICK_MESSAGE_TITLE_LENGTH) throw new Error(`Quick Message 标题最多 ${MAX_QUICK_MESSAGE_TITLE_LENGTH} 个字符`)
  if (normalizedContent.length > MAX_QUICK_MESSAGE_CONTENT_LENGTH) throw new Error(`Quick Message 内容最多 ${MAX_QUICK_MESSAGE_CONTENT_LENGTH} 个字符`)
}

function validateMessages(messages: readonly LlmQuickMessage[]): void {
  if (messages.length > MAX_QUICK_MESSAGES) throw new Error(`Quick Messages 已达到上限 ${MAX_QUICK_MESSAGES}`)
  if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error('Quick Messages 包含重复 ID')
  for (const message of messages) {
    if (!message.id.trim()) throw new Error('Quick Message ID 不能为空')
    if (typeof message.enabled !== 'boolean' || !Number.isInteger(message.order) || message.order < 0) throw new Error('Quick Message 状态无效')
    if (message.builtin) {
      if (QUICK_MESSAGE_BUILTIN_IDS[message.builtin] !== message.id) throw new Error('Quick Message 内置类型无效')
    } else validateDraft(message.title, message.content)
  }
}

function encode(messages: readonly LlmQuickMessage[]): string {
  validateMessages(messages)
  const stored: StoredMessage[] = normalizeOrder(messages).map((message) => ({
    id: message.id,
    source: message.builtin ? `builtin:${message.builtin}` : 'custom',
    title: message.builtin ? '' : message.title,
    content: message.builtin ? '' : message.content,
    enabled: message.enabled,
    order: message.order
  }))
  return JSON.stringify(stored)
}

function decode(raw: string): LlmQuickMessage[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Quick Messages 不是有效 JSON') }
  if (!Array.isArray(parsed)) throw new Error('Quick Messages 状态无效')
  const messages = parsed.map((value, index): LlmQuickMessage => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Quick Message 状态无效')
    const record = value as Partial<StoredMessage>
    const source = record.source
    const builtin = source === 'builtin:explain' ? 'explain' : source === 'builtin:evidence' ? 'evidence' : source === 'custom' ? null : undefined
    if (builtin === undefined || typeof record.id !== 'string') throw new Error('Quick Message source 无效')
    return {
      id: record.id.trim(),
      title: builtin ? '' : typeof record.title === 'string' ? record.title.trim() : '',
      content: builtin ? '' : typeof record.content === 'string' ? record.content.trim() : '',
      enabled: record.enabled !== false,
      order: Number.isInteger(record.order) ? Number(record.order) : index,
      builtin
    }
  })
  validateMessages(messages)
  return normalizeOrder(messages)
}

function tryDecode(raw: string): LlmQuickMessage[] | null {
  try { return decode(raw) } catch { return null }
}
