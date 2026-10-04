import { AsyncLocalStorage } from 'node:async_hooks'

/** Worker 的根令牌与主进程各异步作业分别绑定，不混淆并行空间。 */
let cancellation: Int32Array | undefined
const owners = new AsyncLocalStorage<Int32Array>()

/** 每个 Worker 只有一个作业，标记在执行前一次绑定。 */
export function bindSnapshotCancellation(buffer: SharedArrayBuffer): void { cancellation = new Int32Array(buffer) }

/** 主进程 owner 的真实共享令牌传给所有子 Worker，阶段切换不会重置取消。 */
export function withSnapshotCancellation<T>(buffer: SharedArrayBuffer, action: () => T): T {
  return owners.run(new Int32Array(buffer), action)
}

export function snapshotCancellationBuffer(): SharedArrayBuffer | undefined {
  return (owners.getStore() ?? cancellation)?.buffer as SharedArrayBuffer | undefined
}

/** 取消只抛出真实错误，事务回滚和连接关闭仍由执行器 finally 完成。 */
export function snapshotCheckpoint(): void {
  const active = owners.getStore() ?? cancellation
  if (active && Atomics.load(active, 0)) {
    const error = new Error('SNAPSHOT_JOB_CANCELLED')
    error.name = 'AbortError'
    throw error
  }
}
