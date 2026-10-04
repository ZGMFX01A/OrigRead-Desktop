import { snapshotTraceIdentity } from './sync-snapshot-trace'
import { Worker } from 'node:worker_threads'
import type { DesktopGenesisCut } from './sync-runtime-coordinator'
import { snapshotCancellationBuffer, snapshotCheckpoint } from './sync-snapshot-execution'

interface Input { path: string; userData: string; blobRoot: string; cut: DesktopGenesisCut;
  bundleId: string; account: number; now: number; signal?: AbortSignal }

/** 请求等待者不会代替工作线程退出；取消先通知实际循环，再等待 SQLite 连接关闭。 */
export function convertFrozenSnapshotSource(input: Input): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancellation = snapshotCancellationBuffer() ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    snapshotCheckpoint()
    const cancel = () => Atomics.store(new Int32Array(cancellation), 0, 1)
    input.signal?.addEventListener('abort', cancel)
    if (input.signal?.aborted) cancel()
    let worker: Worker
    try {
      const { signal: _signal, ...source } = input
      worker = new Worker(new URL('./sync-snapshot-capture-worker.js', import.meta.url), { workerData: { ...source, cancellation, trace: snapshotTraceIdentity() } })
    } catch (error) {
      // 启动失败没有执行器可等待，移除当前监听后暴露原始失败。
      input.signal?.removeEventListener('abort', cancel); reject(error); return
    }
    let converted = false
    let failure: unknown
    worker.once('message', value => { converted = value?.converted === true })
    worker.once('error', error => { failure = error })
    worker.once('exit', code => {
      input.signal?.removeEventListener('abort', cancel)
      if (failure) reject(failure)
      else if (code !== 0 || !converted) reject(new Error(`Snapshot conversion worker exited without completion: ${code}`))
      else if (input.signal?.aborted) reject(new Error('SNAPSHOT_JOB_CANCELLED: capture executor exited'))
      else resolve()
    })
  })
}
