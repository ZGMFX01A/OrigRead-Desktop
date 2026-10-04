import type { DatabaseSync } from 'node:sqlite'
import { statfsSync } from 'node:fs'
import { prepareSnapshotResourceUsage, initializeSnapshotResourceUsage } from './sync-snapshot-resource-usage'

/** 全生命周期容量模型保留到真实完成，磁盘余量不替代既有 Peer 接收上限。 */
export class SyncSnapshotResourceBudget {
  private readonly path: string
  private readonly reservation: ReturnType<DatabaseSync['prepare']>
  private readonly remaining: ReturnType<DatabaseSync['prepare']>
  constructor(private readonly database: DatabaseSync, initialize = true) {
    this.path = String(database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file ?? '')
    if (initialize) {
      database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_resource_budget(
      bundle TEXT PRIMARY KEY,source_bytes INTEGER NOT NULL,input_bytes INTEGER NOT NULL,
      body_bytes INTEGER NOT NULL,working_bytes INTEGER NOT NULL,margin_bytes INTEGER NOT NULL)`)
      database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_source_budget(
        bundle TEXT PRIMARY KEY,pending_bytes INTEGER NOT NULL,raw_complete INTEGER NOT NULL)`)
      database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_source_copy_usage(
        bundle TEXT NOT NULL,source TEXT NOT NULL,copied_bytes INTEGER NOT NULL,PRIMARY KEY(bundle,source))`)
      prepareSnapshotResourceUsage(database)
    }
    this.reservation = database.prepare('SELECT 1 FROM sync_snapshot_resource_budget WHERE bundle=?')
    this.remaining = database.prepare(`SELECT b.working_bytes,b.margin_bytes,COALESCE(u.bytes,0) AS allocated
      FROM sync_snapshot_resource_budget b LEFT JOIN sync_snapshot_resource_usage u ON u.bundle=b.bundle`)
  }

  /** 源库大小是 typed staging/转换副本上界；相同持久作业不重复创建预算。 */
  reserve(bundle: string, inputBytes: number, sourceBytes = 0): void {
    if (!this.path) return
    this.atomic(() => this.reserveLocked({ bundle, inputBytes, sourceBytes }))
  }

  /** 各空间的预算读取和新增同事务提交，两个 Worker 不能同时消费同一份未预约余量。 */
  private reserveLocked(input: { bundle: string; inputBytes: number; sourceBytes: number }): void {
    const { bundle, inputBytes, sourceBytes } = input
    initializeSnapshotResourceUsage(this.database, bundle)
    const previous = this.database.prepare('SELECT input_bytes,source_bytes FROM sync_snapshot_resource_budget WHERE bundle=?').get(bundle)
    if (previous) {
      this.database.prepare('INSERT OR IGNORE INTO sync_snapshot_source_budget VALUES(?,?,0)').run(bundle, Number(previous.source_bytes) * SOURCE_COPIES)
      this.expand({ bundle, inputBytes: Math.max(inputBytes, Number(previous.input_bytes)),
        sourceBytes: Math.max(sourceBytes, Number(previous.source_bytes)) }); return
    }
    const working = sourceBytes * SOURCE_COPIES + inputBytes * WORKING_COPIES
    const margin = Math.max(MINIMUM_MARGIN, Math.ceil(working / MARGIN_DIVISOR))
    const reserved = this.reservedRemaining()
    if (this.free() < working + margin + reserved) throw new Error('INSUFFICIENT_SPACE: Snapshot lifecycle resource budget cannot be reserved')
    this.database.prepare('INSERT INTO sync_snapshot_resource_budget VALUES(?,?,?,0,?,?)').run(bundle, sourceBytes, inputBytes, working, margin)
    this.database.prepare('INSERT INTO sync_snapshot_source_budget VALUES(?,?,0)').run(bundle, sourceBytes * SOURCE_COPIES)
  }

  /** 仅真实 capture 预约 typed staging/来源副本；页库和旧私有索引不是新的源事实。 */
  capture(bundle: string): void {
    if (!this.path) return
    const tables = this.database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'sync_raw_%' AND name NOT LIKE 'sync_paged_%' AND name NOT LIKE 'sync_snapshot_%'
      AND name <> 'schema_migrations'`).all()
    let sourceBytes = 0
    for (const table of tables) {
      const name = quote(String(table.name))
      const columns = this.database.prepare(`PRAGMA table_info(${name})`).all()
        .map(column => `COALESCE(length(CAST(${quote(String(column.name))} AS BLOB)),0)`)
      const row = this.database.prepare(`SELECT COALESCE(SUM(${columns.join('+')}+${ROW_STORAGE_OVERHEAD}),0) AS bytes FROM ${name}`).get()!
      sourceBytes += Number(row.bytes)
    }
    this.reserve(bundle, 0, sourceBytes)
  }

  /** 完整索引给出的未验证正文缺口按真实字节记账，文件先到不重复占额。 */
  bodies(bundle: string, missingBytes: number): void {
    if (!this.path) return
    this.expand({ bundle, bodyBytes: missingBytes })
  }

  /** 新页面或正文缺口出现时同步扩张工作集及百分比余量，不能只更新展示字段。 */
  private expand(input: { bundle: string; inputBytes?: number; bodyBytes?: number; sourceBytes?: number }): void {
    this.atomic(() => this.expandLocked(input))
  }

  /** 扩张和预算行更新同事务，其他作业只能看到完整预约。 */
  private expandLocked(input: { bundle: string; inputBytes?: number; bodyBytes?: number; sourceBytes?: number }): void {
    const row = this.database.prepare('SELECT * FROM sync_snapshot_resource_budget WHERE bundle=?').get(input.bundle)
    if (!row) throw new Error('SNAPSHOT_RESOURCE_RESERVATION_MISSING')
    const inputBytes = input.inputBytes ?? Number(row.input_bytes)
    const bodyBytes = input.bodyBytes ?? Number(row.body_bytes)
    const sourceBytes = input.sourceBytes ?? Number(row.source_bytes)
    const pending = this.database.prepare('SELECT pending_bytes FROM sync_snapshot_source_budget WHERE bundle=?').get(input.bundle)
    if (!pending) throw new Error('SNAPSHOT_SOURCE_RESERVATION_MISSING')
    const sourcePending = input.sourceBytes === 0 ? 0 : Number(pending.pending_bytes) + Math.max(0, sourceBytes - Number(row.source_bytes)) * SOURCE_COPIES
    const working = sourcePending + inputBytes * WORKING_COPIES + bodyBytes
    const margin = Math.max(MINIMUM_MARGIN, Math.ceil(working / MARGIN_DIVISOR))
    const increase = working + margin - Number(row.working_bytes) - Number(row.margin_bytes)
    if (increase > 0) this.requireRemaining(input.bundle, increase)
    this.database.prepare('UPDATE sync_snapshot_resource_budget SET source_bytes=?,input_bytes=?,body_bytes=?,working_bytes=?,margin_bytes=? WHERE bundle=?')
      .run(sourceBytes, inputBytes, bodyBytes, working, margin, input.bundle)
    this.database.prepare('UPDATE sync_snapshot_source_budget SET pending_bytes=? WHERE bundle=?').run(sourcePending, input.bundle)
  }

  /** 原始来源已提交、每批副本已提交及完整副本就绪，分别减少尚未执行的复制预约。 */
  sourceProgress(bundle: string, input: { frozen?: boolean; source?: string; copiedBytes?: number; ready?: boolean }): void {
    if (!this.path) return
    this.atomic(() => {
      const row = this.database.prepare(`SELECT s.pending_bytes,s.raw_complete,b.source_bytes FROM sync_snapshot_source_budget s
        JOIN sync_snapshot_resource_budget b USING(bundle) WHERE bundle=?`).get(bundle)
      if (!row) throw new Error('SNAPSHOT_SOURCE_RESERVATION_MISSING')
      if (input.copiedBytes != null) {
        if (!input.source || !Number.isSafeInteger(input.copiedBytes) || input.copiedBytes < 0) throw new Error('SNAPSHOT_SOURCE_PROGRESS_INVALID')
        this.database.prepare(`INSERT INTO sync_snapshot_source_copy_usage VALUES(?,?,?)
          ON CONFLICT(bundle,source) DO UPDATE SET copied_bytes=MAX(copied_bytes,excluded.copied_bytes)`)
          .run(bundle, input.source, input.copiedBytes)
      }
      const copied = Number(this.database.prepare('SELECT COALESCE(SUM(copied_bytes),0) AS bytes FROM sync_snapshot_source_copy_usage WHERE bundle=?').get(bundle)!.bytes)
      const rawComplete = input.frozen || Number(row.raw_complete)
      const remaining = Math.max(0, Number(row.source_bytes) * (rawComplete ? 1 : SOURCE_COPIES) - copied)
      const pending = input.ready ? 0 : Math.min(Number(row.pending_bytes), remaining)
      this.database.prepare('UPDATE sync_snapshot_source_budget SET pending_bytes=?,raw_complete=? WHERE bundle=?')
        .run(pending, input.frozen || Number(row.raw_complete) ? 1 : 0, bundle)
      this.expandLocked({ bundle })
    })
  }

  /** 扩张前读取文件系统可用空间，SQLite freelist 不计入物理释放。 */
  requireRemaining(bundle: string, nextBytes = 0): void {
    if (!this.path) return
    if (!this.reservation.get(bundle)) {
      throw new Error('SNAPSHOT_RESOURCE_RESERVATION_MISSING')
    }
    if (this.free() < this.reservedRemaining() + nextBytes) throw new Error('INSUFFICIENT_SPACE: Snapshot batch paused before disk expansion')
  }

  /** 已落盘页、索引和来源对象只计物理占用，预约只保留各作业尚未分配的增量。 */
  private reservedRemaining(): number {
    const rows = this.remaining.all()
    return rows.reduce((total, row) => total + Math.max(0, Number(row.working_bytes) - Number(row.allocated)) + Number(row.margin_bytes), 0)
  }

  /** 固定来源已转换并回收后，后续安装不继续预约新的 typed staging/副本。 */
  sourceRetired(bundle: string): void { if (this.path) this.expand({ bundle, sourceBytes: 0 }) }

  /** 真正完成才解除预约，取消、失败和旧页面发布都不构成完成。 */
  complete(bundle: string): void {
    this.atomic(() => {
      this.database.prepare('DELETE FROM sync_snapshot_resource_budget WHERE bundle=?').run(bundle)
      this.database.prepare('DELETE FROM sync_snapshot_source_budget WHERE bundle=?').run(bundle)
      this.database.prepare('DELETE FROM sync_snapshot_source_copy_usage WHERE bundle=?').run(bundle)
    })
  }

  /** 仅计算当前卷的真实可用字节，不读取正文内容。 */
  private free(): number { const disk = statfsSync(this.path); return disk.bavail * disk.bsize }

  /** 继承调用方已有短事务，不擅自提交或回滚业务批次。 */
  private atomic(action: () => void): void {
    if (this.database.isTransaction) { action(); return }
    this.database.exec('BEGIN IMMEDIATE')
    try { action(); this.database.exec('COMMIT') }
    catch (error) {
      // 预约失败显式回滚，不能留下虚假的容量占用或释放事实。
      this.database.exec('ROLLBACK'); throw error
    }
  }
}

/** typed staging 与固定转换副本的并存增量。 */
const SOURCE_COPIES = 2
/** 派生索引、合并工作集、输出及 WAL 的保守上界，后续按真实 fixture 校准。 */
const WORKING_COPIES = 5
/** 方案的初始最低余量，预算不足明确暂停。 */
const MINIMUM_MARGIN = 256 * 1024 * 1024
/** 预计新增工作集的百分之二十作为初始动态余量。 */
const MARGIN_DIVISOR = 5
/** SQLite 行头、键和源副本索引的初始空间估算，属于公开容量模型而非数据限制。 */
const ROW_STORAGE_OVERHEAD = 64

/** 标识符来自本机 schema，仍严格引用防止特殊表名改变 SQL。 */
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"` }
