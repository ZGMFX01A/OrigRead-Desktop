/**
 * Network timeout policy is intentionally organized by request purpose rather than by
 * transport implementation. Node/Electron global fetch already owns the Undici dispatcher
 * and connection pool; callers should share that transport while keeping lifecycle semantics
 * separate so a short Search/health timeout can never leak into long AI generation.
 *
 * MCP HTTP is deliberately not listed here. Its protocol client owns session/reconnect/timeout
 * semantics and must not inherit generic fetch timeouts by accident when D6 is implemented.
 */
export const NETWORK_REQUEST_TIMEOUT_MS = {
  AI_STREAMING: 150_000,
  AI_COMPLETION: 60_000,
  AI_PROVIDER_HEALTH: 10_000,
  AI_MODEL_LIST: 20_000,
  /** AUTO must fail soft quickly enough that normal Chat does not feel blocked by Search. */
  DEDICATED_SEARCH_AUTO: 4_000,
  /** FORCE is an explicit user request and may wait longer before surfacing a required failure. */
  DEDICATED_SEARCH_FORCE: 12_000,
  /** Search provider health checks use the same adapter but remain a separate settings action. */
  DEDICATED_SEARCH_HEALTH: 10_000,
  TRANSLATION: 30_000
} as const

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
