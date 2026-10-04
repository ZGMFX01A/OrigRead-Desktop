import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { bindSnapshotCancellation, snapshotCheckpoint } from './sync-snapshot-execution'
import { continueSnapshotTrace, snapshotTracePhase, tracedSnapshotDatabase, type SnapshotTraceIdentity } from './sync-snapshot-trace'

/** 接收清单不含私钥；Worker 只校验私有 Page 数据，不打开 Reader/Chat 业务投影。 */
const input = workerData as { path: string; manifest: SyncPagedSnapshotManifest; now: number;
  busyTimeout: number; cancellation: SharedArrayBuffer; trace?: SnapshotTraceIdentity }
bindSnapshotCancellation(input.cancellation)
const database = tracedSnapshotDatabase(new DatabaseSync(input.path, { timeout: input.busyTimeout }))
try {
  database.exec('PRAGMA synchronous=FULL')
  const store = new SyncPagedSnapshotStore(database)
  continueSnapshotTrace(input.trace, () => snapshotTracePhase('receive.index-and-publish', () => {
    snapshotCheckpoint()
    store.verifyAndPublish(input.manifest, input.now)
    snapshotCheckpoint()
  }))
  parentPort!.postMessage({ bundle: input.manifest.snapshotBundleId, root: input.manifest.rootHash,
    revision: store.derivedRevision(input.manifest.snapshotBundleId) })
} finally {
  // 失败/取消保留真实 INDEXING 断点；连接实际关闭后父线程才能收到 exit。
  database.close()
}
