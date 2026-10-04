import { Worker } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { SyncBackgroundSnapshotTransfer } from './sync-paged-snapshot-transfer'
import { snapshotCancellationBuffer, snapshotCheckpoint } from './sync-snapshot-execution'
import { snapshotTraceIdentity } from './sync-snapshot-trace'

export interface SnapshotPublicationReceipt { bundle: string; root: string; revision: number }
interface Input { database: DatabaseSync; store: SyncPagedSnapshotStore; manifest: SyncPagedSnapshotManifest; now: number }

/** 产品与诊断使用同一个组合：CPU 索引/字节校验放在 Worker，主线程只续接标量证明。 */
export function createWorkerSnapshotTransfer(input: { database: DatabaseSync; store: SyncPagedSnapshotStore }): SyncBackgroundSnapshotTransfer {
  return new SyncBackgroundSnapshotTransfer({ store: input.store,
    publish: publication => publishReceivedSnapshotInWorker({ ...input, ...publication }) })
}

/** 读取固定路径后不再传业务对象或数据库连接，取消仍使用原空间 owner 的共享令牌。 */
async function publishReceivedSnapshotInWorker(input: Input): Promise<void> {
  const path = input.database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
  if (typeof path !== 'string' || !path) throw new Error('SNAPSHOT_WORKER_REQUIRED: received Snapshot database is not on disk')
  const cancellation = snapshotCancellationBuffer() ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  snapshotCheckpoint()
  const receipt = await execute({ path, manifest: input.manifest, now: input.now, cancellation,
    busyTimeout: Number(input.database.prepare('PRAGMA busy_timeout').get()!.timeout), trace: snapshotTraceIdentity() })
  snapshotCheckpoint()
  if (receipt.bundle !== input.manifest.snapshotBundleId || receipt.root !== input.manifest.rootHash)
    throw new Error('SNAPSHOT_CORRUPTED: publication executor returned another immutable root')
  input.store.acceptPublication({ manifest: input.manifest, revision: receipt.revision })
}

/** result 不能代替 exit：异常、关闭 SQLite 或取消尚未完成时不解除父空间 owner。 */
function execute(input: { path: string; manifest: SyncPagedSnapshotManifest; now: number; busyTimeout: number;
  cancellation: SharedArrayBuffer; trace: ReturnType<typeof snapshotTraceIdentity> }): Promise<SnapshotPublicationReceipt> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sync-snapshot-publication-worker.js', import.meta.url), { workerData: input })
    let receipt: SnapshotPublicationReceipt | undefined
    let failure: unknown
    worker.once('message', value => { receipt = value })
    worker.once('error', error => { failure = error })
    worker.once('exit', code => {
      if (failure) reject(failure)
      else if (code !== 0 || !receipt) reject(new Error(`Snapshot publication executor exited without receipt: ${code}`))
      else resolve(receipt)
    })
  })
}
