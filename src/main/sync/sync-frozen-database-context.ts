import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'

/** 只在冻结转换作用域内选择固定来源，业务写入继续使用其显式注入的活库。 */
const frozen = new AsyncLocalStorage<ReadonlyMap<DatabaseSync, DatabaseSync>>()

/** 已绑定作用域缺少来源属于实现错误，不允许悄悄读取当前业务库。 */
export function frozenSnapshotDatabase(live: DatabaseSync): DatabaseSync {
  const context = frozen.getStore()
  if (!context) return live
  const source = context.get(live)
  if (source) return source
  if ([...context.values()].includes(live)) return live
  throw new Error('SNAPSHOT_FROZEN_SOURCE_MISSING')
}

/** 输入 map 按值复制，异步后继不能改变当前切点的来源身份。 */
export function withFrozenSnapshotDatabase<T>(input: { live: DatabaseSync; source: DatabaseSync }, action: () => T): T {
  return frozen.run(new Map([[input.live, input.source]]), action)
}

/** 来源副本只读附加的输出索引，避免把当前派生页表混入原始 cut。 */
export function snapshotCaptureRecordTable(): string {
  return frozen.getStore() ? 'page_output.sync_paged_snapshot_record' : 'sync_paged_snapshot_record'
}
