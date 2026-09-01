import { describe, expect, it } from 'vitest'
import { NETWORK_REQUEST_TIMEOUT_MS, requestSignal } from './request-policy'

describe('network request lifecycle policy', () => {
  it('keeps long generation, short search, health checks and translation on separate timeout budgets', () => {
    expect(NETWORK_REQUEST_TIMEOUT_MS.AI_STREAMING).toBeGreaterThan(NETWORK_REQUEST_TIMEOUT_MS.AI_COMPLETION)
    expect(NETWORK_REQUEST_TIMEOUT_MS.AI_COMPLETION).toBeGreaterThan(NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_FORCE)
    expect(NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_FORCE).toBeGreaterThan(NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_AUTO)
    expect(NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_HEALTH).toBe(NETWORK_REQUEST_TIMEOUT_MS.AI_PROVIDER_HEALTH)
    expect(NETWORK_REQUEST_TIMEOUT_MS.AI_MODEL_LIST).toBeGreaterThan(NETWORK_REQUEST_TIMEOUT_MS.AI_PROVIDER_HEALTH)
    expect(NETWORK_REQUEST_TIMEOUT_MS.TRANSLATION).toBeGreaterThan(NETWORK_REQUEST_TIMEOUT_MS.AI_PROVIDER_HEALTH)
    expect('MCP_HTTP' in NETWORK_REQUEST_TIMEOUT_MS).toBe(false)
  })

  it('preserves caller cancellation while adding a timeout signal', () => {
    const controller = new AbortController()
    const signal = requestSignal(controller.signal, 60_000)
    expect(signal.aborted).toBe(false)
    controller.abort(new Error('cancelled by caller'))
    expect(signal.aborted).toBe(true)
  })
})
