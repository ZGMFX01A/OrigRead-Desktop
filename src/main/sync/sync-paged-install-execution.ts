import type { DatabaseSync } from 'node:sqlite'
import type { SyncCoverageVector } from '../../shared/sync-protocol'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository } from './sync-state-repository'
import { preparePagedTail, replayPagedTail } from './sync-paged-snapshot-tail'
import { readPagedInstallJournal, writePagedInstallJournal } from './sync-paged-install-journal'
import { readSnapshotInstallReady, recordSnapshotInstallReady } from './sync-snapshot-install-journal'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import type { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'
import { snapshotTracePhase } from './sync-snapshot-trace'
import { SNAPSHOT_PUBLICATION_ATTEMPTS, snapshotRevisionConflict, snapshotNeedsStableInput } from './sync-snapshot-revalidation'

interface Dependencies {
  database: DatabaseSync
  runtime: SyncRuntimeRepository
  state: SyncStateRepository
  budget: SyncSnapshotResourceBudget
  apply(operation: SyncOperationRecord): void
  materialize(): number
  requireRecovery(): never
  prepare(): void
  requirePrepared(): void
  requireBodies(): void
  completeSources(): void
  beginFence(): void
}
interface Input { localAccountId: number; manifest: SyncPagedSnapshotManifest; now: number }

/** 分页安装使用独立持久 journal；baseline 重试与 tail 重试分开，不重复覆盖已重放的业务值。 */
export function executePagedInstall(deps: Dependencies, input: Input): {
  snapshotBundleId: string; syncSpaceId: string; materializedEntities: number; rebasedLanes: string[]
} {
  const { manifest, now } = input
  const binding = deps.runtime.findBinding(input.localAccountId)
  if (!binding || binding.syncSpaceId !== manifest.syncSpaceId) throw new Error('SPACE_MISMATCH: paged Snapshot has no matching binding')
  const ready = readSnapshotInstallReady(deps.database, manifest.syncSpaceId)
  const result = { snapshotBundleId: manifest.snapshotBundleId, syncSpaceId: manifest.syncSpaceId,
    materializedEntities: 0, rebasedLanes: manifest.lanes.map(lane => lane.replicationLaneId) }
  if (ready?.snapshotBundleId === manifest.snapshotBundleId && ready.rootHash === manifest.rootHash &&
    ['ACTIVE','STAGING'].includes(binding.lifecycleState) && result.rebasedLanes.every(lane => ready.installedLanes.includes(lane))) {
    deps.beginFence()
    deps.requireBodies()
    return result
  }
  const unfinished = deps.database.prepare(`SELECT target_snapshot_bundle_id FROM sync_recovery_capsule
    WHERE sync_space_id=? AND capsule_id LIKE 'paged-install:%'
    AND reason IN ('SNAPSHOT_INSTALL_STARTED','SNAPSHOT_BASELINE_READY') LIMIT 1`).get(manifest.syncSpaceId)
  if (unfinished && unfinished.target_snapshot_bundle_id !== manifest.snapshotBundleId) {
    throw new Error('REBASE_UNSAFE: finish persisted Snapshot installation before changing baseline')
  }
  const journal = readPagedInstallJournal(deps.database, manifest)
  const previous = mergeCoverage(journal?.previous, deps.state.getCoverage(manifest.syncSpaceId))
  requireRecoverable(deps, manifest, previous)
  deps.beginFence()
  preparePagedTail(deps, manifest, previous)
  deps.runtime.transaction(() => {
    writePagedInstallJournal(deps.database, { manifest, previous, baselineReady: journal?.baselineReady ?? false, now })
    deps.runtime.upsertBinding({ ...binding, lifecycleState: 'REBASE_PREPARE', updatedAt: now })
  })
  if (!journal?.baselineReady) {
    deps.runtime.transaction(() => deps.runtime.upsertSnapshotBundle({ snapshotBundleId: manifest.snapshotBundleId, syncSpaceId: manifest.syncSpaceId,
      genesisSessionId: manifest.snapshotBundleId, genesisBaselineId: manifest.genesisBaselineId, snapshotClass: manifest.snapshotClass,
      authStabilityCheckpointId: manifest.authStabilityCheckpoint ?? null, rootHash: manifest.rootHash,
      policyHash: manifest.policyHash, capturedAt: manifest.capturedAt, createdAt: now }))
    result.materializedEntities = deps.materialize()
    deps.runtime.transaction(() => {
      deps.state.rebaseSnapshotCoverage(manifest.syncSpaceId, manifest.coverage, now)
      writePagedInstallJournal(deps.database, { manifest, previous, baselineReady: true, now })
    })
  }
  replayPagedTail(deps, manifest, previous)
  deps.requireBodies()
  publishCompleted(deps, { ...input, previous })
  return result
}

/** 证明失效必须先回滚发布事务，重新在事务外核对完整输入；其他错误直接暴露。 */
function publishCompleted(deps: Dependencies, input: Input & { previous: SyncCoverageVector }): void {
  for (let attempt = 0; attempt < SNAPSHOT_PUBLICATION_ATTEMPTS; attempt++) {
    snapshotCheckpoint()
    try {
      deps.prepare()
      deps.completeSources()
      snapshotTracePhase('install.final-publish', () => deps.runtime.transaction(() => {
        deps.requirePrepared()
        const binding = deps.runtime.findBinding(input.localAccountId)
        if (!binding || binding.syncSpaceId !== input.manifest.syncSpaceId) throw new Error('SPACE_MISMATCH: install binding changed')
        restoreCoverage(deps.state, input)
        recordSnapshotInstallReady(deps.database, input.manifest.syncSpaceId, { snapshotBundleId: input.manifest.snapshotBundleId,
          rootHash: input.manifest.rootHash, installedLanes: input.manifest.lanes.map(lane => lane.replicationLaneId) }, input.now)
        deps.runtime.upsertBinding({ ...binding, lifecycleState: 'STAGING', updatedAt: input.now })
      }))
      return
    } catch (error) {
      // 只有可证实的修订竞争重新准备，取消和原始错误保持明确。
      if (!snapshotRevisionConflict(error)) throw error
    }
  }
  snapshotNeedsStableInput()
}

/** 未构建 Outbox 与已压缩历史均有真实恢复要求，不能把失败当成可安装的空 tail。 */
function requireRecoverable(deps: Dependencies, manifest: SyncPagedSnapshotManifest, previous: SyncCoverageVector): void {
  if (deps.database.prepare(`SELECT 1 FROM sync_outbox WHERE sync_space_id=? AND status='PENDING_BUILD'
    AND genesis_included_at IS NULL LIMIT 1`).get(manifest.syncSpaceId)) throw new Error('REBASE_UNSAFE: build and sign local Outbox before Snapshot installation')
  for (const lane of manifest.lanes.map(value => value.replicationLaneId)) {
    if (Object.entries(previous.stableGc[lane] ?? {}).some(([actor, prefix]) => prefix > (manifest.coverage[lane]?.[actor] ?? 0))) {
      deps.requireRecovery()
    }
  }
}

/** 合并轻量前缀不修改调用方值，也不凭页数量扩展 retained。 */
function mergeCoverage(left: SyncCoverageVector | undefined, right: SyncCoverageVector): SyncCoverageVector {
  const merged = {} as SyncCoverageVector
  for (const kind of ['received','applied','retained','snapshot','stableGc'] as const) {
    merged[kind] = Object.fromEntries([...new Set([...Object.keys(left?.[kind] ?? {}), ...Object.keys(right[kind])])].map(lane =>
      [lane, Object.fromEntries([...new Set([...Object.keys(left?.[kind][lane] ?? {}), ...Object.keys(right[kind][lane] ?? {})])].map(actor =>
        [actor, Math.max(left?.[kind][lane]?.[actor] ?? 0, right[kind][lane]?.[actor] ?? 0)]))]))
  }
  return merged
}

/** 原覆盖度只有在原始 tail 已完成后恢复，同时保留安装期间新收到的前缀。 */
function restoreCoverage(state: SyncStateRepository, input: { manifest: SyncPagedSnapshotManifest; previous: SyncCoverageVector; now: number }): void {
  const previous = mergeCoverage(input.previous, state.getCoverage(input.manifest.syncSpaceId))
  for (const lane of input.manifest.lanes.map(value => value.replicationLaneId)) {
    const actors = new Set(Object.values(previous).flatMap(vector => Object.keys(vector[lane] ?? {})))
    for (const actor of actors) state.upsertCoverage(input.manifest.syncSpaceId, lane, actor, {
      receivedPrefix: previous.received[lane]?.[actor] ?? 0, appliedPrefix: previous.applied[lane]?.[actor] ?? 0,
      retainedPrefix: previous.retained[lane]?.[actor] ?? 0, stableGcPrefix: previous.stableGc[lane]?.[actor] ?? 0 }, input.now)
  }
}
