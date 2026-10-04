import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { openSnapshotControlDatabase } from './sync-snapshot-control-database'
import { snapshotTraceSql, snapshotSqlFingerprint } from './sync-snapshot-trace'

/** 当前执行器空间由异步上下文传播；数据库访问许可不保存在共享业务表内。 */
const owners = new AsyncLocalStorage<string>()
/** 正式可见业务图的表名，不将授权、Inbox 或作业控制表归入业务投影。 */
const BUSINESS_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"\[]?(?:articles|feeds|groups|llm_[A-Za-z0-9_]+|sync_config_document|article_filter_rules)\b/i
/** 有明确账户条件的本机 SQL 只检查对应空间；全局查询必须排除所有未完成安装。 */
const ACCOUNT_FILTER = /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?account_id\s*=\s*\?/i

/** 可信执行器的限定上下文，不改变原数据库连接或 SQL 语义。 */
export function withSnapshotWriteOwner<T>(space: string, action: () => T): T { return owners.run(space, action) }

/** 各连接共用独立持久围栏，重启后未完成的 baseline 仍不能对外可见或接受业务写入。 */
export class SnapshotInstallFence {
  private readonly control: DatabaseSync
  private readonly allFences: ReturnType<DatabaseSync['prepare']>
  private readonly accountFences: ReturnType<DatabaseSync['prepare']>
  constructor(path: string) {
    this.control = openSnapshotControlDatabase(path)
    this.control.exec(`PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshot_install_fence(
      space TEXT PRIMARY KEY,account INTEGER NOT NULL,root TEXT NOT NULL,scope TEXT NOT NULL,generation INTEGER NOT NULL)`)
    this.allFences = this.control.prepare('SELECT space FROM snapshot_install_fence')
    this.accountFences = this.control.prepare('SELECT space FROM snapshot_install_fence WHERE account=?')
  }

  /** 开始安装前固定 root/scope/ownerGeneration，已有未完成身份不允许被新输入覆盖。 */
  begin(input: { space: string; account: number; root: string; scope: string }): void {
    const owner = this.control.prepare("SELECT generation FROM snapshot_space_owner WHERE space=? AND state='RUNNING'").get(input.space)
    if (!owner || owners.getStore() !== input.space) throw new Error('SNAPSHOT_JOB_OWNER_MISSING')
    const previous = this.control.prepare('SELECT root,scope FROM snapshot_install_fence WHERE space=?').get(input.space)
    if (previous && (previous.root !== input.root || previous.scope !== input.scope)) throw new Error('SNAPSHOT_JOB_CONFLICT: unfinished install fence differs')
    this.control.prepare('INSERT OR REPLACE INTO snapshot_install_fence VALUES(?,?,?,?,?)')
      .run(input.space, input.account, input.root, input.scope, Number(owner.generation))
  }

  /** 完整同库回执、固定尾部与正文审计成功以后才解除围栏。 */
  complete(input: { space: string; root: string }): void {
    this.control.prepare('DELETE FROM snapshot_install_fence WHERE space=? AND root=?').run(input.space, input.root)
  }

  /** 每次语句执行重新检查，缓存的 prepared statement 不能绕过后来开始的安装。 */
  requireAllowed(sql: string, arguments_: readonly unknown[]): void {
    if (!BUSINESS_TABLE.test(sql)) return
    const match = ACCOUNT_FILTER.exec(sql)
    const account = match ? arguments_[sql.slice(0, match.index).split('?').length - 1] : undefined
    const rows = account == null ? this.allFences.all() : this.accountFences.all(Number(account))
    if (rows.some(row => row.space !== owners.getStore())) throw new Error('SYNC_INSTALLING_RETRYABLE: account Snapshot is not yet complete')
  }

  /** 控制连接随所属真实业务连接一起退出。 */
  close(): void { if (this.control.isOpen) this.control.close() }
}

/** 包装正式 SQLite 连接及每个缓存语句，结果、绑定值与原生异常原样保留。 */
export function guardedSnapshotDatabase(database: DatabaseSync, fence: SnapshotInstallFence): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => statement({ value: target.prepare(sql), database: target, sql, fence })
      if (property === 'exec') return (sql: string) => execute({ database: target, sql, fence, arguments: [] }, () => target.exec(sql))
      if (property === 'close') return () => { try { target.close() } finally { fence.close() } }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** 查询迭代器开始时检查持久 fence；写操作的检查与实际 SQL 在同一同步执行段。 */
function statement(input: { value: ReturnType<DatabaseSync['prepare']>; database: DatabaseSync; sql: string; fence: SnapshotInstallFence }): ReturnType<DatabaseSync['prepare']> {
  const fingerprint = snapshotSqlFingerprint(input.sql)
  return new Proxy(input.value, {
    get(target, property) {
      const member = Reflect.get(target, property, target)
      if (['run','get','all','iterate'].includes(String(property))) return (...arguments_: unknown[]) => {
        return execute({ ...input, fingerprint, arguments: arguments_ }, () => Reflect.apply(member, target, arguments_))
      }
      return typeof member === 'function' ? member.bind(target) : member
    }
  })
}

/** autocommit 写入先取得真实业务写锁，之后检查 fence；已排队 SQL 不能沿用旧的访问许可。 */
function execute<T>(input: { database: DatabaseSync; sql: string; fingerprint?: string; fence: SnapshotInstallFence; arguments: readonly unknown[] }, action: () => T): T {
  snapshotTraceSql({ sql: input.sql, fingerprint: input.fingerprint })
  const ownTransaction = WRITE_SQL.test(input.sql) && !input.database.isTransaction
  const waiting = process.hrtime.bigint()
  if (ownTransaction) input.database.exec('BEGIN IMMEDIATE')
  const started = process.hrtime.bigint()
  if (ownTransaction) snapshotTraceSql({ lockNanos: started - waiting })
  try {
    input.fence.requireAllowed(input.sql, input.arguments)
    const result = action()
    if (ownTransaction) { input.database.exec('COMMIT'); snapshotTraceSql({ transactionNanos: process.hrtime.bigint() - started }) }
    return result
  } catch (error) {
    // 不结束调用方的事务；原本单语句写入的检查与数据失败共同回滚。
    if (ownTransaction) input.database.exec('ROLLBACK')
    throw error
  }
}

/** 仅改变原本 autocommit 的写语句边界，读游标与显式事务保持原行为。 */
const WRITE_SQL = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i
