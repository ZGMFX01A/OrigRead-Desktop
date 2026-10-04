import { setTimeout } from 'node:timers/promises'
import type { SnapshotJobStatus } from './sync-snapshot-jobs'

/** 短请求轮询固定身份，受理与完成分开；普通 HTTP 请求超时保持原配置。 */
export async function pollSnapshotJob(input: { initial: SnapshotJobStatus; status(): Promise<SnapshotJobStatus>; signal?: AbortSignal }): Promise<void> {
  const identity = input.initial
  let current = identity
  while (['RUNNING', 'CANCELLING'].includes(current.state)) {
    await setTimeout(POLL_INTERVAL_MS, undefined, { signal: input.signal })
    current = await input.status()
    if (current.snapshotBundleId !== identity.snapshotBundleId || current.rootHash !== identity.rootHash || current.generation !== identity.generation) {
      throw new Error('SNAPSHOT_JOB_CONFLICT: polled executor identity changed')
    }
  }
  if (current.state !== 'COMPLETED') throw new Error(`SNAPSHOT_JOB_${current.state}: ${current.error ?? current.phase}`)
}

/** 状态请求间隔遵循协议的正常轮询节奏。 */
const POLL_INTERVAL_MS = 1_500
