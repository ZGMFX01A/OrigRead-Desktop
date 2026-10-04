import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../database/migrations'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { sha256Hex } from './sync-operation-canonicalizer'
import { existsSync, unlinkSync } from 'node:fs'
import { copyRawSnapshotTable, type SourceCopyProgress } from './sync-raw-snapshot-copy'
import { tracedSnapshotDatabase } from './sync-snapshot-trace'

interface Table { name: string; sql: string }

/** 源库 typed staging 只复制 SQL 列，长记录编码、摘要和正文读取发生在屏障外。 */
export class SyncRawSnapshotFreeze {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_raw_cut(cut TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_snapshot_raw_table(cut TEXT NOT NULL,name TEXT NOT NULL,ddl TEXT NOT NULL,PRIMARY KEY(cut,name))`)
  }

  /** 转换和实际发布完成后按小批次回收固定 cut，未完成的输入永不按 TTL 删除。 */
  retire(cut: string): void {
    const receipt = this.database.prepare('SELECT version FROM sync_snapshot_raw_cut WHERE cut=?').get(cut)
    const tables = this.database.prepare('SELECT name FROM sync_snapshot_raw_table WHERE cut=? ORDER BY name').all(cut)
    if (!receipt && tables.length) throw new Error('SNAPSHOT_RAW_RECEIPT_MISSING: raw table inventory has no cut receipt')
    for (const table of tables) {
      const raw = quote(`sync_raw_v${receipt!.version}_${table.name}`)
      for (;;) {
        snapshotCheckpoint()
        const result = this.database.prepare(`DELETE FROM ${raw} WHERE rowid IN (SELECT rowid FROM ${raw} WHERE raw_cut=? LIMIT ${GC_ROWS})`).run(cut)
        if (Number(result.changes) === 0) break
      }
    }
    this.database.prepare('DELETE FROM sync_snapshot_raw_table WHERE cut=?').run(cut)
    this.database.prepare('DELETE FROM sync_snapshot_raw_cut WHERE cut=?').run(cut)
    const path = String(this.database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file)
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${path}.snapshot-source-${sha256Hex(cut)}${suffix}`
      if (existsSync(source)) unlinkSync(source)
    }
  }

  /** 源事实与完成回执同事务提交，既有完整 cut 不读取当前活表补齐。 */
  capture(cut: string): void {
    if (this.complete(cut)) return
    const version = this.version()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const table of this.tables()) {
        snapshotCheckpoint()
        const raw = quote(`sync_raw_v${version}_${table.name}`)
        this.database.exec(`CREATE TABLE IF NOT EXISTS ${raw} AS SELECT CAST('' AS TEXT) raw_cut,rowid raw_rowid,* FROM ${quote(table.name)} WHERE 0`)
        this.database.exec(`CREATE INDEX IF NOT EXISTS ${quote(`sync_raw_v${version}_${table.name}_cut`)} ON ${raw}(raw_cut,raw_rowid)`)
        this.database.prepare(`INSERT INTO ${raw} SELECT ?,rowid,* FROM ${quote(table.name)}`).run(cut)
        this.database.prepare('INSERT INTO sync_snapshot_raw_table VALUES(?,?,?)').run(cut, table.name, table.sql)
      }
      this.database.prepare("INSERT INTO sync_snapshot_raw_cut VALUES(?,?,'COMPLETE')").run(cut, version)
      this.database.exec('COMMIT')
    } catch (error) {
      // 唯一源库中数据与回执一起回滚，不发布没有真实冻结事实的切点。
      this.database.exec('ROLLBACK'); throw error
    }
  }

  /** 固定来源版本与完整完成回执共同决定能否重用。 */
  complete(cut: string): boolean {
    const row = this.database.prepare('SELECT version,state FROM sync_snapshot_raw_cut WHERE cut=?').get(cut)
    if (row && Number(row.version) !== this.version()) throw new Error('SNAPSHOT_RAW_SCHEMA_CHANGED')
    return row?.state === 'COMPLETE'
  }

  /** 副本仅供固定来源转换；初始化正式 schema 后复制同一 cut 的 SQL 列。 */
  open(cut: string, progress?: SourceCopyProgress): DatabaseSync {
    if (!this.complete(cut)) throw new Error('SNAPSHOT_RAW_INCOMPLETE')
    const path = this.database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
    if (typeof path !== 'string' || !path) throw new Error('SNAPSHOT_RAW_SOURCE_PATH_MISSING')
    const source = new DatabaseSync(`${path}.snapshot-source-${sha256Hex(cut)}`)
    try {
      applyMigrations(source)
      source.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      source.exec('PRAGMA foreign_keys=OFF')
      source.prepare('ATTACH DATABASE ? AS raw_source').run(path)
      this.copy(source, cut, progress)
      source.exec('DETACH DATABASE raw_source; PRAGMA foreign_keys=ON')
      if (source.prepare('PRAGMA foreign_key_check').get()) throw new Error('SNAPSHOT_RAW_FOREIGN_KEY_MISMATCH')
      source.prepare('ATTACH DATABASE ? AS page_output').run(path)
      return tracedSnapshotDatabase(source)
    } catch (error) {
      // 失败只关闭私有副本，源事实与原始固定切点保留供重入诊断。
      source.close(); throw error
    }
  }

  /** 用 cut 当时表清单恢复，之后新建的辅助表不能混入这次来源。 */
  private copy(target: DatabaseSync, cut: string, progress?: SourceCopyProgress): void {
    const tables = this.database.prepare('SELECT name,ddl AS sql FROM sync_snapshot_raw_table WHERE cut=? ORDER BY name').all(cut) as unknown as Table[]
    for (const table of tables) copyRawSnapshotTable(target, { cut, version: this.version(), table: table.name, ddl: table.sql, progress })
  }

  /** 派生分页区及迁移标记不是业务源事实，不复制回源库产生递归膨胀。 */
  private tables(): Table[] {
    return this.database.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'sync_raw_%' AND name NOT LIKE 'sync_paged_%' AND name NOT LIKE 'sync_snapshot_%'
      AND name <> 'schema_migrations' ORDER BY name`).all() as unknown as Table[]
  }

  /** Desktop 正式 schema 版本由同库迁移账本声明。 */
  private version(): number { return Number(this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version) }
}

/** 派生清理不扩大本库写事务，也不执行 VACUUM。 */
const GC_ROWS = 256

/** 标识符仅来自本机 schema，动态 cut 仍使用 SQL 参数。 */
function quote(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid local snapshot table identifier')
  return `"${name}"`
}
