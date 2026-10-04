import type { DatabaseSync } from 'node:sqlite'
import { withSnapshotWriteOwner } from './sync-snapshot-access'
import { snapshotTraceRun } from './sync-snapshot-trace'
import { withSnapshotCancellation, snapshotCheckpoint } from './sync-snapshot-execution'

interface Input { space: string; identity: string; phase: string }

/** 所有重型入口共用独立控制库；活动执行器退出前不得覆盖空间所有权。 */
export class SyncSnapshotSpaceOwner {
  private readonly executors = new Map<string, SharedArrayBuffer>()
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS snapshot_space_owner(
      space TEXT PRIMARY KEY,identity TEXT NOT NULL,phase TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
      UPDATE snapshot_space_owner SET state='PAUSED' WHERE state IN ('RUNNING','CANCELLING')`)
  }

  /** 控制库的短受理事务不会访问业务库，固定输入与代次跨重启保留。 */
  claim(input: Input): number {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare('SELECT identity,generation,state FROM snapshot_space_owner WHERE space=?').get(input.space)
      if (row && ['RUNNING', 'CANCELLING'].includes(String(row.state))) throw new Error('SNAPSHOT_JOB_BUSY: Space has a live capture/merge/install executor')
      if (row && row.state !== 'COMPLETED' && row.identity !== input.identity) throw new Error('SNAPSHOT_JOB_CONFLICT: resume original fixed input')
      const generation = Number(row?.generation ?? 0) + 1
      this.database.prepare("INSERT OR REPLACE INTO snapshot_space_owner VALUES(?,?,?,?,'RUNNING')")
        .run(input.space, input.identity, input.phase, generation)
      this.database.exec('COMMIT')
      return generation
    } catch (error) {
      // 受理失败完整回滚，不侵占原执行器的持久身份。
      this.database.exec('ROLLBACK'); throw error
    }
  }

  /** 只有真实退出的本代执行器可以发布终态。 */
  finish(input: Input & { generation: number; state: string }): void {
    this.database.prepare('UPDATE snapshot_space_owner SET state=? WHERE space=? AND generation=?')
      .run(input.state, input.space, input.generation)
  }

  /** 同步合并仍使用同一空间所有权，失败保留原输入供重试。 */
  run<T>(input: Input, action: () => T): T {
    const generation = this.claim(input)
    try {
      const result = snapshotTraceRun({ identity: input.identity, generation }, () => withSnapshotWriteOwner(input.space, action))
      this.finish({ ...input, generation, state: 'COMPLETED' })
      return result
    } catch (error) {
      // 合并失败不是完成事实；原异常与固定输入一起保留。
      this.finish({ ...input, generation, state: terminalState(error) }); throw error
    }
  }

  /** 等待实际异步工作和 Worker exit 后才解除拥有权。 */
  async runAsync<T>(input: Input, action: () => Promise<T>): Promise<T> {
    const generation = this.claim(input)
    const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    this.executors.set(input.space, cancellation)
    try {
      const result = await withSnapshotCancellation(cancellation, () => snapshotTraceRun({ identity: input.identity, generation }, () => withSnapshotWriteOwner(input.space, action)))
      if (Atomics.load(new Int32Array(cancellation), 0)) { withSnapshotCancellation(cancellation, snapshotCheckpoint) }
      this.finish({ ...input, generation, state: 'COMPLETED' })
      return result
    } catch (error) {
      // 取消与异常都必须等 action 实际退出，不能由等待者提前释放。
      this.finish({ ...input, generation, state: terminalState(error) }); throw error
    } finally { this.executors.delete(input.space) }
  }

  /** 显式用户暂停通知所有实际子 Worker，控制状态直到 runAsync 真实退出才变为 PAUSED。 */
  requestCancel(space: string): void {
    const cancellation = this.executors.get(space)
    if (!cancellation) return
    this.database.prepare("UPDATE snapshot_space_owner SET state='CANCELLING',phase='CANCEL_REQUESTED' WHERE space=? AND state='RUNNING'").run(space)
    Atomics.store(new Int32Array(cancellation), 0, 1)
  }
}

/** 用户取消和容量不足保留可恢复 PAUSED，其余故障保留原始错误。 */
function terminalState(error: unknown): string {
  return error instanceof Error && (error.name === 'AbortError' || error.message.startsWith('SNAPSHOT_JOB_CANCELLED:') ||
    error.message.startsWith('INSUFFICIENT_SPACE:') || error.message.startsWith('MORE_WORK:')) ? 'PAUSED' : 'FAILED'
}
