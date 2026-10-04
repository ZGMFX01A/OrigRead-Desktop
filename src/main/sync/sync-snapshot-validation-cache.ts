import type { DatabaseSync } from 'node:sqlite'
import { SNAPSHOT_DERIVED_TABLES } from '../database/snapshot-derived-schema'

/** 同 root、同索引代次的本进程验证结果可复用；启动与定期 scrub 仍全量验证。 */
export class SyncSnapshotValidationCache {
  private readonly verified = new Map<string, { root: string; revision: number; checkedAt: number }>()
  private readonly queries: Readonly<Record<'revision' | 'receipt' | 'mark', ReturnType<DatabaseSync['prepare']>>>
  constructor(private readonly database: DatabaseSync) {
    database.exec('CREATE TABLE IF NOT EXISTS sync_snapshot_revision(bundle_id TEXT PRIMARY KEY,revision INTEGER NOT NULL)')
    database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_index_receipt(
      bundle TEXT PRIMARY KEY,root TEXT NOT NULL,revision INTEGER NOT NULL,index_version INTEGER NOT NULL)`)
    for (const table of ['sync_paged_snapshot', 'sync_paged_snapshot_page', 'sync_paged_snapshot_record', 'sync_snapshot_source_link', ...SNAPSHOT_DERIVED_TABLES]) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = action === 'DELETE' ? 'OLD' : 'NEW'
        database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${action.toLowerCase()}_revision AFTER ${action} ON ${table}
          BEGIN INSERT INTO sync_snapshot_revision VALUES(${row}.snapshot_bundle_id,1)
          ON CONFLICT(bundle_id) DO UPDATE SET revision=revision+1; END`)
      }
      database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_update_old_revision AFTER UPDATE ON ${table}
        BEGIN INSERT INTO sync_snapshot_revision VALUES(OLD.snapshot_bundle_id,1)
        ON CONFLICT(bundle_id) DO UPDATE SET revision=revision+1; END`)
    }
    for (const action of ['UPDATE', 'DELETE']) database.exec(`CREATE TRIGGER IF NOT EXISTS sync_snapshot_source_${action.toLowerCase()}_revision
      AFTER ${action} ON sync_snapshot_source BEGIN UPDATE sync_snapshot_revision SET revision=revision+1 WHERE bundle_id IN
      (SELECT snapshot_bundle_id FROM sync_snapshot_source_link WHERE source_key=OLD.source_key); END`)
    this.queries = { revision: database.prepare('SELECT revision FROM sync_snapshot_revision WHERE bundle_id=?'),
      receipt: database.prepare('SELECT root,revision,index_version FROM sync_snapshot_index_receipt WHERE bundle=?'),
      mark: database.prepare('INSERT OR REPLACE INTO sync_snapshot_index_receipt VALUES(?,?,?,?)') }
  }

  /** 数据库修改页或索引会由触发器失效，授权仍由调用者每次重新核验。 */
  reusable(bundle: string, root: string): boolean {
    const cached = this.verified.get(bundle)
    return cached?.root === root && cached.revision === this.revision(bundle) && Date.now() - cached.checkedAt < SCRUB_INTERVAL_MS
  }

  /** 必须在完整字节/关联验证与发布成功之后记录，失败路径不会生成缓存。 */
  mark(bundle: string, root: string): void {
    const revision = this.revision(bundle)
    this.queries.mark.run(bundle, root, revision, INDEX_VERSION)
    this.verified.set(bundle, { root, revision, checkedAt: Date.now() })
  }

  /** 同一进程的实际 Worker 已完整校验，退出后修订仍一致才接续它的内存证明。 */
  accept(input: { bundle: string; root: string; revision: number }): void {
    if (this.revision(input.bundle) !== input.revision || !this.indexed(input.bundle, input.root))
      throw new Error('REVALIDATION_REQUIRED: Worker page/index revision changed')
    this.verified.set(input.bundle, { root: input.root, revision: input.revision, checkedAt: Date.now() })
  }

  /** 派生完成回执只避免重建索引；重启仍完整核验字节、关联和当前授权。 */
  indexed(bundle: string, root: string): boolean {
    const receipt = this.queries.receipt.get(bundle)
    return receipt?.root === root && Number(receipt.index_version) === INDEX_VERSION && Number(receipt.revision) === this.revision(bundle)
  }

  revision(bundle: string): number {
    return Number(this.queries.revision.get(bundle)?.revision ?? 0)
  }
}

/** 进程内每日重校验不可变页；重启时缓存为空，自然触发首次完整 scrub。 */
const SCRUB_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 完整来源池与可恢复派生索引的当前本地格式。 */
const INDEX_VERSION = 2
