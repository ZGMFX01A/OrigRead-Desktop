import { snapshotTraceIdentity, snapshotTraceRun, snapshotTracePhase } from './sync-snapshot-trace'
import type { DatabaseSync } from 'node:sqlite'
import { openSnapshotControlDatabase } from './sync-snapshot-control-database'
import { Worker } from 'node:worker_threads'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SnapshotInstallResult } from './desktop-snapshot-install-service'
import { SyncSnapshotSpaceOwner } from './sync-snapshot-space-owner'

export interface SnapshotJobStatus { snapshotBundleId: string; rootHash: string; generation: number; state: string; phase: string; error: string | null }
interface Input { space: string; peer: string; account: number; manifest: SyncPagedSnapshotManifest; now: number }
interface Owner { cancellation: Int32Array; completion: Promise<SnapshotInstallResult> }
interface Options { path: string; userData: string; blobRoot: string; completed(input: Input): void }

/** 控制库与重型业务库分离，真实 Worker 退出之前始终保留空间拥有权。 */
export class SyncSnapshotJobs {
  private readonly database: DatabaseSync
  private readonly owners = new Map<string, Owner>()
  readonly spaceOwner: SyncSnapshotSpaceOwner
  constructor(private readonly options: Options) {
    this.database = openSnapshotControlDatabase(options.path)
    this.spaceOwner = new SyncSnapshotSpaceOwner(this.database)
    this.database.exec(`PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshot_job(
      space TEXT PRIMARY KEY,peer TEXT NOT NULL,bundle TEXT NOT NULL,root TEXT NOT NULL,scope TEXT NOT NULL,
      pipeline INTEGER NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,result TEXT)`)
    this.database.exec("UPDATE snapshot_job SET state='PAUSED',phase='PROCESS_RESTARTED' WHERE state IN ('RUNNING','CANCELLING')")
    this.database.exec(`CREATE TABLE IF NOT EXISTS snapshot_install_fence(
      space TEXT PRIMARY KEY,account INTEGER NOT NULL,root TEXT NOT NULL,scope TEXT NOT NULL,generation INTEGER NOT NULL)`)
  }

  /** 界面可见性从独立持久围栏读取，暂停、失败与进程重启都不能提前展示半成品。 */
  isInstalling(space: string): boolean {
    return this.database.prepare('SELECT 1 FROM snapshot_install_fence WHERE space=?').get(space) !== undefined
  }

  /** 固定输入重复提交返回原代次，取消请求不允许并行启动后继写入者。 */
  submit(input: Input): SnapshotJobStatus {
    const current = this.matching(input)
    if (this.owners.has(input.space) || current?.state === 'COMPLETED') return this.status(input)
    const generation = Number(this.database.prepare('SELECT generation FROM snapshot_job WHERE space=?').get(input.space)?.generation ?? 0) + 1
    const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const ownership = { space: input.space, identity: `install:${input.manifest.rootHash}:${scope(input)}`, phase: 'INSTALL' }
    const ownerGeneration = this.spaceOwner.claim(ownership)
    try {
      this.database.prepare("INSERT OR REPLACE INTO snapshot_job VALUES(?,?,?,?,?,?,?,'RUNNING','ACCEPTED',NULL,NULL)")
        .run(input.space, input.peer, input.manifest.snapshotBundleId, input.manifest.rootHash, scope(input), PIPELINE_VERSION, generation)
    } catch (error) {
      // 尚未启动 Worker，受理回执失败也必须释放当前代的真实控制所有权。
      this.spaceOwner.finish({ ...ownership, generation: ownerGeneration, state: 'FAILED' }); throw error
    }
    const completion = Promise.resolve().then(() => snapshotTraceRun({ identity: ownership.identity, generation: ownerGeneration },
      () => snapshotTracePhase('install.total', () => this.execute(input, generation, cancellation))))
      .then(result => {
        this.spaceOwner.finish({ ...ownership, generation: ownerGeneration, state: 'COMPLETED' })
        return result
      }, error => {
        // 终态只在 execute 已实际退出后登记，同一输入的断点保留。
        const paused = Atomics.load(new Int32Array(cancellation), 0) !== 0 || /INSUFFICIENT_SPACE:|MORE_WORK:/.test(String(error))
        this.spaceOwner.finish({ ...ownership, generation: ownerGeneration, state: paused ? 'PAUSED' : 'FAILED' }); throw error
      })
    // 后台错误已写入控制库，显式观察 rejection；调用方仍可 await 原 Promise 取得同一错误。
    void completion.catch(error => { console.error('Snapshot background executor failed', error) })
    this.owners.set(input.space, { cancellation: new Int32Array(cancellation), completion })
    return this.status(input)
  }

  /** 本机会话与远程提交共用同一空间所有权，完成结果来自真实 Worker。 */
  async install(input: Input): Promise<SnapshotInstallResult> {
    const status = this.submit(input)
    const owner = this.owners.get(input.space)
    if (owner) return owner.completion
    const result = this.database.prepare('SELECT result FROM snapshot_job WHERE space=? AND generation=?').get(input.space, status.generation)
    if (!result?.result) throw new Error(`SNAPSHOT_JOB_${status.state}: ${status.error ?? 'completion receipt missing'}`)
    return JSON.parse(String(result.result)) as SnapshotInstallResult
  }

