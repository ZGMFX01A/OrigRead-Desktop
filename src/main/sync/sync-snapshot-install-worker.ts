import { continueSnapshotTrace, snapshotTracePhase, type SnapshotTraceIdentity } from './sync-snapshot-trace'
import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { snapshotInstallRuntime } from './sync-snapshot-install-runtime'
import { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { bindSnapshotCancellation, snapshotCheckpoint } from './sync-snapshot-execution'
import { guardedSnapshotDatabase, SnapshotInstallFence, withSnapshotWriteOwner } from './sync-snapshot-access'

interface Input { trace?: SnapshotTraceIdentity; path: string; userData: string; blobRoot: string; account: number;
  manifest: SyncPagedSnapshotManifest; now: number; cancellation: SharedArrayBuffer }
/** 延续业务库原生写入锁等待，不改变同步或 WAL 的耐久语义。 */
const BUSY_TIMEOUT_MS = 5_000
const input = workerData as Input
bindSnapshotCancellation(input.cancellation)
const fence = new SnapshotInstallFence(input.path)
const database = guardedSnapshotDatabase(new DatabaseSync(input.path, { timeout: BUSY_TIMEOUT_MS }), fence)
try {
  database.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA synchronous=FULL`)
  snapshotCheckpoint()
  const store = new SyncPagedSnapshotStore(database)
  continueSnapshotTrace(input.trace, () => snapshotTracePhase('install.verify-pages', () => store.verifyAndPublish(input.manifest, input.now)))
  const result = continueSnapshotTrace(input.trace, () => snapshotTracePhase('install.complete', () => withSnapshotWriteOwner(input.manifest.syncSpaceId, () => {
    const installer = snapshotInstallRuntime({ database, userData: input.userData, blobRoot: input.blobRoot })
    installer.snapshotFence = {
      begin() {
        fence.begin({ space: input.manifest.syncSpaceId, account: input.account, root: input.manifest.rootHash,
          scope: input.manifest.lanes.map(lane => lane.replicationLaneId).sort().join(',') })
        // 围栏先拒绝后来写入，再等已经获得业务写锁的语句结束，控制库不等待业务事务。
        database.exec('BEGIN IMMEDIATE'); database.exec('COMMIT')
      },
      complete() { fence.complete({ space: input.manifest.syncSpaceId, root: input.manifest.rootHash }) }
    }
    return installer.installPaged({ localAccountId: input.account, manifest: input.manifest, store, now: input.now })
  })))
  snapshotCheckpoint()
  store.lifecycle.completed(input.manifest.snapshotBundleId)
  parentPort!.postMessage(result)
} finally {
  // 主进程只在 exit 后发布终态，此处先关闭实际 SQLite 连接及未提交事务。
  database.close()
}
