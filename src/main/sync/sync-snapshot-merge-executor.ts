import { snapshotTraceIdentity } from './sync-snapshot-trace'
import { Worker } from 'node:worker_threads'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { snapshotCancellationBuffer, snapshotCheckpoint } from './sync-snapshot-execution'

export interface SnapshotMergeInput { path: string; userData: string; blobRoot: string;
  local: SyncPagedSnapshotManifest; target: SyncPagedSnapshotManifest; now: number }

/** 两次真实 Worker 分别计算和验证发布；主进程只负责使用真实设备私钥签名。 */
export async function mergeSnapshotInWorker(input: SnapshotMergeInput, sign: (device: string, material: string) => string): Promise<SyncPagedSnapshotManifest> {
  const { pagedSnapshotSigningMaterial } = await import('./sync-paged-snapshot-wire')
  const prepared = await execute({ ...input, phase: 'PREPARE' })
  const manifest = prepared.authorSignature ? prepared : { ...prepared,
    authorSignature: sign(prepared.authorDeviceId, pagedSnapshotSigningMaterial(prepared)) }
  return execute({ ...input, phase: 'PUBLISH', manifest })
}

/** message 只携带结果，真实连接关闭与 Worker exit 才构成执行完成证据。 */
function execute(input: SnapshotMergeInput & { phase: string; manifest?: SyncPagedSnapshotManifest }): Promise<SyncPagedSnapshotManifest> {
  return new Promise((resolve, reject) => {
    const cancellation = snapshotCancellationBuffer() ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    snapshotCheckpoint()
    const worker = new Worker(new URL('./sync-snapshot-merge-worker.js', import.meta.url), { workerData: { ...input, cancellation, trace: snapshotTraceIdentity() } })
    let result: SyncPagedSnapshotManifest | undefined
    let failure: unknown
    worker.once('message', value => { result = value })
    worker.once('error', error => { failure = error })
    worker.once('exit', code => {
      if (failure) reject(failure)
      else if (code !== 0 || !result) reject(new Error(`Snapshot merge executor exited without completion: ${code}`))
      else resolve(result)
    })
  })
}
