import { snapshotTraceIdentity } from './sync-snapshot-trace'
import { Worker } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'
import { SNAPSHOT_PAGE_BYTES, type SyncSnapshotLanePages } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SnapshotPublicationReceipt } from './sync-snapshot-publication-executor'
import { snapshotCancellationBuffer, snapshotCheckpoint } from './sync-snapshot-execution'

interface Input { database: DatabaseSync; bundle: string; frontiers: Readonly<Record<string, string>>;
  blobRoot?: string; signal?: AbortSignal; now: number; createManifest(lanes: SyncSnapshotLanePages[]): SyncPagedSnapshotManifest }
interface Result extends SnapshotPublicationReceipt { manifest: SyncPagedSnapshotManifest }
type Message = { type: 'PAGES'; lanes: SyncSnapshotLanePages[] } | { type: 'PUBLISHED'; receipt: SnapshotPublicationReceipt }

/** Worker 消费已提交固定记录；主进程签名后仍由同一执行器校验/发布，私钥不越界。 */
export function buildFrozenSnapshotPages(input: Input): Promise<Result> {
  const location = input.database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
  if (typeof location !== 'string' || !location) throw new Error('SNAPSHOT_WORKER_REQUIRED: fixed Snapshot needs an on-disk database')
  return new Promise((resolve, reject) => {
    const cancellation = snapshotCancellationBuffer() ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    snapshotCheckpoint()
    const flag = new Int32Array(cancellation)
    const cancel = () => Atomics.store(flag, 0, 1)
    input.signal?.addEventListener('abort', cancel)
    if (input.signal?.aborted) cancel()
    const worker = new Worker(new URL('./sync-frozen-snapshot-worker.js', import.meta.url), { workerData: { trace: snapshotTraceIdentity(),
      path: location, bundle: input.bundle, frontiers: input.frontiers, pageBytes: SNAPSHOT_PAGE_BYTES,
      blobRoot: input.blobRoot, now: input.now,
      cancellation,
      busyTimeout: Number(input.database.prepare('PRAGMA busy_timeout').get()!.timeout) } })
    let manifest: SyncPagedSnapshotManifest | undefined
    let receipt: SnapshotPublicationReceipt | undefined
    let failure: unknown
    worker.on('message', (message: Message) => {
      if (message.type === 'PUBLISHED') { receipt = message.receipt; return }
      try {
        snapshotCheckpoint()
        manifest = input.createManifest(message.lanes)
        worker.postMessage({ type: 'MANIFEST', manifest })
      } catch (error) {
        // 签名/取消失败仍唤醒真实 Worker 关闭连接，不能只提前拒绝父 Promise。
        failure = error
        worker.postMessage({ type: 'FAILED' })
      }
    })
    worker.once('error', error => { failure = error })
    worker.once('exit', code => {
      input.signal?.removeEventListener('abort', cancel)
      // 收到结果还不是退出回执；等 Worker 关闭 SQL 连接和端口后才解除拥有者。
      if (failure) reject(failure)
      else if (code !== 0 || !manifest || receipt?.bundle !== input.bundle || receipt.root !== manifest.rootHash)
        reject(new Error(`Snapshot worker exited before publication: ${code}`))
      else if (input.signal?.aborted) reject(new Error('SNAPSHOT_JOB_CANCELLED: executor exited'))
      else resolve({ ...receipt, manifest })
    })
  })
}
