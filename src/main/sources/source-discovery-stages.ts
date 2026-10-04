

import type { SourceDiscoveryStage } from '../../shared/source-discovery'

import type { ProgressReporter, StageOutcome } from './source-discovery-types'

export function trackOutcome<T>(factory: () => Promise<T>): { settled: boolean; value: T | null } {
  const tracker = { settled: false, value: null as T | null }
  void factory()
    .then((value) => { tracker.value = value })
    .catch(() => undefined)
    .finally(() => { tracker.settled = true })
  return tracker
}

export function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 HTTP(S) 来源地址')
  return url.toString()
}

export async function withAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; message: string; externalSignal?: AbortSignal }
): Promise<T> {
  const { timeoutMs, message, externalSignal } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs)
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal
  try {
    externalSignal?.throwIfAborted()
    return await work(signal)
  } catch (error) {
    if (externalSignal?.aborted) throw abortReason(externalSignal, error)
    if (controller.signal.aborted) throw new Error(message)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function runStage<T>(
  work: () => Promise<T>,
  context: { stage: SourceDiscoveryStage; report: ProgressReporter; signal?: AbortSignal }
): Promise<StageOutcome<T>> {
  const { stage, report, signal } = context
  report(stage, 'running')
  try {
    signal?.throwIfAborted()
    return { value: await work(), error: null }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal, error)
    return { value: null, error: errorMessage(error) }
  } finally {
    report(stage, 'completed')
  }
}

/** 失败信息保留原异常，供发现界面与刷新汇总明确展示。 */
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  return signal.reason ?? fallback ?? new DOMException('Aborted', 'AbortError')
}
