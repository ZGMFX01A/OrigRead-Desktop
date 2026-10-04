import { AsyncLocalStorage } from 'node:async_hooks'
import { sha256Hex } from './sync-operation-canonicalizer'
import type { DatabaseSync } from 'node:sqlite'

export interface SnapshotTraceIdentity { runId: string; ownerGeneration: number; inputRootDigest: string }
type Run = SnapshotTraceIdentity
interface Span { run: Run; id: number; parent?: Span; phase: string; started: bigint; childNanos: bigint;
  rows: number; bytes: number; sources: number; signatureChecks: number; lockNanos: bigint; transactionNanos: bigint; queries: Map<string, number>;
  batches?: { count: number; maxTransactionMs: number; maxLockMs: number; transactionBuckets: number[] }; lastBatchLog?: bigint }
/** 作业和嵌套阶段随异步上下文传播，不输出正文、签名或绑定值。 */
const context = new AsyncLocalStorage<{ run: Run; span?: Span }>()
let sequence = 0
/** 纳秒仅在输出时换算为毫秒。 */
const NANOS_PER_MS = 1_000_000
/** 批次日志每秒采样，错误和超过 p95 门槛的事务仍逐次输出。 */
const BATCH_LOG_INTERVAL_NANOS = 1_000_000_000n
/** 直方图包含文档 500 ms 和 2 s 门槛，所有批次都计数，不用采样事件计算 p95。 */
const TRANSACTION_BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2000, Number.POSITIVE_INFINITY] as const
/** 超过文档 p95 门槛的批次必须保留单独事件。 */
const SLOW_TRANSACTION_MS = 500

/** 将实际空间 owner 的身份传入 Worker，禁止由 Worker 猜测或固定代次。 */
export function snapshotTraceIdentity(): SnapshotTraceIdentity | undefined { return context.getStore()?.run }

/** 控制线程与实际执行器沿用同一身份；直接工具调用没有 owner 时不生成虚假身份。 */
export function continueSnapshotTrace<T>(identity: SnapshotTraceIdentity | undefined, action: () => T): T {
  return identity ? context.run({ run: identity }, action) : action()
}

/** 同一固定输入和 owner 代次形成一致的运行身份，可由真实 Worker 独立接续。 */
export function snapshotTraceRun<T>(input: { identity: string; generation: number }, action: () => T): T {
  const digest = sha256Hex(input.identity)
  const run = { runId: `${digest}:${input.generation}`, ownerGeneration: input.generation, inputRootDigest: digest }
  return context.run({ run }, action)
}

/** 同步 CPU/SQL 阶段记录父子耗时，父 inclusive 不与子耗时相加。 */
export function snapshotTracePhase<T>(phase: string, action: () => T): T {
  const owner = context.getStore()
  if (!owner) return action()
  const span: Span = { run: owner.run, id: ++sequence, parent: owner.span, phase, started: process.hrtime.bigint(),
    childNanos: 0n, rows: 0, bytes: 0, sources: 0, signatureChecks: 0, lockNanos: 0n, transactionNanos: 0n, queries: new Map() }
  return context.run({ run: owner.run, span }, () => {
    if (!phase.startsWith('batch.')) event(span, 'begin')
    try {
      const result = action()
      // Worker 阶段可能返回真实 Promise；只在实际退出后关闭 span。
      if (result instanceof Promise) return result.then(value => { finish(span); return value },
        error => { finish(span, error); throw error }) as T
      finish(span); return result
    }
    catch (error) { finish(span, error); throw error }
  })
}

/** 单批计数只保存数值，不保留输入对象或字符串正文。 */
export function snapshotTraceWork(input: { rows?: number; bytes?: number; sources?: number; signatureChecks?: number }): void {
  const span = context.getStore()?.span
  if (!span) return
  span.rows += input.rows ?? 0; span.bytes += input.bytes ?? 0; span.sources += input.sources ?? 0
  span.signatureChecks += input.signatureChecks ?? 0
}

/** 查询归并前消除字面值，事务计时由取得锁与实际退出两个边界提供。 */
export function snapshotTraceSql(input: { sql?: string; fingerprint?: string; lockNanos?: bigint; transactionNanos?: bigint }): void {
  const span = context.getStore()?.span
  if (!span) return
  if (input.sql || input.fingerprint) {
    const digest = input.fingerprint ?? snapshotSqlFingerprint(input.sql!)
    span.queries.set(digest, (span.queries.get(digest) ?? 0) + 1)
  }
  span.lockNanos += input.lockNanos ?? 0n; span.transactionNanos += input.transactionNanos ?? 0n
}

