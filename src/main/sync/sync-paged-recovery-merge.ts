import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncCoverage } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncSnapshotPageWriter } from './sync-snapshot-page-writer'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { encodeGenesisFrontiers } from './sync-genesis-codec'
import { pagedSnapshotRoot, pagedSnapshotSigningMaterial } from './sync-paged-snapshot-wire'
import { mergePagedEntities, type RecoveryIndex } from './sync-paged-recovery-entities'
import { mergePagedBlobs } from './sync-paged-recovery-blobs'
import { reconcilePagedRecoveryGraph } from './sync-paged-recovery-graph'
import { reconcilePagedAliasDeletes } from './sync-paged-recovery-alias-deletes'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { snapshotTracePhase } from './sync-snapshot-trace'
import { SyncBufferedSnapshotCapture } from './sync-buffered-snapshot-capture'
import { SNAPSHOT_PUBLICATION_ATTEMPTS, snapshotRevisionConflict, snapshotNeedsStableInput } from './sync-snapshot-revalidation'

/** 只接管当前派生表示的断点，旧未完成索引保留原历史但不能混入新输出。 */
const PIPELINE_VERSION = 3

interface Dependencies {
  runtime: SyncRuntimeRepository
  store: SyncPagedSnapshotStore
  validate(manifest: SyncPagedSnapshotManifest): void
  createWriter(bundleId: string): SyncSnapshotPageWriter
  sign(deviceId: string, material: string): string
  requirePrepared?(manifest: SyncPagedSnapshotManifest): void
}
interface Input { local: SyncPagedSnapshotManifest; target: SyncPagedSnapshotManifest; now: number }

/** 新合并保持稳定策略身份；单独的输出命名空间禁止复用旧版内容派生策略的已签名对象。 */
const MERGE_BUNDLE_PREFIX = 'snapshot:merge:stable-policy:'

/** 恢复在磁盘索引中合并两个完整固定视图，不把任一 lane 读成业务数组。 */
export function mergePagedRecovery(deps: Dependencies, input: Input): SyncPagedSnapshotManifest {
  deps.validate(input.local); deps.validate(input.target)
  const prepared = preparePagedRecovery(deps, input)
  const manifest = prepared.authorSignature ? prepared : { ...prepared,
    authorSignature: deps.sign(prepared.authorDeviceId, pagedSnapshotSigningMaterial(prepared)) }
  return publishPagedRecovery(deps, { ...input, manifest })
}

/** Worker 私有计算只产生真实 unsigned commitment，设备私钥留在主进程签名边界。 */
export function preparePagedRecovery(deps: Pick<Dependencies, 'runtime' | 'store' | 'createWriter'>, input: Input): SyncPagedSnapshotManifest {
  requireSameScope(input)
  const identity = sha256Hex(canonicalJson(JSON.stringify({ localRootHash: input.local.rootHash,
    targetRootHash: input.target.rootHash, pipelineRevision: PIPELINE_VERSION, lanes: input.local.lanes.map(lane => lane.replicationLaneId).sort() })))
  const bundleId = MERGE_BUNDLE_PREFIX + identity
  deps.store.lifecycle.protectInputs(bundleId, new Set([input.local.snapshotBundleId, input.target.snapshotBundleId]))
  const existing = deps.store.find(bundleId)
  if (existing?.state === 'VERIFIED') {
    return JSON.parse(existing.manifestJson) as SyncPagedSnapshotManifest
  }
  {
    const index: RecoveryIndex = { database: deps.runtime.databaseHandle(), store: deps.store,
      localId: input.local.snapshotBundleId, targetId: input.target.snapshotBundleId, workId: bundleId + ':index',
      lanes: input.local.lanes.map(lane => lane.replicationLaneId) }
    if (!deps.store.find(index.workId)) deps.runtime.transaction(() =>
      deps.store.beginCapture({ snapshotBundleId: index.workId, syncSpaceId: input.local.syncSpaceId, now: input.now }))
    snapshotTracePhase('merge.entities', () => mergePagedEntities(index))
    snapshotTracePhase('merge.shared', () => copySharedRecords(index))
    // URL 候选不证明来源等价；已有签名 Alias 已由共享记录原样保留。
    snapshotTracePhase('merge.alias_deletes', () => reconcilePagedAliasDeletes(index))
    snapshotTracePhase('merge.graph', () => reconcilePagedRecoveryGraph(index))
    snapshotTracePhase('merge.blobs', () => mergePagedBlobs(index))
    // 恢复输出保留已提交记录与复制断点；完整页重写由既有摘要相等检查保证幂等。
    if (!existing) deps.store.beginCapture({ snapshotBundleId: bundleId, syncSpaceId: input.local.syncSpaceId, now: input.now })
    else if (existing.state !== 'CAPTURING') throw new Error('SNAPSHOT_CONFLICT: recovery output is not a private capture')
    deps.store.copyIndex({ source: index.workId, target: bundleId, lanes: index.lanes })
    const writer = deps.createWriter(bundleId)
    for (const lane of index.lanes) for (const fragments of deps.store.canonicalRecordFragments({ snapshotBundleId: bundleId, lane })) {
      snapshotCheckpoint()
      writer.appendIndexed({ lane, fragments })
    }
    return finishManifest({ ...input, now: deps.store.captureTime(index.workId), bundleId, writer })
  }
}

