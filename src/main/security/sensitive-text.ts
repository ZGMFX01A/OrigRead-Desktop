const SENSITIVE_ASSIGNMENT = /\b(cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?([^\s,;"']+)/gi
const AUTHORIZATION_ASSIGNMENT = /\bauthorization\b\s*["']?\s*[:=]\s*["']?(?:(Bearer|Basic)\s+)?([^\s,;"']+)/gi

/** Redacts obvious credential-shaped values before text crosses into logs/Renderer-visible errors. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(AUTHORIZATION_ASSIGNMENT, (_match, scheme: string | undefined) => `Authorization=${scheme ? `${scheme} ` : ''}[redacted]`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, '$1 [redacted]')
    .replace(SENSITIVE_ASSIGNMENT, '$1=[redacted]')
}

/** Preserve cancellation identity; sanitize all other errors crossing a process/UI boundary. */
export function redactErrorForBoundary(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'AbortError') return error
  const raw = error instanceof Error ? error.message : String(error)
  const safe = new Error(redactSensitiveText(raw))
  if (error instanceof Error && error.name) safe.name = error.name
  return safe
}
