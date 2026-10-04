import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { SnapshotMergeInput } from './sync-snapshot-merge-executor'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { guardedSnapshotDatabase, SnapshotInstallFence, withSnapshotWriteOwner } from './sync-snapshot-access'
import { snapshotInstallRuntime } from './sync-snapshot-install-runtime'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { SyncSnapshotPageWriter } from './sync-snapshot-page-writer'
import { preparePagedRecovery, publishPagedRecovery } from './sync-paged-recovery-merge'
import { bindSnapshotCancellation } from './sync-snapshot-execution'
import { continueSnapshotTrace, snapshotTracePhase, type SnapshotTraceIdentity } from './sync-snapshot-trace'
import { SyncBufferedSnapshotCapture } from './sync-buffered-snapshot-capture'

/** 与产品数据库相同的写锁等待，不通过关闭同步设置取得提速。 */
const BUSY_TIMEOUT_MS = 5_000
const input = workerData as SnapshotMergeInput & { phase: string; manifest?: SyncPagedSnapshotManifest; cancellation: SharedArrayBuffer; trace?: SnapshotTraceIdentity }
bindSnapshotCancellation(input.cancellation)
const database = guardedSnapshotDatabase(new DatabaseSync(input.path, { timeout: BUSY_TIMEOUT_MS }), new SnapshotInstallFence(input.path))
try {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL')
  const store = new SyncPagedSnapshotStore(database)
  const runtime = new SyncRuntimeRepository(database)
  const result = continueSnapshotTrace(input.trace, () =>
    withSnapshotWriteOwner(input.local.syncSpaceId, () => {
      const installer = snapshotInstallRuntime({ database, userData: input.userData, blobRoot: input.blobRoot })
      const validate = (manifest: SyncPagedSnapshotManifest) => installer.verifyPaged({ manifest, store })
      if (input.phase === 'PREPARE') {
        validate(input.local); validate(input.target)
        return snapshotTracePhase('merge.compute', () => preparePagedRecovery({ runtime, store,
          createWriter: bundle => new SyncSnapshotPageWriter({ snapshotBundleId: bundle,
            storage: new SyncBufferedSnapshotCapture(runtime.databaseHandle(), store) }) }, input))
      }
      if (input.phase !== 'PUBLISH' || !input.manifest) throw new Error('SNAPSHOT_MERGE_PHASE_INVALID')
      return snapshotTracePhase('merge.publish', () => publishPagedRecovery({ runtime, store, validate,
        requirePrepared: manifest => installer.requirePagedPublicationProof({ manifest, store }) }, { ...input, manifest: input.manifest! }))
    }))
  parentPort!.postMessage(result)
} finally {
  // 真正结束 SQL、游标和连接后才通知主进程允许下一位空间拥有者进入。
  database.close()
}