/** 签名页发布后在事务外重准备证明，最终事务只比较修订并更新 Reader 目录。 */
export function publishPagedRecovery(deps: Pick<Dependencies, 'runtime' | 'store' | 'validate' | 'requirePrepared'>,
  input: Input & { manifest: SyncPagedSnapshotManifest }): SyncPagedSnapshotManifest {
  const origin = deps.runtime.findSnapshotBundle(input.local.sourceSnapshotBundleId)
  if (!origin) throw new Error('REBASE_UNSAFE: local recovery source has no published bundle')
  deps.store.publish(input.manifest, input.now)
  for (let attempt = 0; attempt < SNAPSHOT_PUBLICATION_ATTEMPTS; attempt++) {
    snapshotCheckpoint()
    try {
      for (const manifest of [input.local, input.target, input.manifest]) deps.validate(manifest)
      snapshotTracePhase('merge.final-publish', () => deps.runtime.transaction(() => {
        for (const manifest of [input.local, input.target, input.manifest]) deps.requirePrepared?.(manifest)
        deps.runtime.upsertSnapshotBundle({ ...origin, snapshotBundleId: input.manifest.snapshotBundleId, rootHash: input.manifest.rootHash,
          snapshotClass: 'WORKING', authStabilityCheckpointId: null, policyHash: input.manifest.policyHash,
          capturedAt: input.manifest.capturedAt, createdAt: input.now })
      }))
      deps.store.discardCapture(input.manifest.snapshotBundleId + ':index')
      return input.manifest
    } catch (error) {
      // 仅修订竞争重做事务外证明；签名、历史或存储错误保留原异常。
      if (!snapshotRevisionConflict(error)) throw error
    }
  }
  return snapshotNeedsStableInput()
}

/** 输入必须是同一空间、同一策略范围的完整验证清单，不将缺失域误视为零前缀。 */
function requireSameScope(input: Input): void {
  const names = (manifest: SyncPagedSnapshotManifest) => manifest.lanes.map(lane => lane.replicationLaneId).sort()
  if (input.local.syncSpaceId !== input.target.syncSpaceId || JSON.stringify(names(input.local)) !== JSON.stringify(names(input.target))) {
    throw new Error('REBASE_UNSAFE: paged recovery merge requires both inputs for every selected lane')
  }
  if (input.local.snapshotClass !== 'WORKING') throw new Error('REBASE_UNSAFE: local recovery capture must be WORKING')
}

/** AUTH 与本机 CORE 来源只能来自本地已验证捕获；Genesis 观察和别名边从两侧取并集。 */
function copySharedRecords(input: RecoveryIndex): void {
  const buffered = new SyncBufferedSnapshotCapture(input.database, input.store)
  for (const lane of input.lanes) {
    // 共享本机权限/核心事实只来自 AUTH 与 CORE，其他域已由实体及候选合并负责。
    const shared = lane === 'AUTH' || lane === 'CORE_META' ? input.store.records({ snapshotBundleId: input.localId, lane }) : []
    for (const record of shared) {
      if (lane === 'AUTH' || !['ALIAS_EDGE','GENESIS','TOMBSTONE'].includes(record.kind)) {
        buffered.writeRecord({ snapshotBundleId: input.workId, lane, record })
      }
    }
    for (const id of [input.localId, input.targetId]) for (const kind of ['GENESIS','ALIAS_EDGE'] as const) {
      for (const record of input.store.records({ snapshotBundleId: id, lane, kind })) buffered.writeRecord({ snapshotBundleId: input.workId, lane, record })
    }
  }
  buffered.flushCapture()
}

/** 每个最大前缀都有某个完整输入支持，合并不会凭操作最大序号或页数填补历史洞。 */
function finishManifest(input: Input & { bundleId: string; writer: SyncSnapshotPageWriter }): SyncPagedSnapshotManifest {
  const coverage: SyncCoverage = Object.fromEntries(input.local.lanes.map(({ replicationLaneId: lane }) => [lane,
    Object.fromEntries([...new Set([...Object.keys(input.local.coverage[lane] ?? {}), ...Object.keys(input.target.coverage[lane] ?? {})])]
      .map(actor => [actor, Math.max(input.local.coverage[lane]?.[actor] ?? 0, input.target.coverage[lane]?.[actor] ?? 0)]))]))
  const lanes = input.writer.finish(Object.fromEntries(Object.entries(coverage).map(([lane, actors]) => [lane, encodeGenesisFrontiers({ [lane]: actors })])))
  // 裁决规则和选定 lane 沿用本地已验证捕获；内容变化由 bundle/root 签名绑定，不能改变策略身份。
  const unsigned = { ...input.local, snapshotBundleId: input.bundleId, lanes, coverage,
    capturedAt: input.now, authStabilityCheckpoint: null, coverageCommitment: null, rootHash: '', authorSignature: '' }
  const rooted = { ...unsigned, rootHash: pagedSnapshotRoot(unsigned) }
  return rooted
}
