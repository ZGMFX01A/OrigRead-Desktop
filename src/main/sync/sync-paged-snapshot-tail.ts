import type { DatabaseSync } from 'node:sqlite'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type { SyncCoverage, SyncCoverageVector } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository } from './sync-state-repository'
import { canonicalJson } from './sync-operation-canonicalizer'
import { dependenciesSatisfied } from './sync-apply-dependencies'
import { commitSnapshotBatch } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import type { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'

interface Dependencies {
  database: DatabaseSync
  runtime: SyncRuntimeRepository
  state: SyncStateRepository
  budget: SyncSnapshotResourceBudget
  apply(operation: SyncOperationRecord): void
}

/** 每次仅装入一条原始签名操作；独立队列保留 GC 后仍需恢复的正文及重放进度。 */
export function preparePagedTail(deps: Dependencies, manifest: SyncPagedSnapshotManifest, previous: SyncCoverageVector): void {
  const lanes = new Set(manifest.lanes.map(lane => lane.replicationLaneId))
  let pending: PreparedTail[] = [], bytes = 0
  const commit = () => commitSnapshotBatch(deps.database, { job: manifest.snapshotBundleId,
    phase: `tail:${manifest.rootHash}`, cursor: pending.at(-1)!.operation.operationId, budget: deps.budget },
    () => { for (const entry of pending) retainOperation(deps, entry) })
  for (const id of operationIds(deps.database, manifest.syncSpaceId)) {
    snapshotCheckpoint()
    const operation = deps.runtime.findOperation(id)!
    if (!lanes.has(operation.replicationLaneId) || operation.sequence <= prefix(manifest.coverage, operation)) continue
    const entry = prepareOperation(deps, { bundleId: manifest.snapshotBundleId, operation })
    const size = Buffer.byteLength(entry.encoded)
    if (pending.length && (pending.length === TAIL_BATCH_ROWS || bytes + size > TAIL_BATCH_BYTES)) {
      commit(); pending = []; bytes = 0
    }
    pending.push(entry); bytes += size
  }
  if (pending.length) commit()
  validateTail(deps, manifest, previous)
}

interface PreparedTail { bundleId: string; operation: SyncOperationRecord; encoded: string; required: number }

/** 先关闭轻量 Dot 索引游标，再进入尾部写批次，不保留共享连接的旧读视图。 */
function *operationIds(database: DatabaseSync, space: string): Generator<string> {
  let after: [string, string, number] | undefined
  for (;;) {
    const seek = after ? ' AND (replication_lane_id,actor_incarnation_id,sequence)>(?,?,?)' : ''
    const rows = database.prepare(`SELECT operation_id,replication_lane_id,actor_incarnation_id,sequence FROM sync_operation_log o
      WHERE sync_space_id=? AND build_status='SIGNED' AND NOT EXISTS(
        SELECT 1 FROM sync_inbox_operation i WHERE i.operation_id=o.operation_id AND i.state='REJECTED') ${seek}
      ORDER BY replication_lane_id,actor_incarnation_id,sequence LIMIT ${TAIL_BATCH_ROWS}`).all(space, ...(after ?? []))
    if (!rows.length) return
    for (const row of rows) {
      after = [String(row.replication_lane_id), String(row.actor_incarnation_id), Number(row.sequence)]
      yield String(row.operation_id)
    }
  }
}

/** 重试不能改变签名内容，也不能清除已完成标记；本地入站状态允许等待中的操作稍后进入重放。 */
function prepareOperation(deps: Dependencies, input: { bundleId: string; operation: SyncOperationRecord }): PreparedTail {
  const { operation } = input
  const encoded = canonicalJson(JSON.stringify(operation))
  const old = deps.database.prepare(`SELECT operation_json FROM sync_paged_snapshot_tail
    WHERE snapshot_bundle_id=? AND operation_id=?`).get(input.bundleId, operation.operationId)
  if (old && signingContent(String(old.operation_json)) !== signingContent(encoded)) {
    throw new Error('REBASE_UNSAFE: retained tail changed its signed content')
  }
  const inbox = deps.database.prepare('SELECT state FROM sync_inbox_operation WHERE operation_id=?').get(operation.operationId)
  const required = !inbox || inbox.state === 'APPLIED' ? 1 : 0
  return { ...input, encoded, required }
}

/** 只提交已准备列，已完成 replay 标记不会因重入被清除。 */
function retainOperation(deps: Dependencies, input: PreparedTail): void {
  const { operation, encoded, required } = input
  deps.database.prepare(`INSERT INTO sync_paged_snapshot_tail(snapshot_bundle_id,operation_id,replication_lane_id,
    actor_incarnation_id,sequence,operation_json,replay_required) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_bundle_id,operation_id) DO UPDATE SET
      replay_required=MAX(sync_paged_snapshot_tail.replay_required,excluded.replay_required)`)
    .run(input.bundleId, operation.operationId, operation.replicationLaneId, operation.actorIncarnationId,
      operation.sequence, encoded, required)
}

/** 创建时间及本地构建状态不参与不可变签名比较，完整业务载荷仍保留。 */
function signingContent(encoded: string): string {
  const { createdAt, updatedAt, buildStatus, ...signed } = JSON.parse(encoded) as SyncOperationRecord
  void createdAt; void updatedAt; void buildStatus
  return canonicalJson(JSON.stringify(signed))
}

/** 仅连续真实 Dot 可以支持 retained/applied 前缀；索引按流排序，无操作数组。 */
function validateTail(deps: Dependencies, manifest: SyncPagedSnapshotManifest, previous: SyncCoverageVector): void {
  const ends: SyncCoverage = {}
  for (const row of deps.database.prepare(`SELECT replication_lane_id,actor_incarnation_id,sequence,replay_required
    FROM sync_paged_snapshot_tail WHERE snapshot_bundle_id=?
    ORDER BY replication_lane_id,actor_incarnation_id,sequence`).iterate(manifest.snapshotBundleId)) {
    const lane = String(row.replication_lane_id), actor = String(row.actor_incarnation_id), sequence = Number(row.sequence)
    const expected = (ends[lane]?.[actor] ?? manifest.coverage[lane]?.[actor] ?? 0) + 1
    // 未应用的乱序 Inbox 继续持久保留，但不能抬高连续前缀；已应用 tail 的缺口仍须拒绝。
    if (sequence !== expected) {
      if (Number(row.replay_required) === 1) throw new Error(`REBASE_UNSAFE: retained tail gap ${lane}/${actor}; expected ${expected}, got ${sequence}`)
      continue
    }
    ends[lane] ??= {}; ends[lane]![actor] = sequence
  }
  for (const lane of manifest.lanes.map(value => value.replicationLaneId)) {
    const actors = new Set([...Object.keys(previous.retained[lane] ?? {}), ...Object.keys(previous.applied[lane] ?? {})])
    for (const actor of actors) {
      const needed = Math.max(previous.retained[lane]?.[actor] ?? 0, previous.applied[lane]?.[actor] ?? 0)
      if ((ends[lane]?.[actor] ?? manifest.coverage[lane]?.[actor] ?? 0) < needed) {
        throw new Error(`REBASE_UNSAFE: retained tail cannot reconstruct ${lane}/${actor}=${needed}`)
      }
    }
  }
}

/** 单条投影与完成位在同一业务库事务提交，崩溃后不会重复改变已完成的投影。 */
export function replayPagedTail(deps: Dependencies, manifest: SyncPagedSnapshotManifest, previous: SyncCoverageVector): void {
  const progress = initialProgress(deps, manifest, previous)
  while (hasRemaining(deps, manifest.snapshotBundleId)) {
    let completed = false
    for (const id of pendingIds(deps.database, manifest.snapshotBundleId)) {
      const queued = deps.database.prepare(`SELECT operation_json FROM sync_paged_snapshot_tail
        WHERE snapshot_bundle_id=? AND operation_id=?`).get(manifest.snapshotBundleId, id)!
      const operation = JSON.parse(String(queued.operation_json)) as SyncOperationRecord
      if (operation.sequence !== prefix(progress, operation) + 1 || !dependenciesSatisfied(operation.dependencyDotsJson, progress)) continue
      deps.runtime.transaction(() => {
        deps.apply(operation)
        deps.database.prepare('UPDATE sync_paged_snapshot_tail SET replayed=1 WHERE snapshot_bundle_id=? AND operation_id=?')
          .run(manifest.snapshotBundleId, operation.operationId)
      })
      progress[operation.replicationLaneId] ??= {}
      progress[operation.replicationLaneId]![operation.actorIncarnationId] = operation.sequence
      completed = true
    }
    if (!completed) throw new Error('REBASE_UNSAFE: retained tail has unresolved causal dependencies')
  }
}

/** 重放只分页读取身份，写事务与当前读游标互不嵌套。 */
function *pendingIds(database: DatabaseSync, bundle: string): Generator<string> {
  let after = ''
  for (;;) {
    const rows = database.prepare(`SELECT operation_id FROM sync_paged_snapshot_tail WHERE snapshot_bundle_id=?
      AND replay_required=1 AND replayed=0 AND operation_id>? ORDER BY operation_id LIMIT ${TAIL_BATCH_ROWS}`).all(bundle, after)
    if (!rows.length) return
    for (const row of rows) { after = String(row.operation_id); yield after }
  }
}

/** 轻量进度来自已提交完成位；未选择的 lane 保留本地应用覆盖度。 */
function initialProgress(deps: Dependencies, manifest: SyncPagedSnapshotManifest, previous: SyncCoverageVector): SyncCoverage {
  const selected = new Set(manifest.lanes.map(lane => lane.replicationLaneId))
  const progress = Object.fromEntries(Object.entries(previous.applied).filter(([lane]) => !selected.has(lane)).map(([lane, actors]) => [lane, { ...actors }]))
  for (const [lane, actors] of Object.entries(manifest.coverage)) progress[lane] = { ...actors }
  for (const row of deps.database.prepare(`SELECT replication_lane_id,actor_incarnation_id,MAX(sequence) AS sequence
    FROM sync_paged_snapshot_tail WHERE snapshot_bundle_id=? AND replayed=1
    GROUP BY replication_lane_id,actor_incarnation_id`).iterate(manifest.snapshotBundleId)) {
    const lane = String(row.replication_lane_id), actor = String(row.actor_incarnation_id)
    progress[lane] ??= {}; progress[lane]![actor] = Math.max(progress[lane]![actor] ?? 0, Number(row.sequence))
  }
  return progress
}

/** 查询只读取存在性，避免为了判断余量加载正文。 */
function hasRemaining(deps: Dependencies, bundleId: string): boolean {
  return Boolean(deps.database.prepare(`SELECT 1 FROM sync_paged_snapshot_tail
    WHERE snapshot_bundle_id=? AND replay_required=1 AND replayed=0 LIMIT 1`).get(bundleId))
}

/** 读取指定 Dot 的逻辑前缀。 */
function prefix(coverage: SyncCoverage, operation: SyncOperationRecord): number {
  return coverage[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0
}

/** 尾部身份和已准备 DTO 的标准批次。 */
const TAIL_BATCH_ROWS = 256
/** 尾部 JSON 准备及写入的字节预算，大单条独占批次。 */
const TAIL_BATCH_BYTES = 2 * 1024 * 1024
