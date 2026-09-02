import type { LlmToolCallRecord } from '../../shared/llm-chat'
import type { LlmToolActivityView } from '../../shared/llm-ipc'
import type { LlmToolDescriptor } from '../../shared/llm-tool'
import { redactSensitiveText } from '../security/sensitive-text'

const MAX_PREVIEW_CHARS = 4_000
const MAX_STRING_CHARS = 1_000
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 80
const MAX_DEPTH = 6
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i

export function buildLlmToolActivityView(record: LlmToolCallRecord, descriptor: LlmToolDescriptor | null): LlmToolActivityView {
  const argumentsPreview = safeJsonPreview(record.argumentsJson)
  const result = record.resultContent == null ? null : redactLlmToolPreviewText(record.resultContent)
  const error = record.errorMessage == null ? null : redactLlmToolPreviewText(record.errorMessage)
  return {
    toolCallId: record.id,
    assistantMessageId: record.assistantMessageId,
    toolId: record.toolId,
    name: descriptor?.name || record.apiName,
    description: descriptor?.description || '',
    source: descriptor?.source ?? 'MCP',
    sourceId: descriptor?.sourceId ?? null,
    risk: descriptor?.risk ?? 'WRITE',
    status: record.status,
    argumentsPreview: argumentsPreview.text,
    argumentsTruncated: argumentsPreview.truncated,
    resultPreview: result?.text ?? null,
    errorMessage: error?.text ?? null
  }
}

function safeJsonPreview(value: string): { text: string; truncated: boolean } {
  return redactLlmToolPreviewText(value)
}

export function redactLlmToolPreviewText(value: string, maxChars = MAX_PREVIEW_CHARS): { text: string; truncated: boolean } {
  try {
    const parsed = JSON.parse(value) as unknown
    const sanitized = sanitizeValue(parsed, 0)
    return boundedText(JSON.stringify(sanitized, null, 2), maxChars)
  } catch {
    return boundedText(redactSensitiveText(value), maxChars)
  }
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
    return items
  }
  if (typeof value !== 'object') return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1)
  }
  if (entries.length > MAX_OBJECT_KEYS) result['…'] = `[${entries.length - MAX_OBJECT_KEYS} more fields]`
  return result
}

function boundedText(value: string, maxChars = MAX_PREVIEW_CHARS): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, '\n')
  if (normalized.length <= maxChars) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, maxChars)}\n…`, truncated: true }
}