/** 同一 prepared statement 只计算一次脱敏指纹，执行次数仍逐次计入当前 span。 */
export function snapshotSqlFingerprint(sql: string): string {
  return sha256Hex(sql.replace(/'(?:''|[^'])*'|\b[0-9]+(?:\.[0-9]+)?\b/g, '?').replace(/\s+/g, ' ').trim().toUpperCase())
}

/** 私有页连接只添加实际 SQL 计数；不引入业务围栏、事务或替代数据库结果。 */
export function tracedSnapshotDatabase(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') return (sql: string) => { snapshotTraceSql({ sql }); return target.exec(sql) }
      if (property === 'prepare') return (sql: string) => {
        return tracedStatement(target.prepare(sql), snapshotSqlFingerprint(sql))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** 指纹随固定原生语句复用，执行次数在当前阶段逐次登记。 */
function tracedStatement(statement: ReturnType<DatabaseSync['prepare']>, fingerprint: string): ReturnType<DatabaseSync['prepare']> {
  return new Proxy(statement, {
    get(value, member) {
      const method = Reflect.get(value, member, value)
      if (['run', 'get', 'all', 'iterate'].includes(String(member))) return (...args: unknown[]) => {
        snapshotTraceSql({ fingerprint }); return Reflect.apply(method, value, args)
      }
      return typeof method === 'function' ? method.bind(value) : method
    }
  })
}

/** 子 span 只向直接父级归还一次时间，错误继续保留原始异常。 */
function finish(span: Span, error?: unknown): void {
  const elapsed = process.hrtime.bigint() - span.started
  if (span.parent) {
    span.parent.childNanos += elapsed
    span.parent.rows += span.rows; span.parent.bytes += span.bytes; span.parent.sources += span.sources
    span.parent.signatureChecks += span.signatureChecks
    for (const [digest, count] of span.queries) span.parent.queries.set(digest, (span.parent.queries.get(digest) ?? 0) + count)
    if (span.phase.startsWith('batch.')) {
      recordBatch(span.parent, span)
      const now = process.hrtime.bigint()
      if (!error && Number(span.transactionNanos) / NANOS_PER_MS <= SLOW_TRANSACTION_MS &&
        now - (span.parent.lastBatchLog ?? 0n) < BATCH_LOG_INTERVAL_NANOS) return
      span.parent.lastBatchLog = now
    }
  }
  event(span, error ? 'failed' : 'end', error)
}

/** 全量批次统计是固定数量标量，日志限频不丢失事务门槛证据。 */
function recordBatch(parent: Span, span: Span): void {
  const batches = parent.batches ??= { count: 0, maxTransactionMs: 0, maxLockMs: 0, transactionBuckets: TRANSACTION_BUCKETS_MS.map(() => 0) }
  const transactionMs = Number(span.transactionNanos) / NANOS_PER_MS
  batches.count++; batches.maxTransactionMs = Math.max(batches.maxTransactionMs, transactionMs)
  batches.maxLockMs = Math.max(batches.maxLockMs, Number(span.lockNanos) / NANOS_PER_MS)
  batches.transactionBuckets[TRANSACTION_BUCKETS_MS.findIndex(limit => transactionMs <= limit)]!++
}

/** 诊断失败明确写 stderr，但不改变业务事务结果；作业 receipt 不使用此可选路径。 */
function event(span: Span, state: string, error?: unknown): void {
  const elapsed = process.hrtime.bigint() - span.started
  try {
    console.info('R11Snapshot', JSON.stringify({ ...span.run, spanId: span.id, parentSpanId: span.parent?.id,
      phase: span.phase, event: state, processedRows: span.rows, processedBytes: span.bytes, uniqueSourceCount: span.sources,
      signatureVerificationCount: span.signatureChecks,
      inclusiveMs: Number(elapsed) / NANOS_PER_MS, exclusiveMs: Number(elapsed - span.childNanos) / NANOS_PER_MS,
      lockWaitMs: Number(span.lockNanos) / NANOS_PER_MS, transactionHoldMs: Number(span.transactionNanos) / NANOS_PER_MS,
      runtimeMemory: process.memoryUsage(),
      batchTransactions: span.batches,
      sqlFingerprints: Object.fromEntries(span.queries), error: error instanceof Error ? error.name : undefined }))
  } catch (failure) { console.error('R11 snapshot diagnostic emission failed', failure) }
}