  /** status/cancel 仅查控制库，并使用 transport peer 约束固定输入来源。 */
  status(input: Pick<Input, 'space' | 'peer'> & { manifest: Pick<SyncPagedSnapshotManifest, 'snapshotBundleId'> }): SnapshotJobStatus {
    const row = this.database.prepare('SELECT * FROM snapshot_job WHERE space=?').get(input.space)
    if (!row || row.peer !== input.peer || row.bundle !== input.manifest.snapshotBundleId) throw new Error('SNAPSHOT_CONFLICT: job has another transport source')
    return { snapshotBundleId: String(row.bundle), rootHash: String(row.root), generation: Number(row.generation),
      state: String(row.state), phase: String(row.phase), error: row.error == null ? null : String(row.error) }
  }

  /** 取消立即可见，但终态等待实际事务回滚、finally 与 Worker exit。 */
  cancel(input: Parameters<SyncSnapshotJobs['status']>[0]): SnapshotJobStatus {
    const status = this.status(input)
    if (status.state === 'RUNNING') {
      const owner = this.owners.get(input.space)
      if (!owner) throw new Error('SNAPSHOT_JOB_OWNER_MISSING')
      this.database.prepare("UPDATE snapshot_job SET state='CANCELLING',phase='CANCEL_REQUESTED' WHERE space=? AND generation=?")
        .run(input.space, status.generation)
      Atomics.store(owner.cancellation, 0, 1)
    }
    return this.status(input)
  }

  /** root、scope、peer、流水线任一变化都必须先结束持久化原作业。 */
  cancelForSpace(space: string): void {
    const row = this.database.prepare("SELECT peer,bundle FROM snapshot_job WHERE space=? AND state='RUNNING'").get(space)
    if (row) this.cancel({ space, peer: String(row.peer), manifest: { snapshotBundleId: String(row.bundle) } })
    this.spaceOwner.requestCancel(space)
  }

  /** root、scope、peer、流水线任一变化都必须先结束持久化原作业。 */
  private matching(input: Input): SnapshotJobStatus | null {
    const row = this.database.prepare('SELECT * FROM snapshot_job WHERE space=?').get(input.space)
    if (!row) return null
    const same = row.peer === input.peer && row.bundle === input.manifest.snapshotBundleId && row.root === input.manifest.rootHash &&
      row.scope === scope(input) && row.pipeline === PIPELINE_VERSION
    if (!same && row.state !== 'COMPLETED') throw new Error('SNAPSHOT_JOB_CONFLICT: resume requires original root and scope')
    return same ? this.status(input) : null
  }

  /** message 不是退出证明；即使已经获得结果，也在 exit 后才更新 journal 并释放拥有权。 */
  private execute(input: Input, generation: number, cancellation: SharedArrayBuffer): Promise<SnapshotInstallResult> {
    return new Promise((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(new URL('./sync-snapshot-install-worker.js', import.meta.url), { workerData: { trace: snapshotTraceIdentity(),
          path: this.options.path, userData: this.options.userData, blobRoot: this.options.blobRoot,
          account: input.account, manifest: input.manifest, now: input.now, cancellation } })
      } catch (error) {
        // 启动失败没有真实 Worker；必须结束持久运行标记，不能留下永远 RUNNING 的作业。
        this.finish({ input, generation, state: 'FAILED', error: String(error) })
        this.owners.delete(input.space)
        reject(error)
        return
      }
      let result: SnapshotInstallResult | undefined
      let failure: unknown
      worker.once('message', value => { result = value })
      worker.once('error', error => { failure = error })
      worker.once('exit', code => {
        try {
          const cancelled = Atomics.load(new Int32Array(cancellation), 0) !== 0
          if (failure || code !== 0 || !result || cancelled) throw failure ?? new Error(cancelled ? 'SNAPSHOT_JOB_CANCELLED' : `Snapshot worker exited without completion: ${code}`)
          this.options.completed(input)
          this.finish({ input, generation, state: 'COMPLETED', result })
          resolve(result)
        } catch (error) {
          // 原始错误持久化并拒绝原 Promise，重试只能消费同一输入及批次断点。
          const cancelled = Atomics.load(new Int32Array(cancellation), 0) !== 0
          this.finish({ input, generation, state: cancelled || /INSUFFICIENT_SPACE:|MORE_WORK:/.test(String(error)) ? 'PAUSED' : 'FAILED', error: String(error) })
          reject(error)
        } finally { this.owners.delete(input.space) }
      })
    })
  }

  /** 只有当前代次的真实退出回调可以发布终态与结果。 */
  private finish(value: { input: Input; generation: number; state: string; result?: SnapshotInstallResult; error?: string }): void {
    this.database.prepare("UPDATE snapshot_job SET state=?,phase='EXECUTOR_EXITED',error=?,result=? WHERE space=? AND generation=?")
      .run(value.state, value.error ?? null, value.result ? JSON.stringify(value.result) : null, value.input.space, value.generation)
  }
}

/** 来源池与原始固定输入的当前处理版本。 */
const PIPELINE_VERSION = 2
/** lane 的稳定排序参与持久作业身份，页面顺序不改变 scope。 */
function scope(input: Input): string { return input.manifest.lanes.map(lane => lane.replicationLaneId).sort().join(',') }
