import { continueSnapshotTrace, snapshotTracePhase, type SnapshotTraceIdentity } from './sync-snapshot-trace'
import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { SqliteConfigDocument } from '../sources/config-document'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import type { DesktopGenesisCut } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { SyncSnapshotPageWriter } from './sync-snapshot-page-writer'
import { SyncPagedSnapshotCapture } from './sync-paged-snapshot-capture'
import { SyncBufferedSnapshotCapture } from './sync-buffered-snapshot-capture'
import { frozenSnapshotDatabase } from './sync-frozen-database-context'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { bindSnapshotCancellation } from './sync-snapshot-execution'
import { guardedSnapshotDatabase, SnapshotInstallFence, withSnapshotWriteOwner } from './sync-snapshot-access'

interface Input { trace?: SnapshotTraceIdentity; path: string; userData: string; blobRoot: string; cut: DesktopGenesisCut;
  bundleId: string; account: number; now: number; cancellation: SharedArrayBuffer }
/** 与正式数据库相同的锁等待配置，不降低持久性。 */
const BUSY_TIMEOUT_MS = 5_000
const input = workerData as Input
bindSnapshotCancellation(input.cancellation)
const database = guardedSnapshotDatabase(new DatabaseSync(input.path, { timeout: BUSY_TIMEOUT_MS }), new SnapshotInstallFence(input.path))
try {
  database.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
  continueSnapshotTrace(input.trace, () => snapshotTracePhase('capture.convert', () =>
    withSnapshotWriteOwner(input.cut.syncSpaceId, () => createCaptureRuntime(database, input).convertFrozenCapture(input))))
  parentPort!.postMessage({ converted: true })
} finally {
  // 主进程必须等真实连接关闭后才进入页生成或解除空间所有权。
  database.close()
}

/** 注入正式只读来源和正式记录写入器，转换不需要生命周期服务或设备私钥。 */
function createCaptureRuntime(database: DatabaseSync, input: Input): DesktopGenesisSnapshotService {
  const document = (file: string) => new SqliteConfigDocument({ database, legacyFile: join(input.userData, file) })
  const runtime = new SyncRuntimeRepository(database)
  const state = new SyncStateRepository(database)
  const store = new SyncPagedSnapshotStore(database)
  return new DesktopGenesisSnapshotService(database, runtime, undefined,
    new ArticleFilterRepository(join(input.userData, 'article-filter-rules.json'), database), undefined, undefined, undefined,
    new DesktopSyncLocalBlobStore(input.blobRoot), new WebsiteRuleRepository(document('website-rules.json')),
    new JsonRuleRepository(document('json-source-rules.json')), new RssHubSettingsRepository(database),
    new WebsiteParsePreferenceRepository(document('website-parse-preferences.json')), {
      store,
      createCapture: ({ cut, snapshotBundleId }) => {
        const writer = new SyncSnapshotPageWriter({ snapshotBundleId, storage: new SyncBufferedSnapshotCapture(database, store), deferPages: true })
        const capture = new SyncPagedSnapshotCapture({ database: frozenSnapshotDatabase(database), runtime, state, cut, writer, store, snapshotBundleId })
        return { capture, finish: frontiers => writer.finish(frontiers) }
      }
    })
}
