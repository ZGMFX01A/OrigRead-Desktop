import { randomUUID } from 'node:crypto'
import { readSnapshotInstallReady, recordSnapshotInstallReady } from './sync-snapshot-install-journal'
import type { DatabaseSync } from 'node:sqlite'
import { LibraryRepository } from '../database/library-repository'
import type {
  SyncAuthProtocolObject,
  SyncBlobManifest,
  SyncCoverage,
  SyncSnapshotBundleWire,
  SyncSnapshotShardWire,
  SyncSnapshotStreamManifestWire
} from '../../shared/sync-protocol'
import type { SyncOperationRecord, SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncEntityType } from '../../shared/sync-identity'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import type { SyncFieldVersionRecord } from './sync-state-repository'
import { SyncVersionResolver } from './sync-version-token'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { ArticleFilterRule, ArticleFilterRuleType } from '../../shared/filter-rules'
import type { JsonRule } from '../../shared/json-source'
import type { RssHubSettings } from '../../shared/rsshub'
import type { WebsiteRule } from '../../shared/website'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type {
  WebsiteParsePreferenceRepository,
  WebsiteParsePreferenceUserSyncState
} from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import {
  assertSnapshotIntegrity,
  assertSnapshotStreamIntegrity,
  snapshotBundleFromStreamManifest,
  snapshotCoverageCommitment,
  verifySnapshotSignature,
  verifySnapshotStreamSignature
} from './sync-snapshot-wire'
import { canonicalJson } from './sync-operation-canonicalizer'
import { DesktopSyncAliasResolver, type SyncAliasEdgePayloadV1 } from './sync-alias-protocol'
import { DesktopSyncBlobStateService, type SyncBlobReferenceRecord } from './sync-blob-state'
import { DesktopAiHistoryApplier } from './desktop-ai-history-applier'
import { DesktopSyncBusinessApplier } from './desktop-sync-business-applier'
import { dependenciesSatisfied } from './sync-apply-dependencies'
import { SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND } from './sync-blob-payload'
import { articleCanonicalKey, configRuleSyncId, feedCanonicalKey } from './sync-canonical-identity'

export class SnapshotCorruptedError extends Error {
  readonly code = 'SNAPSHOT_CORRUPTED' as const
}

function resolveSnapshotFieldCandidates(rows: SyncFieldVersionRecord[], field: string): string {
  return SyncVersionResolver.resolve(rows.map((row) => {
    const context = JSON.parse(row.causalContextJson ?? '{}')
    return { versionToken: row.versionToken, valueJson: row.valueJson, logicalClock: row.logicalClock ?? 0,
      observedGenesisBaselinesByLane: context.observedGenesisBaselinesByLane,
      causalContext: Object.fromEntries((context.lanes ?? []).map((lane: { replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }) =>
        [lane.replicationLaneId, Object.fromEntries(lane.actors.map((actor) => [actor.actorIncarnationId, actor.prefix]))])) }
  }), field === 'isUnread' ? 'READ_WINS' : field === 'isStarred' ? 'STARRED_WINS' : 'DETERMINISTIC').versionToken
}

export class SnapshotDependencyMissingError extends Error {
  readonly code = 'SNAPSHOT_DEPENDENCY_MISSING' as const
}

export class SyncRebaseUnsafeError extends Error {
  readonly code = 'REBASE_UNSAFE' as const
}

export class SyncLocalRecoverySnapshotRequiredError extends Error {
  readonly code = 'LOCAL_RECOVERY_REQUIRED' as const
}

function snapshotCoverageDominates(left: SyncCoverage, right: SyncCoverage): boolean {
  return Object.entries(right).every(([lane, actors]) =>
    Object.entries(actors).every(([actor, prefix]) => (left[lane]?.[actor] ?? 0) >= prefix)
  )
}

export interface LocalKnowledgeCapsule {
  pendingOutboxCount: number
  capturedAt: number
}

export interface SnapshotInstallResult {
  snapshotBundleId: string
  syncSpaceId: string
  materializedEntities: number
  rebasedLanes: string[]
}

interface SnapshotShardSource {
  readonly lanes: readonly string[]
  load(lane: string): SyncSnapshotShardWire
}

class InMemorySnapshotShardSource implements SnapshotShardSource {
  readonly lanes: readonly string[]
  private readonly byLane: Map<string, SyncSnapshotShardWire>

  constructor(shards: readonly SyncSnapshotShardWire[]) {
    this.lanes = shards.map((shard) => shard.replicationLaneId)
    this.byLane = new Map(shards.map((shard) => [shard.replicationLaneId, shard]))
  }

  load(lane: string): SyncSnapshotShardWire {
    const shard = this.byLane.get(lane)
    if (!shard) throw new SnapshotCorruptedError('Snapshot shard is missing for lane ' + lane)
    return shard
  }
}

const LANE_ORDER: Record<string, number> = {
  CORE_META: 1,
  CONFIG: 2,
  AUTH: 3,
  LIBRARY: 4,
  ARTICLE_STATE: 5,
  AI_HISTORY: 6
}

const TOMBSTONE_LANE_ORDER: Record<string, number> = {
  ARTICLE_STATE: 1,
  LIBRARY: 2
}

const TOMBSTONE_ENTITY_ORDER: Record<string, number> = {
  article: 1,
  feed: 2,
  group: 3
}

const ENTITY_TYPE_ORDER: Record<string, number> = {
  binding: 1,
  device: 2,
  group: 3,
  feed: 4,
  article: 5,
  filter_rule: 6,
  website_rule: 7,
  json_rule: 8,
  rsshub_settings: 9,
  website_parse_preference: 10,
  conversation: 11,
  message: 12,
  tool_call: 13,
  context_ref: 14,
  evidence_block: 15,
  citation_ref: 16,
  citation_annotation: 17,
  conversation_article: 18,
  citation_annotation_ref: 19,
  rsshub_subscription_source: 20
}

/**
 * R10/R12 客户端快照安装与物化服务。
 * 负责将远端拉取或备份恢复的 SnapshotBundle 进行完整性校验、隔离 Local ID、恢复字段版本与 Tombstone，
 * 并在原子事务中安装至本地元数据并实例化至业务表。
 */
export class DesktopSnapshotInstallService {
  private readonly identities: SyncIdentityRepository
  private readonly aliases: DesktopSyncAliasResolver
  private readonly blobs: DesktopSyncBlobStateService

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly articleFilters?: ArticleFilterRepository,
    private readonly aiHistory?: DesktopAiHistoryApplier,
    private readonly businessApplier?: DesktopSyncBusinessApplier,
    private readonly websiteRules?: WebsiteRuleRepository,
    private readonly jsonRules?: JsonRuleRepository,
    private readonly rssHubSettings?: RssHubSettingsRepository,
    private readonly websiteParsePreferences?: WebsiteParsePreferenceRepository
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.aliases = new DesktopSyncAliasResolver(
      database,
      state,
      (localFeedId) => {
        this.articleFilters?.deleteByFeed(localFeedId)
        this.websiteParsePreferences?.delete(localFeedId)
      }
    )
    this.blobs = new DesktopSyncBlobStateService(database)
  }

  install(
    localAccountId: number,
    bundle: SyncSnapshotBundleWire,
    now = Date.now(),
    selectedLanes?: ReadonlySet<string>
  ): SnapshotInstallResult {
    if (!bundle.snapshotBundleId || !bundle.syncSpaceId) {
      throw new SnapshotCorruptedError('Invalid snapshot bundle: missing bundleId or syncSpaceId')
    }
    const binding = this.runtime.findBinding(localAccountId)
    if (!binding) {
      throw new Error(`Local account ${localAccountId} has no sync space binding`)
    }
    if (binding.syncSpaceId !== bundle.syncSpaceId) {
      throw new Error(`Snapshot bundle syncSpaceId ${bundle.syncSpaceId} does not match binding ${binding.syncSpaceId}`)
    }

    if (!bundle.rootHash || !bundle.policyHash) {
      throw new SyncRebaseUnsafeError('Cannot rebase onto snapshot with empty rootHash or policyHash')
    }
    if (!bundle.authorDeviceId || !bundle.authorSignature) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: snapshot author signature is missing')
    }
    const author = this.state.findPeer(bundle.syncSpaceId, bundle.authorDeviceId)
    if (!author || author.status !== 'ACTIVE') {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: snapshot author is not active in the AUTH ledger')
    }
    if (!verifySnapshotSignature(bundle, author.publicKeySpkiBase64)) {
      throw new SnapshotCorruptedError('Snapshot author signature verification failed')
    }
    if (bundle.snapshotClass === 'GC_BASELINE' && !bundle.authStabilityCheckpoint) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: GC baseline has no AuthStabilityCheckpoint')
    }
    if (bundle.snapshotClass === 'BOOTSTRAP_RECOVERY' &&
      (!bundle.coverageCommitment || !bundle.authStabilityCheckpoint)) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: recovery snapshot proof is incomplete')
    }
    this.validateStabilityProof(bundle)

    // 1. 严格完整性校验（R10-04）
    const requiredLanes = ['CORE_META', 'AUTH']
    const supportedLanes = ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH']
    const manifestLanes = new Set(bundle.shards.map((s) => s.replicationLaneId))
    if (manifestLanes.size !== bundle.shards.length || bundle.shards.some((s) => !supportedLanes.includes(s.replicationLaneId))) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: duplicate or unsupported snapshot lane')
    }
    for (const req of requiredLanes) {
      if (!manifestLanes.has(req)) {
        throw new SnapshotCorruptedError(`Missing required core shard: ${req}`)
      }
    }

    try {
      assertSnapshotIntegrity(bundle)
    } catch (error) {
      if (error instanceof Error && error.message.includes('CORRUPTED')) {
        throw new SnapshotCorruptedError(error.message)
      }
      throw new SyncRebaseUnsafeError(error instanceof Error ? error.message : String(error))
    }

    return this.installVerifiedFromSource(
      localAccountId,
      bundle,
      new InMemorySnapshotShardSource(bundle.shards),
      manifestLanes,
      now,
      selectedLanes
    )
  }

  installStream(
    localAccountId: number,
    manifest: SyncSnapshotStreamManifestWire,
    shardLoader: (lane: string) => SyncSnapshotShardWire,
    now = Date.now(),
    selectedLanes?: ReadonlySet<string>
  ): SnapshotInstallResult {
    if (!manifest.snapshotBundleId || !manifest.syncSpaceId) {
      throw new SnapshotCorruptedError('Invalid snapshot stream manifest: missing bundleId or syncSpaceId')
    }
    if (!manifest.rootHash || !manifest.policyHash) {
      throw new SyncRebaseUnsafeError('Cannot rebase onto snapshot with empty rootHash or policyHash')
    }
    if (!manifest.authorDeviceId || !manifest.authorSignature) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: snapshot author signature is missing')
    }
    const author = this.state.findPeer(manifest.syncSpaceId, manifest.authorDeviceId)
    if (!author || author.status !== 'ACTIVE') {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: snapshot author is not active in the AUTH ledger')
    }
    if (manifest.snapshotClass === 'GC_BASELINE' && !manifest.authStabilityCheckpoint) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: GC baseline has no AuthStabilityCheckpoint')
    }
    if (manifest.snapshotClass === 'BOOTSTRAP_RECOVERY' &&
      (!manifest.coverageCommitment || !manifest.authStabilityCheckpoint)) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: recovery snapshot proof is incomplete')
    }

    const lanes = manifest.shardDescriptors.map((descriptor) => descriptor.replicationLaneId)
    const manifestLanes = new Set(lanes)
    const supportedLanes = new Set(['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH'])
    if (manifestLanes.size !== lanes.length || lanes.some((lane) => !supportedLanes.has(lane))) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: duplicate or unsupported snapshot lane')
    }
    for (const required of ['CORE_META', 'AUTH']) {
      if (!manifestLanes.has(required)) {
        throw new SnapshotCorruptedError('Missing required core shard: ' + required)
      }
    }

    const metadataBundle = snapshotBundleFromStreamManifest(manifest, [])
    this.validateStabilityProof(metadataBundle)
    try {
      assertSnapshotStreamIntegrity(manifest, shardLoader)
    } catch (error) {
      if (error instanceof Error && error.message.includes('CORRUPTED')) {
        throw new SnapshotCorruptedError(error.message)
      }
      throw new SyncRebaseUnsafeError(error instanceof Error ? error.message : String(error))
    }
    if (!verifySnapshotStreamSignature(manifest, author.publicKeySpkiBase64, shardLoader)) {
      throw new SnapshotCorruptedError('Snapshot author signature verification failed')
    }

    const source: SnapshotShardSource = {
      lanes,
      load: shardLoader
    }
    return this.installVerifiedFromSource(
      localAccountId,
      metadataBundle,
      source,
      manifestLanes,
      now,
      selectedLanes
    )
  }

  private installVerifiedFromSource(
    localAccountId: number,
    bundle: SyncSnapshotBundleWire,
    source: SnapshotShardSource,
    manifestLanes: ReadonlySet<string>,
    now: number,
    selectedLanes?: ReadonlySet<string>
  ): SnapshotInstallResult {
    const binding = this.runtime.findBinding(localAccountId)
    if (!binding) {
      throw new Error(`Local account ${localAccountId} has no sync space binding`)
    }
    if (binding.syncSpaceId !== bundle.syncSpaceId) {
      throw new Error(`Snapshot bundle syncSpaceId ${bundle.syncSpaceId} does not match binding ${binding.syncSpaceId}`)
    }
    const requiredLanes = ['CORE_META', 'AUTH']
    const presentLanes = selectedLanes ? new Set(selectedLanes) : manifestLanes
    for (const lane of presentLanes) {
      if (!manifestLanes.has(lane)) {
        throw new SyncRebaseUnsafeError('REBASE_UNSAFE: selected Snapshot lane is absent from the signed manifest: ' + lane)
      }
    }
    for (const req of requiredLanes) {
      if (!presentLanes.has(req)) {
        throw new SyncRebaseUnsafeError('REBASE_UNSAFE: required core Snapshot lane is paused or unsupported: ' + req)
      }
    }
    if (presentLanes.has('ARTICLE_STATE') && !presentLanes.has('LIBRARY')) {
      throw new SnapshotDependencyMissingError(
        'ARTICLE_STATE Snapshot requires LIBRARY in the same selected Snapshot scope'
      )
    }
    const sortedManifestLanes = [...source.lanes].sort(
      (a, b) => (LANE_ORDER[a] ?? 99) - (LANE_ORDER[b] ?? 99)
    )
    const sortedLanes = sortedManifestLanes.filter((lane) => presentLanes.has(lane))
    const selectedCoverage = Object.fromEntries(
      Object.entries(bundle.coverage).filter(([lane]) => presentLanes.has(lane))
    )
    const selectedBundle: SyncSnapshotBundleWire = {
      ...bundle,
      shards: [],
      coverage: selectedCoverage
    }

    const existingStagedBundle = this.runtime.findSnapshotBundle(bundle.snapshotBundleId)
    const ready = readSnapshotInstallReady(this.database, bundle.syncSpaceId)
    if (binding.lifecycleState === 'STAGING' && ready?.snapshotBundleId === bundle.snapshotBundleId &&
      ready.rootHash === bundle.rootHash && existingStagedBundle?.rootHash === bundle.rootHash &&
      [...presentLanes].every(lane => ready.installedLanes.includes(lane))) {
      return { snapshotBundleId: bundle.snapshotBundleId, syncSpaceId: bundle.syncSpaceId,
        materializedEntities: 0, rebasedLanes: [...presentLanes] }
    }
    if (binding.lifecycleState === 'REBASE_PREPARE' &&
      existingStagedBundle?.rootHash === bundle.rootHash) {
      const capsule = this.database.prepare(`SELECT coverage_json,operation_ids_json
        FROM sync_recovery_capsule WHERE sync_space_id=? AND target_snapshot_bundle_id=?
          AND reason='REBASE_PREPARE_RETAINED_TAIL' ORDER BY created_at DESC LIMIT 1`)
        .get(bundle.syncSpaceId, bundle.snapshotBundleId) as { coverage_json: string; operation_ids_json: string } | undefined
      if (capsule) {
        const previous = JSON.parse(capsule.coverage_json) as ReturnType<SyncStateRepository['getCoverage']>
        const tail = (JSON.parse(capsule.operation_ids_json) as string[]).map((id) => {
          const operation = this.runtime.findOperation(id)
          if (!operation) throw new SyncRebaseUnsafeError('REBASE_UNSAFE: recovery tail operation is missing')
          return operation
        }).filter((operation) => presentLanes.has(operation.replicationLaneId) &&
          [undefined, 'APPLIED'].includes(this.state.findInbox(operation.operationId)?.state))
        this.runtime.transaction(() => {
          const configShard = presentLanes.has('CONFIG') ? source.load('CONFIG') : null
          if (configShard) this.applyExternalConfigState(bundle.syncSpaceId, configShard.entityStateJson, now)
          this.replayRetainedTail(selectedBundle, tail, previous.applied, presentLanes, now)
          this.restoreRecoverableCoverage(bundle.syncSpaceId, previous, presentLanes, now)
        })
      } else {
        const configShard = presentLanes.has('CONFIG') ? source.load('CONFIG') : null
        if (configShard) {
          this.runtime.transaction(() =>
            this.applyExternalConfigState(bundle.syncSpaceId, configShard.entityStateJson, now))
        }
      }
      this.runtime.transaction(() => {
        recordSnapshotInstallReady(this.database, bundle.syncSpaceId, {
          snapshotBundleId: bundle.snapshotBundleId, rootHash: bundle.rootHash, installedLanes: [...presentLanes]
        }, now)
        this.runtime.upsertBinding({ ...binding, lifecycleState: 'STAGING', updatedAt: now })
      })
      return { snapshotBundleId: bundle.snapshotBundleId, syncSpaceId: bundle.syncSpaceId,
        materializedEntities: 0, rebasedLanes: [...presentLanes] }
    }

    // 捕获 LocalKnowledgeCapsule，并只保留 target Snapshot 未支配的有效 Operation。
    // 业务表“非空”本身不是不安全条件；真正的安全边界是这些本地已知变化能否由
    // retained Operation / Outbox 精确重放，而不是靠当前 materialized row 猜历史。
    const pendingOutbox = this.runtime.listPendingOutbox(bundle.syncSpaceId, 10_000)
    if (pendingOutbox.length > 0) {
      this.persistRecoveryCapsule(selectedBundle, presentLanes, pendingOutbox.map((row) => row.outboxId), 'PENDING_OUTBOX_REQUIRES_PREPARATION', now)
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: local Outbox must be built and signed before Snapshot rebase'
      )
    }
    const coverageBeforeRebase = this.state.getCoverage(bundle.syncSpaceId)
    if (this.snapshotIsBehindStableGc(selectedBundle, coverageBeforeRebase.stableGc, presentLanes)) {
      this.persistRecoveryCapsule(selectedBundle, presentLanes, [], 'LOCAL_RECOVERY_SNAPSHOT_REQUIRED', now)
      throw new SyncLocalRecoverySnapshotRequiredError(
        'LOCAL_RECOVERY_REQUIRED: target Snapshot is behind locally compacted stable history'
      )
    }
    const retainedTail = this.runtime.listPushableOperations(
      bundle.syncSpaceId,
      selectedCoverage,
      Number.MAX_SAFE_INTEGER,
      (operation) => presentLanes.has(operation.replicationLaneId)
    )
    this.assertRetainedTailIsComplete(selectedBundle, coverageBeforeRebase.retained, retainedTail, presentLanes)
    const replayTail = retainedTail.filter((operation) => {
      const inbox = this.state.findInbox(operation.operationId)
      return inbox == null || inbox.state === 'APPLIED'
    })
    if (retainedTail.length > 0) {
      this.persistRecoveryCapsule(selectedBundle, presentLanes, [], 'REBASE_PREPARE_RETAINED_TAIL', now)
    }
    // REBASE_PREPARE remains writable through Transactional Outbox. Any user mutation
    // racing the baseline install is replayed after the target Snapshot instead of disappearing.
    this.runtime.upsertBinding({
      ...binding,
      lifecycleState: 'REBASE_PREPARE',
      updatedAt: now
    })

    let materializedEntities = 0
    const rebasedLanes: string[] = []

    try {
      this.runtime.transaction(() => {
        // 2. 存储快照元数据
        this.runtime.upsertSnapshotBundle({
          snapshotBundleId: bundle.snapshotBundleId,
          syncSpaceId: bundle.syncSpaceId,
          genesisSessionId: bundle.snapshotBundleId,
          genesisBaselineId: bundle.genesisBaselineId ?? bundle.snapshotBundleId,
          snapshotClass: bundle.snapshotClass,
          authStabilityCheckpointId: bundle.authStabilityCheckpoint ?? null,
          rootHash: bundle.rootHash,
          policyHash: bundle.policyHash,
          capturedAt: bundle.capturedAt,
          createdAt: now
        })

        // Persist the complete signed manifest. Projection and coverage changes below
        // are restricted to the currently selected replication lanes.
        for (const lane of sortedManifestLanes) {
          const shard = source.load(lane)
          this.runtime.upsertSnapshotShard({
            snapshotBundleId: bundle.snapshotBundleId,
            syncSpaceId: bundle.syncSpaceId,
            replicationLaneId: shard.replicationLaneId as SyncReplicationLane,
            frontierJson: shard.frontierJson,
            entityStateJson: shard.entityStateJson,
            fieldVersionStateJson: shard.fieldVersionStateJson,
            causalMetadataJson: shard.causalMetadataJson,
            genesisCoverageJson: shard.genesisCoverageJson,
            deletionGenerationSummaryJson: shard.deletionGenerationSummaryJson,
            blobManifestIndexJson: shard.blobManifestIndexJson ?? '[]',
            blobReferenceIndexJson: shard.blobReferenceIndexJson ?? '[]',
            contentHash: shard.contentHash,
            createdAt: now
          })
        }

        // 3. 按因果依赖顺序安装各 Shard 并恢复元数据与实例化业务实体
        for (const lane of sortedLanes) {
          const shard = source.load(lane)
          rebasedLanes.push(shard.replicationLaneId)

          // Snapshot only restores Blob metadata/reference state. Missing bytes remain BLOB_MISSING.
          this.restoreBlobIndexes(
            bundle.syncSpaceId,
            shard.replicationLaneId,
            shard.blobManifestIndexJson ?? '[]',
            shard.blobReferenceIndexJson ?? '[]',
            now
          )

          // 3.1 先解析业务实体（R10-02, R10-03, R10-05）
          const entities = this.parseEntities(shard.entityStateJson, shard.replicationLaneId).sort(
            (a, b) => (ENTITY_TYPE_ORDER[a.entityType] ?? 99) - (ENTITY_TYPE_ORDER[b.entityType] ?? 99)
          )
          if (shard.replicationLaneId === 'AUTH') {
            this.validateAuthEntities(bundle.syncSpaceId, entities)
          }
          for (const entity of entities) {
            if (!['filter_rule', 'website_rule', 'json_rule', 'rsshub_settings', 'website_parse_preference', 'rsshub_subscription_source', 'auth_ledger'].includes(entity.entityType)) {
              this.materializeEntity(localAccountId, bundle.syncSpaceId, entity, now)
              materializedEntities++
            }
          }

          // 3.2 恢复 Field Versions（R10-06），结合实体真实字段值恢复 winner valueJson
          this.restoreFieldVersions(bundle.syncSpaceId, shard.fieldVersionStateJson, entities, now)

          // 3.3 恢复 generation-scoped Alias Edge 真源。
          this.restoreAliasEdges(bundle.syncSpaceId, shard.causalMetadataJson, now)

        }

        // 3.4 删除投影必须与创建方向相反：先 Article，再 Feed，最后 Group。
        // 否则 Android CASCADE 会吞掉尚未 Tombstone 的子实体，而 Desktop RESTRICT 会直接失败。
        const tombstoneLanes = [...sortedLanes].sort(
          (a, b) =>
            (TOMBSTONE_LANE_ORDER[a] ?? 99) -
            (TOMBSTONE_LANE_ORDER[b] ?? 99)
        )
        for (const lane of tombstoneLanes) {
          const shard = source.load(lane)
          this.restoreTombstones(
            localAccountId,
            bundle.syncSpaceId,
            bundle.snapshotBundleId,
            shard.deletionGenerationSummaryJson,
            now
          )
        }

        // 4. 覆盖度重基线（Rebase Coverage）（R10-09, R10-10）
        this.state.rebaseSnapshotCoverage(bundle.syncSpaceId, selectedCoverage, now)

        const configShard = presentLanes.has('CONFIG') ? source.load('CONFIG') : null
        if (configShard) this.applyExternalConfigState(bundle.syncSpaceId, configShard.entityStateJson, now)
        this.replayRetainedTail(selectedBundle, replayTail, coverageBeforeRebase.applied, presentLanes, now)
        this.restoreRecoverableCoverage(bundle.syncSpaceId, coverageBeforeRebase, presentLanes, now)

        // Snapshot is only the baseline. Keep STAGING until the coordinator
        // has replayed and applied the retained Tail after this frontier.
        recordSnapshotInstallReady(this.database, bundle.syncSpaceId, {
          snapshotBundleId: bundle.snapshotBundleId, rootHash: bundle.rootHash, installedLanes: [...presentLanes]
        }, now)
        this.runtime.upsertBinding({ ...binding, lifecycleState: 'STAGING', updatedAt: now })
      })
    } catch (err) {
      // External CONFIG repositories are not part of the SQLite transaction. If materialization
      // fails after one of them was written, restoring ACTIVE would expose a torn Snapshot.
      // Fail closed and require the same idempotent install path to repair the projection.
      this.runtime.upsertBinding({
        ...binding,
        lifecycleState: 'PAUSED',
        updatedAt: now
      })
      throw err
    }

    return {
      snapshotBundleId: bundle.snapshotBundleId,
      syncSpaceId: bundle.syncSpaceId,
      materializedEntities,
      rebasedLanes
    }
  }

  private validateStabilityProof(bundle: SyncSnapshotBundleWire): void {
    if (bundle.snapshotClass !== 'GC_BASELINE' && bundle.snapshotClass !== 'BOOTSTRAP_RECOVERY') return
    const history = this.runtime.listAuthObjects(bundle.syncSpaceId)
    const checkpoint = history.find((object) => object.objectType === 'AUTH_STABILITY_CHECKPOINT' &&
      object.authObjectId === bundle.authStabilityCheckpoint && object.syncSpaceId === bundle.syncSpaceId)
    if (!checkpoint) {
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: stable Snapshot has no verified local AuthStabilityCheckpoint'
      )
    }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(checkpoint.payloadJson) as Record<string, unknown>
    } catch {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: AuthStabilityCheckpoint payload is invalid')
    }
    const accepted = payload.acceptedPrefixByActorLane
    if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: AuthStabilityCheckpoint accepted coverage is missing'
      )
    }
    if (!snapshotCoverageDominates(accepted as SyncCoverage, bundle.coverage)) {
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: Snapshot coverage exceeds the current stable authorization proof'
      )
    }
    if (bundle.snapshotClass === 'BOOTSTRAP_RECOVERY') {
      if (payload.acceptedSnapshotBundleId !== bundle.snapshotBundleId) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: OWNER recovery acceptance does not name this Snapshot'
        )
      }
      if (bundle.coverageCommitment !== snapshotCoverageCommitment(bundle.coverage)) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: recovery Snapshot coverage commitment is invalid'
        )
      }
    }
  }

  private assertRetainedTailIsComplete(
    bundle: SyncSnapshotBundleWire,
    retainedCoverage: SyncCoverage,
    operations: SyncOperationRecord[],
    presentLanes: ReadonlySet<string>
  ): void {
    const byStream = new Map<string, number[]>()
    for (const operation of operations) {
      const key = operation.replicationLaneId + '\n' + operation.actorIncarnationId
      const values = byStream.get(key) ?? []
      values.push(operation.sequence)
      byStream.set(key, values)
    }
    for (const [key, sequences] of byStream) {
      const [lane, actor] = key.split('\n')
      const target = bundle.coverage[lane!]?.[actor!] ?? 0
      const sorted = [...new Set(sequences)].sort((a, b) => a - b)
      let expected = target + 1
      for (const sequence of sorted) {
        if (sequence !== expected) {
          throw new SyncRebaseUnsafeError(
            `REBASE_UNSAFE: retained Operation gap for ${lane}/${actor}; expected ${expected}, got ${sequence}`
          )
        }
        expected++
      }
    }
    for (const [lane, actors] of Object.entries(retainedCoverage)) {
      if (!presentLanes.has(lane)) continue
      for (const [actor, prefix] of Object.entries(actors)) {
        const target = bundle.coverage[lane]?.[actor] ?? 0
        if (prefix <= target) continue
        const sequences = byStream.get(lane + '\n' + actor) ?? []
        const max = sequences.length ? Math.max(...sequences) : target
        if (max < prefix) {
          throw new SyncRebaseUnsafeError(
            `REBASE_UNSAFE: local retained coverage ${lane}/${actor}=${prefix} is not reconstructable from retained Operations`
          )
        }
      }
    }
  }

  private snapshotIsBehindStableGc(
    bundle: SyncSnapshotBundleWire,
    stableGc: SyncCoverage,
    presentLanes: ReadonlySet<string>
  ): boolean {
    for (const [lane, actors] of Object.entries(stableGc)) {
      if (!presentLanes.has(lane)) continue
      for (const [actor, prefix] of Object.entries(actors)) {
        const target = bundle.coverage[lane]?.[actor] ?? 0
        if (prefix > target) return true
      }
    }
    return false
  }

  private replayRetainedTail(
    bundle: SyncSnapshotBundleWire,
    operations: SyncOperationRecord[],
    preservedAppliedCoverage: SyncCoverage,
    selectedLanes: ReadonlySet<string>,
    now: number
  ): void {
    if (operations.length === 0) return
    if (!this.businessApplier) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: business projection is unavailable for retained-tail replay')
    }
    const progress: SyncCoverage = {}
    for (const [lane, actors] of Object.entries(preservedAppliedCoverage)) {
      if (selectedLanes.has(lane)) continue
      progress[lane] = { ...actors }
    }
    for (const [lane, actors] of Object.entries(bundle.coverage)) {
      progress[lane] = { ...(progress[lane] ?? {}), ...actors }
    }
    const localDeviceId = this.runtime.findDeviceIdentity()?.deviceId ?? null

    const remaining = [...operations]
    while (remaining.length > 0) {
      let madeProgress = false
      for (let index = 0; index < remaining.length;) {
        const operation = remaining[index]!
        const prefix = progress[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0
        if (operation.sequence !== prefix + 1 ||
          !dependenciesSatisfied(operation.dependencyDotsJson, progress)) {
          index++
          continue
        }
        let legacyEmptyLocalUpsert = false
        if (
          localDeviceId &&
          operation.authorDeviceId === localDeviceId &&
          operation.operationType === 'UPSERT'
        ) {
          try {
            const payload = JSON.parse(operation.payloadJson) as { fields?: unknown }
            legacyEmptyLocalUpsert =
              payload.fields != null &&
              typeof payload.fields === 'object' &&
              !Array.isArray(payload.fields) &&
              Object.keys(payload.fields as Record<string, unknown>).length === 0
          } catch {
            legacyEmptyLocalUpsert = false
          }
        }
        if (!legacyEmptyLocalUpsert) this.businessApplier.apply(operation)
        progress[operation.replicationLaneId] ??= {}
        progress[operation.replicationLaneId]![operation.actorIncarnationId] = operation.sequence
        remaining.splice(index, 1)
        madeProgress = true
      }
      if (!madeProgress) {
        const blocked = remaining[0]!
        throw new SyncRebaseUnsafeError(
          `REBASE_UNSAFE: retained tail cannot be causally replayed at ${blocked.replicationLaneId}/${blocked.actorIncarnationId}/${blocked.sequence}`
        )
      }
    }
    void now
  }

  private restoreRecoverableCoverage(
    syncSpaceId: string,
    previous: ReturnType<SyncStateRepository['getCoverage']>,
    presentLanes: ReadonlySet<string>,
    now: number
  ): void {
    for (const lane of presentLanes) {
      const actors = new Set([
        ...Object.keys(previous.received[lane] ?? {}),
        ...Object.keys(previous.applied[lane] ?? {}),
        ...Object.keys(previous.retained[lane] ?? {}),
        ...Object.keys(previous.stableGc[lane] ?? {})
      ])
      for (const actor of actors) {
        this.state.upsertCoverage(syncSpaceId, lane, actor, {
          receivedPrefix: previous.received[lane]?.[actor] ?? 0,
          appliedPrefix: previous.applied[lane]?.[actor] ?? 0,
          retainedPrefix: previous.retained[lane]?.[actor] ?? 0,
          stableGcPrefix: previous.stableGc[lane]?.[actor] ?? 0
        }, now)
      }
    }
  }

  activateAfterTail(localAccountId: number, snapshotBundleId: string, now = Date.now(), pausedLanes: string[] = []): void {
    const binding = this.runtime.findBinding(localAccountId)
    if (!binding) throw new Error(`Local account ${localAccountId} has no sync space binding`)
    if (!['STAGING', 'REBASE_PREPARE'].includes(binding.lifecycleState)) {
      throw new Error('Snapshot baseline is not in REBASE_PREPARE')
    }
    const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
    if (!bundle || bundle.syncSpaceId !== binding.syncSpaceId) throw new Error('Staged Snapshot was not found')
    if (this.state.listPendingInbox(binding.syncSpaceId, 1, pausedLanes).length > 0) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: Snapshot Tail still has unapplied operations')
    }
    this.runtime.upsertBinding({
      ...binding,
      lifecycleState: 'ACTIVE',
      genesisSessionId: null,
      updatedAt: now
    })
  }

  private persistRecoveryCapsule(
    bundle: SyncSnapshotBundleWire,
    selectedLanes: ReadonlySet<string>,
    pendingOutboxIds: string[],
    reason: string,
    now: number
  ): void {
    const operationIds = this.runtime.listAllOperationsForRecovery(bundle.syncSpaceId)
      .filter((operation) =>
        selectedLanes.has(operation.replicationLaneId) &&
        operation.sequence > (bundle.coverage[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0)
      )
      .map((operation) => operation.operationId)
      .sort()
    const recoveryStateJson = this.captureLocalRecoveryState(bundle.syncSpaceId)
    this.database.prepare(`
      INSERT INTO sync_recovery_capsule(
        capsule_id,sync_space_id,target_snapshot_bundle_id,coverage_json,
        operation_ids_json,pending_outbox_ids_json,recovery_state_json,reason,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      `recovery:${randomUUID()}`,
      bundle.syncSpaceId,
      bundle.snapshotBundleId,
      canonicalJson(JSON.stringify(this.state.getCoverage(bundle.syncSpaceId))),
      canonicalJson(JSON.stringify(operationIds)),
      canonicalJson(JSON.stringify([...pendingOutboxIds].sort())),
      recoveryStateJson,
      reason,
      now
    )
  }

  private captureLocalRecoveryState(syncSpaceId: string): string {
    const binding = this.runtime.findBindingBySpace(syncSpaceId)
    if (!binding) throw new SyncRebaseUnsafeError('REBASE_UNSAFE: cannot capture recovery state without a Space binding')
    const accountId = binding.localAccountId
    const mappings = this.database.prepare(
      'SELECT entity_type,sync_id,canonical_key,generation FROM sync_identity_mapping WHERE sync_space_id=? ORDER BY entity_type,sync_id'
    ).all(syncSpaceId) as unknown as Array<{
      entity_type: string
      sync_id: string
      canonical_key: string | null
      generation: number
    }>
    const groupMappings = new Map(
      (this.database.prepare("SELECT local_id,sync_id FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type='group'")
        .all(syncSpaceId) as unknown as Array<{ local_id: string; sync_id: string }>)
        .map((row) => [row.local_id, row.sync_id])
    )
    const groupGenerations = new Map(
      (this.database.prepare("SELECT local_id,generation FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type='group'")
        .all(syncSpaceId) as unknown as Array<{ local_id: string; generation: number }>)
        .map((row) => [row.local_id, Number(row.generation)])
    )
    const feedMappings = new Map(
      (this.database.prepare("SELECT local_id,sync_id FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type='feed'")
        .all(syncSpaceId) as unknown as Array<{ local_id: string; sync_id: string }>)
        .map((row) => [row.local_id, row.sync_id])
    )
    const feedGenerations = new Map(
      (this.database.prepare("SELECT local_id,generation FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type='feed'")
        .all(syncSpaceId) as unknown as Array<{ local_id: string; generation: number }>)
        .map((row) => [row.local_id, Number(row.generation)])
    )
    const articleMappings = new Map(
      (this.database.prepare("SELECT local_id,sync_id FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type='article'")
        .all(syncSpaceId) as unknown as Array<{ local_id: string; sync_id: string }>)
        .map((row) => [row.local_id, row.sync_id])
    )
    const groups = (this.database.prepare('SELECT id,name,sort_order,is_default FROM groups WHERE account_id=? ORDER BY id')
      .all(accountId) as unknown as Array<Record<string, unknown>>)
      .map((row) => ({
        localId: String(row.id),
        syncId: groupMappings.get(String(row.id)) ?? null,
        name: String(row.name),
        sortOrder: Number(row.sort_order),
        isDefault: Number(row.is_default) === 1
      }))
    const feeds = (this.database.prepare(
      'SELECT id,group_id,name,url,source_page_url,source_type,icon,is_notification,is_full_content,is_browser,dynamic_rendering,created_at,updated_at FROM feeds WHERE account_id=? ORDER BY id'
    ).all(accountId) as unknown as Array<Record<string, unknown>>)
      .map((row) => ({
        localId: String(row.id),
        syncId: feedMappings.get(String(row.id)) ?? null,
        groupSyncId: groupMappings.get(String(row.group_id)) ?? null,
        groupGeneration: groupGenerations.get(String(row.group_id)) ?? null,
        groupLocalId: String(row.group_id),
        name: String(row.name),
        url: String(row.url),
        sourcePageUrl: row.source_page_url == null ? null : String(row.source_page_url),
        sourceType: String(row.source_type),
        icon: row.icon == null ? null : String(row.icon),
        isNotification: Number(row.is_notification) === 1,
        isFullContent: Number(row.is_full_content) === 1,
        isBrowser: Number(row.is_browser) === 1,
        dynamicRendering: Number(row.dynamic_rendering) === 1,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at)
      }))
    const articles = (this.database.prepare(
      'SELECT id,feed_id,title,url,author,published_at,description,content_html,image_url,is_unread,is_starred,is_read_later,created_at,updated_at FROM articles WHERE account_id=? ORDER BY id'
    ).all(accountId) as unknown as Array<Record<string, unknown>>)
      .map((row) => {
        const localId = String(row.id)
        const syncId = articleMappings.get(localId) ?? null
        const fullContentHash = syncId == null ? null : (
          this.database.prepare(`
            SELECT hash FROM sync_blob_reference
            WHERE sync_space_id=? AND replication_lane_id='ARTICLE_STATE'
              AND owner_entity_type='article' AND owner_entity_sync_id=? AND reference_kind=?
            ORDER BY owner_entity_generation DESC,created_at DESC LIMIT 1
          `).get(syncSpaceId, syncId, SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND) as { hash: string } | undefined
        )?.hash ?? null
        return {
          localId,
          syncId,
          feedSyncId: feedMappings.get(String(row.feed_id)) ?? null,
          feedGeneration: feedGenerations.get(String(row.feed_id)) ?? null,
          feedLocalId: String(row.feed_id),
          title: String(row.title),
          url: row.url == null ? null : String(row.url),
          author: row.author == null ? null : String(row.author),
          publishedAt: row.published_at == null ? null : Number(row.published_at),
          description: String(row.description),
          contentHtml: row.content_html == null ? null : String(row.content_html),
          fullContentHash,
          imageUrl: row.image_url == null ? null : String(row.image_url),
          isUnread: Number(row.is_unread) === 1,
          isStarred: Number(row.is_starred) === 1,
          isReadLater: Number(row.is_read_later) === 1,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at)
        }
      })
    const fieldVersions = this.database.prepare(
      'SELECT entity_type,entity_sync_id,field_id,entity_generation,version_token,source_operation_id,value_json FROM sync_field_version WHERE sync_space_id=? ORDER BY entity_type,entity_sync_id,field_id'
    ).all(syncSpaceId)
    const rollbackBaselines = this.database.prepare(
      'SELECT entity_type,entity_sync_id,entity_generation,field_id,value_json FROM sync_field_rollback_baseline WHERE sync_space_id=? ORDER BY entity_type,entity_sync_id,entity_generation,field_id'
    ).all(syncSpaceId)
    const tombstones = this.database.prepare(
      'SELECT entity_type,entity_sync_id,generation,version_token,deleted_at,source_operation_id FROM sync_entity_tombstone WHERE sync_space_id=? ORDER BY entity_type,entity_sync_id'
    ).all(syncSpaceId)
    const aliasEdges = this.database.prepare(
      'SELECT entity_type,left_sync_id,left_generation,right_sync_id,right_generation,source_operation_id FROM sync_alias_edge WHERE sync_space_id=? ORDER BY entity_type,left_generation,left_sync_id,right_sync_id'
    ).all(syncSpaceId)
    const configEntities: Array<{
      entityType: string
      entitySyncId: string
      generation: number
      fields: Record<string, unknown>
    }> = []
    for (const rule of this.articleFilters?.getAll() ?? []) {
      const mapping = this.identities.findByLocalId(syncSpaceId, 'filter_rule', rule.id)
      if (!mapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: filter rule ' + rule.id + ' has no Sync identity'
        )
      }
      const feedMapping = rule.feedId == null
        ? null
        : this.identities.findByLocalId(syncSpaceId, 'feed', rule.feedId)
      const feedSyncId = feedMapping?.syncId ?? null
      if (rule.feedId != null && !feedMapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: filter rule ' + rule.id +
            ' references unmapped feed ' + rule.feedId
        )
      }
      configEntities.push({
        entityType: 'filter_rule',
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields: {
          keyword: rule.keyword,
          feedSyncId,
          feedGeneration: feedMapping?.generation ?? null,
          feedName: rule.feedName,
          type: rule.type,
          enabled: rule.enabled
        }
      })
    }
    for (const rule of this.websiteRules?.listSyncRules() ?? []) {
      const mapping = this.identities.findByLocalId(syncSpaceId, 'website_rule', rule.id)
      if (!mapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: website rule ' + rule.id + ' has no Sync identity'
        )
      }
      configEntities.push({
        entityType: 'website_rule',
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields: { rule }
      })
    }
    for (const rule of this.jsonRules?.listSyncRules() ?? []) {
      const mapping = this.identities.findByLocalId(syncSpaceId, 'json_rule', rule.id)
      if (!mapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: JSON rule ' + rule.id + ' has no Sync identity'
        )
      }
      configEntities.push({
        entityType: 'json_rule',
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields: { rule }
      })
    }
    if (this.rssHubSettings) {
      const mapping = this.identities.findByLocalId(
        syncSpaceId,
        'rsshub_settings',
        'rsshub-settings'
      )
      if (!mapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: RSSHub settings have no Sync identity'
        )
      }
      configEntities.push({
        entityType: 'rsshub_settings',
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields: { settings: this.rssHubSettings.current() }
      })
    }
    if (this.websiteParsePreferences) {
      const localFeedIds = new Set(feeds.map((feed) => String(feed.localId)))
      for (const [localFeedId, preference] of this.websiteParsePreferences.listUserSyncStates(localFeedIds)) {
        const feedSyncId = feedMappings.get(localFeedId)
        if (!feedSyncId) {
          throw new SyncRebaseUnsafeError(
            'REBASE_UNSAFE: website parse preference references unmapped feed ' + localFeedId
          )
        }
        const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', feedSyncId)
        if (!feedMapping) {
          throw new SyncRebaseUnsafeError(
            'REBASE_UNSAFE: website parse preference references missing feed mapping ' + feedSyncId
          )
        }
        const mapping = this.identities.findByLocalId(
          syncSpaceId,
          'website_parse_preference',
          feedSyncId
        )
        if (!mapping) {
          throw new SyncRebaseUnsafeError(
            'REBASE_UNSAFE: website parse preference for ' + feedSyncId +
              ' has no Sync identity'
          )
        }
        configEntities.push({
          entityType: 'website_parse_preference',
          entitySyncId: mapping.syncId,
          generation: mapping.generation,
          fields: {
            preference: {
              feedSyncId,
              feedGeneration: feedMapping.generation,
              dynamicRenderingEnabled: preference.dynamicRenderingEnabled,
              preferredRuleId: preference.preferredRuleId,
              preferredRuleName: preference.preferredRuleName
            }
          }
        })
      }
    }
    const rssHubSubscriptionSources = this.database.prepare(`
      SELECT r.feed_id,r.source_url
      FROM rsshub_source_urls r
      JOIN feeds f ON f.id=r.feed_id
      WHERE f.account_id=?
      ORDER BY r.feed_id
    `).all(accountId) as unknown as Array<{ feed_id: string; source_url: string }>
    for (const row of rssHubSubscriptionSources) {
      const feedMapping = this.identities.findByLocalId(syncSpaceId, 'feed', row.feed_id)
      if (!feedMapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: RSSHub subscription source references unmapped feed ' + row.feed_id
        )
      }
      const mapping = this.identities.findByLocalId(
        syncSpaceId,
        'rsshub_subscription_source',
        feedMapping.syncId
      )
      if (!mapping) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: RSSHub subscription source for ' + feedMapping.syncId +
            ' has no Sync identity'
        )
      }
      configEntities.push({
        entityType: 'rsshub_subscription_source',
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields: {
          source: {
            feedSyncId: feedMapping.syncId,
            feedGeneration: feedMapping.generation,
            sourceUrl: row.source_url
          }
        }
      })
    }
    configEntities.sort((left, right) =>
      left.entityType.localeCompare(right.entityType) ||
      left.entitySyncId.localeCompare(right.entitySyncId)
    )
    return canonicalJson(JSON.stringify({
      schemaVersion: 1,
      mappings: mappings.map((row) => ({
        entityType: row.entity_type,
        syncId: row.sync_id,
        canonicalKey: row.canonical_key,
        generation: Number(row.generation)
      })),
      libraryState: { schemaVersion: 1, groups, feeds },
      articleState: { schemaVersion: 1, articles },
      configRulesJson: this.articleFilters?.exportRules() ?? '{"schemaVersion":1,"rules":[]}',
      configStateJson: canonicalJson(JSON.stringify({
        schemaVersion: 1,
        entities: configEntities
      })),
      fieldVersions,
      rollbackBaselines,
      tombstones,
      aliasEdges,
      coverage: this.state.getCoverage(syncSpaceId)
    }))
  }

  private requireSnapshotFeedParent(
    syncSpaceId: string,
    feedSyncId: string,
    feedGeneration: number | null,
    label: string
  ): string {
    const mapping = this.identities.findBySyncId(syncSpaceId, 'feed', feedSyncId)
    if (!mapping) {
      throw new SnapshotDependencyMissingError(label + ' is waiting for feed ' + feedSyncId)
    }
    if (feedGeneration != null) {
      if (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0) {
        throw new SnapshotCorruptedError(label + ' has invalid feedGeneration')
      }
      if (mapping.generation !== feedGeneration) {
        throw new SnapshotCorruptedError(
          label + ' references feed ' + feedSyncId + ' generation ' + feedGeneration +
            ', but Snapshot mapping is generation ' + mapping.generation
        )
      }
    } else if (mapping.generation > 0) {
      throw new SnapshotCorruptedError(
        label + ' omits feedGeneration for revived feed ' + feedSyncId
      )
    }
    const feedRow = this.database.prepare('SELECT 1 FROM feeds WHERE id=? LIMIT 1')
      .get(mapping.localId)
    if (!feedRow) {
      throw new SnapshotDependencyMissingError(
        label + ' is waiting for materialized feed ' + feedSyncId
      )
    }
    return mapping.localId
  }

  private applyExternalConfigState(syncSpaceId: string, entityStateJson: string, now: number): void {
    const allEntities = this.parseEntities(entityStateJson, 'CONFIG')
    const supportedConfigTypes = new Set([
      'filter_rule',
      'website_rule',
      'json_rule',
      'rsshub_settings',
      'website_parse_preference',
      'rsshub_subscription_source'
    ])
    for (const entity of allEntities) {
      if (typeof entity.entityType !== 'string' || !entity.entityType.trim()) {
        throw new SnapshotCorruptedError('CONFIG Snapshot entity has no entityType')
      }
      if (typeof entity.entitySyncId !== 'string' || !entity.entitySyncId.trim()) {
        throw new SnapshotCorruptedError('CONFIG Snapshot entity has no entitySyncId')
      }
      if (!supportedConfigTypes.has(entity.entityType)) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: unsupported CONFIG Snapshot entity type ' + entity.entityType
        )
      }
      const generation = entity.generation ?? 0
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new SnapshotCorruptedError(
          'CONFIG Snapshot entity ' + entity.entityType + '/' + entity.entitySyncId +
            ' has invalid generation'
        )
      }
      if (!entity.fields || typeof entity.fields !== 'object' || Array.isArray(entity.fields)) {
        throw new SnapshotCorruptedError(
          'CONFIG Snapshot entity ' + entity.entityType + '/' + entity.entitySyncId +
            ' has no fields'
        )
      }
    }
    const liveConfigEntities = allEntities.filter((entity) => {
      const tombstone = this.database.prepare(
        'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
      ).get(syncSpaceId, entity.entityType, entity.entitySyncId) as { generation: number } | undefined
      return !tombstone || Number(tombstone.generation) < (entity.generation ?? 0)
    })
    const entities = liveConfigEntities
      .filter((entity) => entity.entityType === 'filter_rule')
      .sort((a, b) => a.entitySyncId.localeCompare(b.entitySyncId))
    if (!this.articleFilters) {
      if (entities.length) throw new SyncRebaseUnsafeError('REBASE_UNSAFE: CONFIG projection is unavailable')
    } else {
      const rules: ArticleFilterRule[] = entities.map((entity) => {
        let mapping = this.identities.findBySyncId(syncSpaceId, 'filter_rule', entity.entitySyncId)
        const generation = entity.generation ?? 0
        if (!mapping) {
          mapping = {
            syncSpaceId,
            entityType: 'filter_rule',
            localId: randomUUID(),
            syncId: entity.entitySyncId,
            canonicalKey: null,
            generation,
            createdAt: now,
            updatedAt: now
          }
          this.identities.insertMapping(mapping)
        } else if (generation < mapping.generation) {
          throw new SyncLocalRecoverySnapshotRequiredError(
            `LOCAL_RECOVERY_REQUIRED: CONFIG filter rule ${entity.entitySyncId} generation ${generation} is behind local generation ${mapping.generation}`
          )
        } else if (generation > mapping.generation) {
          this.database.prepare(
            'UPDATE sync_identity_mapping SET generation=?,updated_at=? WHERE sync_space_id=? AND entity_type=? AND local_id=?'
          ).run(generation, now, syncSpaceId, 'filter_rule', mapping.localId)
          mapping = { ...mapping, generation, updatedAt: now }
        }
        const feedSyncId = entity.fields.feedSyncId == null ? null : String(entity.fields.feedSyncId)
        const feedGeneration = entity.fields.feedGeneration == null
          ? null
          : Number(entity.fields.feedGeneration)
        if (feedSyncId == null && feedGeneration != null) {
          throw new SnapshotCorruptedError(
            'CONFIG filter rule ' + entity.entitySyncId + ' has feedGeneration without feedSyncId'
          )
        }
        const feedId = feedSyncId == null
          ? null
          : this.requireSnapshotFeedParent(
              syncSpaceId,
              feedSyncId,
              feedGeneration,
              'CONFIG filter rule ' + entity.entitySyncId
            )
        if (typeof entity.fields.keyword !== 'string') {
          throw new SnapshotCorruptedError(
            'CONFIG filter rule ' + entity.entitySyncId + ' has no keyword'
          )
        }
        if (
          entity.fields.type !== undefined &&
          entity.fields.type !== 'KEYWORD' &&
          entity.fields.type !== 'REGEX'
        ) {
          throw new SnapshotCorruptedError(
            'CONFIG filter rule ' + entity.entitySyncId + ' has invalid type'
          )
        }
        return {
          id: mapping.localId,
          keyword: entity.fields.keyword,
          feedId: feedId ?? null,
          feedName: entity.fields.feedName == null ? null : String(entity.fields.feedName),
          type: (entity.fields.type === 'REGEX' ? 'REGEX' : 'KEYWORD') as ArticleFilterRuleType,
          enabled: entity.fields.enabled !== false
        }
      })
      this.articleFilters.replaceRules(rules)
    }

    const ensureAtomicConfigMapping = (
      entityType: 'website_rule' | 'json_rule' | 'rsshub_settings' | 'website_parse_preference' | 'rsshub_subscription_source',
      syncId: string,
      localId: string,
      generation: number
    ): void => {
      const expectedSyncId = configRuleSyncId(entityType, localId)
      if (syncId !== expectedSyncId) {
        throw new SnapshotCorruptedError(
          'CONFIG Snapshot identity mismatch for ' + entityType + '/' + localId
        )
      }
      const existing = this.identities.findBySyncId(syncSpaceId, entityType, syncId)
      if (!existing) {
        this.identities.insertMapping({
          syncSpaceId,
          entityType,
          localId,
          syncId,
          canonicalKey: null,
          generation,
          createdAt: now,
          updatedAt: now
        })
        return
      }
      if (existing.localId !== localId) {
        throw new SnapshotCorruptedError('CONFIG Snapshot mapping localId mismatch for ' + entityType)
      }
      if (generation < existing.generation) {
        throw new SyncLocalRecoverySnapshotRequiredError(
          'LOCAL_RECOVERY_REQUIRED: CONFIG ' + entityType + '/' + syncId +
            ' generation ' + generation + ' is behind local generation ' + existing.generation
        )
      }
      if (generation > existing.generation) {
        this.identities.updateMappings([{ ...existing, generation, updatedAt: now }])
      }
    }

    const websiteEntities = liveConfigEntities
      .filter((entity) => entity.entityType === 'website_rule')
      .sort((a, b) => a.entitySyncId.localeCompare(b.entitySyncId))
    if (websiteEntities.length && !this.websiteRules) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: Website CONFIG projection is unavailable')
    }
    if (this.websiteRules) {
      const websiteRules: WebsiteRule[] = websiteEntities.map((entity) => {
        const raw = entity.fields.rule
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new SnapshotCorruptedError('CONFIG website rule has no valid rule field')
        }
        const rule = raw as WebsiteRule
        if (typeof rule.id !== 'string' || !rule.id.trim()) {
          throw new SnapshotCorruptedError('CONFIG website rule has no id')
        }
        ensureAtomicConfigMapping('website_rule', entity.entitySyncId, rule.id, entity.generation ?? 0)
        return rule
      })
      this.websiteRules.replaceSyncRules(websiteRules)
    }

    const jsonEntities = liveConfigEntities
      .filter((entity) => entity.entityType === 'json_rule')
      .sort((a, b) => a.entitySyncId.localeCompare(b.entitySyncId))
    if (jsonEntities.length && !this.jsonRules) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: JSON CONFIG projection is unavailable')
    }
    if (this.jsonRules) {
      const jsonRules: JsonRule[] = jsonEntities.map((entity) => {
        const raw = entity.fields.rule
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new SnapshotCorruptedError('CONFIG JSON rule has no valid rule field')
        }
        const rule = raw as JsonRule
        if (typeof rule.id !== 'string' || !rule.id.trim()) {
          throw new SnapshotCorruptedError('CONFIG JSON rule has no id')
        }
        ensureAtomicConfigMapping('json_rule', entity.entitySyncId, rule.id, entity.generation ?? 0)
        return rule
      })
      this.jsonRules.replaceSyncRules(jsonRules)
    }

    const rssHubEntities = liveConfigEntities.filter((entity) => entity.entityType === 'rsshub_settings')
    if (rssHubEntities.length !== 1) {
      throw new SnapshotCorruptedError(
        'CONFIG Snapshot must contain exactly one RSSHub settings entity'
      )
    }
    if (!this.rssHubSettings) {
      throw new SyncRebaseUnsafeError('REBASE_UNSAFE: RSSHub CONFIG projection is unavailable')
    }
    const rssHubEntity = rssHubEntities[0]!
    const raw = rssHubEntity.fields.settings
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SnapshotCorruptedError('CONFIG RSSHub settings has no valid settings field')
    }
    ensureAtomicConfigMapping(
      'rsshub_settings',
      rssHubEntity.entitySyncId,
      'rsshub-settings',
      rssHubEntity.generation ?? 0
    )
    this.rssHubSettings.replaceSyncSettings(raw as RssHubSettings)

    const preferenceEntities = liveConfigEntities
      .filter((entity) => entity.entityType === 'website_parse_preference')
      .sort((a, b) => a.entitySyncId.localeCompare(b.entitySyncId))
    if (preferenceEntities.length && !this.websiteParsePreferences) {
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: Website parse preference CONFIG projection is unavailable'
      )
    }
    if (this.websiteParsePreferences) {
      const incomingFeedSyncIds = new Set<string>()
      for (const entity of preferenceEntities) {
        const raw = entity.fields.preference
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new SnapshotCorruptedError(
            'CONFIG website parse preference has no valid preference field'
          )
        }
        const preference = raw as Record<string, unknown>
        const feedSyncId =
          typeof preference.feedSyncId === 'string' ? preference.feedSyncId : ''
        if (!feedSyncId) {
          throw new SnapshotCorruptedError(
            'CONFIG website parse preference has no feedSyncId'
          )
        }
        const feedGeneration = preference.feedGeneration == null
          ? null
          : Number(preference.feedGeneration)
        if (incomingFeedSyncIds.has(feedSyncId)) {
          throw new SnapshotCorruptedError(
            'CONFIG Snapshot contains duplicate website parse preference for ' + feedSyncId
          )
        }
        incomingFeedSyncIds.add(feedSyncId)
        ensureAtomicConfigMapping(
          'website_parse_preference',
          entity.entitySyncId,
          feedSyncId,
          entity.generation ?? 0
        )
        const localFeedId = this.requireSnapshotFeedParent(
          syncSpaceId,
          feedSyncId,
          feedGeneration,
          'CONFIG website parse preference ' + entity.entitySyncId
        )
        const state: WebsiteParsePreferenceUserSyncState = {
          dynamicRenderingEnabled: preference.dynamicRenderingEnabled === true,
          preferredRuleId:
            typeof preference.preferredRuleId === 'string'
              ? preference.preferredRuleId
              : null,
          preferredRuleName:
            typeof preference.preferredRuleName === 'string'
              ? preference.preferredRuleName
              : null
        }
        this.websiteParsePreferences.applyUserSyncState(localFeedId, state)
      }
      for (const preferenceMapping of this.identities.listByType(syncSpaceId, 'website_parse_preference')) {
        if (incomingFeedSyncIds.has(preferenceMapping.localId)) continue
        const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', preferenceMapping.localId)
        if (feedMapping) {
          this.websiteParsePreferences.applyUserSyncState(feedMapping.localId, null)
        }
      }
    }

    const rssHubSourceEntities = liveConfigEntities
      .filter((entity) => entity.entityType === 'rsshub_subscription_source')
      .sort((a, b) => a.entitySyncId.localeCompare(b.entitySyncId))
    const incomingRssHubFeedSyncIds = new Set<string>()
    for (const entity of rssHubSourceEntities) {
      const raw = entity.fields.source
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new SnapshotCorruptedError(
          'CONFIG RSSHub subscription source has no valid source field'
        )
      }
      const source = raw as Record<string, unknown>
      const feedSyncId = typeof source.feedSyncId === 'string' ? source.feedSyncId.trim() : ''
      const feedGeneration = source.feedGeneration == null
        ? null
        : Number(source.feedGeneration)
      const sourceUrl = typeof source.sourceUrl === 'string' ? source.sourceUrl.trim() : ''
      if (!feedSyncId || !sourceUrl) {
        throw new SnapshotCorruptedError(
          'CONFIG RSSHub subscription source requires feedSyncId and sourceUrl'
        )
      }
      if (incomingRssHubFeedSyncIds.has(feedSyncId)) {
        throw new SnapshotCorruptedError(
          'CONFIG Snapshot contains duplicate RSSHub subscription source for ' + feedSyncId
        )
      }
      incomingRssHubFeedSyncIds.add(feedSyncId)
      ensureAtomicConfigMapping(
        'rsshub_subscription_source',
        entity.entitySyncId,
        feedSyncId,
        entity.generation ?? 0
      )
      const localFeedId = this.requireSnapshotFeedParent(
        syncSpaceId,
        feedSyncId,
        feedGeneration,
        'CONFIG RSSHub subscription source ' + entity.entitySyncId
      )
      new LibraryRepository(this.database).replaceRssHubSourceUrlFromSync(localFeedId, sourceUrl)
    }
    for (const sourceMapping of this.identities.listByType(syncSpaceId, 'rsshub_subscription_source')) {
      if (incomingRssHubFeedSyncIds.has(sourceMapping.localId)) continue
      const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', sourceMapping.localId)
      if (feedMapping) {
        this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?').run(feedMapping.localId)
      }
    }
  }

  private parseEntities(json: string, lane?: string): Array<{
    entityType: string
    entitySyncId: string
    generation?: number
    fields: Record<string, unknown>
  }> {
    if (!json || json.trim() === '' || json.trim() === '[]') return []
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>
      if (Array.isArray(parsed)) return parsed
      if (parsed && Array.isArray(parsed.entities)) return parsed.entities as Array<{
        entityType: string
        entitySyncId: string
        generation?: number
        fields: Record<string, unknown>
      }>
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'entities')) {
        throw new SnapshotCorruptedError('entityStateJson entities must be an array')
      }
      if (lane === 'LIBRARY' && parsed && (Array.isArray(parsed.groups) || Array.isArray(parsed.feeds))) {
        const groups = (Array.isArray(parsed.groups) ? parsed.groups : []) as Array<Record<string, unknown>>
        const feeds = (Array.isArray(parsed.feeds) ? parsed.feeds : []) as Array<Record<string, unknown>>
        return [
          ...groups.map((group) => ({
            entityType: 'group',
            entitySyncId: String(group.syncId),
            generation: 0,
            fields: { name: String(group.name ?? 'Group') }
          })),
          ...feeds.map((feed) => ({
            entityType: 'feed',
            entitySyncId: String(feed.syncId),
            generation: 0,
            fields: {
              groupSyncId: feed.groupSyncId,
              groupGeneration: feed.groupGeneration ?? null,
              name: feed.name,
              icon: feed.icon ?? null,
              url: feed.url,
              sourceType: feed.sourceType,
              isNotification: feed.isNotification,
              isFullContent: feed.isFullContent,
              isBrowser: feed.isBrowser
            }
          }))
        ]
      }
      if (lane === 'ARTICLE_STATE' && parsed && Array.isArray(parsed.articles)) {
        return (parsed.articles as Array<Record<string, unknown>>).map((article) => ({
          entityType: 'article',
          entitySyncId: String(article.syncId),
          generation: 0,
          fields: {
            feedSyncId: article.feedSyncId,
            feedGeneration: article.feedGeneration ?? null,
            title: article.title,
            url: article.link,
            author: article.author ?? null,
            publishedAt: article.date,
            description: article.description ?? '',
            contentHtml: article.contentHtml ?? '',
            imageUrl: article.imageUrl ?? null,
            isUnread: article.isUnread,
            isStarred: article.isStarred,
            isReadLater: article.isReadLater
          }
        }))
      }
      if (lane === 'CONFIG' && parsed && Array.isArray(parsed.rules)) {
        return (parsed.rules as Array<Record<string, unknown>>).map((rule, index) => ({
          entityType: 'filter_rule',
          entitySyncId: String(rule.id ?? `snapshot-rule-${index}`),
          generation: 0,
          fields: { ...rule }
        }))
      }
      return []
    } catch (e) {
      throw new SnapshotCorruptedError(`Failed to parse entityStateJson: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private restoreFieldVersions(
    syncSpaceId: string,
    json: string,
    entities: Array<{ entityType: string; entitySyncId: string; generation?: number; fields?: Record<string, unknown> }>,
    now: number
  ): void {
    if (!json || !json.trim() || json.trim() === '{}') return
    try {
      const raw = JSON.parse(json) as unknown
      if (Array.isArray(raw)) {
        for (const value of raw as Array<Record<string, unknown>>) {
          if (value.entityType != null && typeof value.entityType !== 'string') {
            throw new SnapshotCorruptedError('Snapshot field-version entityType is invalid')
          }
          if (typeof value.entitySyncId !== 'string' || !value.entitySyncId.trim()) {
            throw new SnapshotCorruptedError('Snapshot field-version entitySyncId is invalid')
          }
          if (typeof value.fieldId !== 'string' || !value.fieldId.trim()) {
            throw new SnapshotCorruptedError('Snapshot field-version fieldId is invalid')
          }
          if (typeof value.versionToken !== 'string' || !value.versionToken.trim()) {
            throw new SnapshotCorruptedError('Snapshot field-version versionToken is invalid')
          }
          if (typeof value.valueJson !== 'string') {
            throw new SnapshotCorruptedError('Snapshot field-version valueJson is invalid')
          }
          const rowEntityType = value.entityType ?? ''
          const entitySyncId = value.entitySyncId
          const rowGeneration = value.entityGeneration == null ? null : Number(value.entityGeneration)
          const fieldId = value.fieldId
          const versionToken = value.versionToken
          const candidates = entities.filter((candidate) => candidate.entitySyncId === entitySyncId)
          if (!rowEntityType && candidates.length > 1) {
            throw new SnapshotCorruptedError(
              'Snapshot field-version entity type is ambiguous for ' + entitySyncId
            )
          }
          const entity = rowEntityType
            ? candidates.find((candidate) => candidate.entityType === rowEntityType)
            : candidates[0]
          if (!entity) {
            throw new SnapshotCorruptedError(
              'Snapshot field-version has no matching entity: ' + entitySyncId
            )
          }
          if (rowEntityType && rowEntityType !== entity.entityType) {
            throw new SnapshotCorruptedError('Snapshot field-version entity type does not match entity state')
          }
          const entityGeneration = entity.generation ?? 0
          if (rowGeneration != null && (!Number.isSafeInteger(rowGeneration) || rowGeneration < 0 || rowGeneration !== entityGeneration)) {
            throw new SnapshotCorruptedError('Snapshot field-version generation does not match entity state')
          }
          const causalContextJson = value.causalContextJson == null ? null : String(value.causalContextJson)
          const logicalClock = value.logicalClock == null ? null : Number(value.logicalClock)
          if (logicalClock != null && (!Number.isSafeInteger(logicalClock) || logicalClock < 0)) {
            throw new SnapshotCorruptedError('Snapshot field-version logicalClock is invalid')
          }
          this.state.retainFieldCandidate({
            syncSpaceId,
            entityType: entity.entityType,
            entitySyncId,
            fieldId,
            entityGeneration,
            versionToken,
            sourceOperationId: null,
            valueJson: value.valueJson,
            causalContextJson,
            logicalClock,
            updatedAt: now
          })
          const fieldCandidates = this.state.listFieldCandidates(syncSpaceId).filter((row) =>
            row.entityType === entity.entityType && row.entitySyncId === entitySyncId &&
            row.entityGeneration === entityGeneration && row.fieldId === fieldId &&
            (raw as Array<Record<string, unknown>>).some((item) =>
              item.entitySyncId === entitySyncId &&
              item.fieldId === fieldId &&
              item.versionToken === row.versionToken &&
              (item.entityType == null || String(item.entityType) === entity.entityType) &&
              (item.entityGeneration == null || Number(item.entityGeneration) === entityGeneration)
            ))
          const winner = resolveSnapshotFieldCandidates(fieldCandidates, fieldId)
          this.state.upsertFieldVersion(fieldCandidates.find((row) => row.versionToken === winner)!)
        }
        return
      }
      const parsed = raw as { fields?: Record<string, Record<string, string>> }
      const fieldVersions = parsed.fields ?? (parsed as unknown as Record<string, Record<string, string>>)
      if (!fieldVersions || typeof fieldVersions !== 'object') return

      const entityFieldsMap = new Map<string, Record<string, unknown>>()
      const entityGenerationMap = new Map<string, number>()
      for (const ent of entities) {
        if (ent.fields) {
          const key = `${ent.entityType}:${ent.entitySyncId}`
          entityFieldsMap.set(key, ent.fields)
          entityGenerationMap.set(key, ent.generation ?? 0)
        }
      }

      for (const [entityKey, fields] of Object.entries(fieldVersions)) {
        const colonIndex = entityKey.indexOf(':')
        if (colonIndex <= 0 || colonIndex === entityKey.length - 1) {
          throw new SnapshotCorruptedError('Snapshot field-version entity key is invalid: ' + entityKey)
        }
        const entityType = entityKey.slice(0, colonIndex)
        const entitySyncId = entityKey.slice(colonIndex + 1)
        const entityFields = entityFieldsMap.get(entityKey)
        if (!entityFields || !entityGenerationMap.has(entityKey)) {
          throw new SnapshotCorruptedError(
            'Snapshot field-version has no matching entity: ' + entityKey
          )
        }
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          throw new SnapshotCorruptedError(
            'Snapshot field-version map is invalid for entity: ' + entityKey
          )
        }

        for (const [fieldId, versionToken] of Object.entries(fields)) {
          if (!fieldId.trim()) {
            throw new SnapshotCorruptedError(
              'Snapshot field-version has a blank fieldId for entity: ' + entityKey
            )
          }
          if (typeof versionToken !== 'string' || !versionToken.trim()) {
            throw new SnapshotCorruptedError(
              'Snapshot field-version token is invalid for ' + entityKey + '/' + fieldId
            )
          }
          if (!Object.prototype.hasOwnProperty.call(entityFields, fieldId)) {
            throw new SnapshotCorruptedError(
              'Snapshot field-version has no matching field value: ' + entityKey + '/' + fieldId
            )
          }
          const rawVal = entityFields[fieldId]
          const valueJson = JSON.stringify(rawVal)
          this.state.upsertFieldVersion({
            syncSpaceId,
            entityType,
            entitySyncId,
            fieldId,
            entityGeneration: entityGenerationMap.get(entityKey) ?? 0,
            versionToken,
            sourceOperationId: null,
            valueJson,
            updatedAt: now
          })
        }
      }
    } catch (e) {
      throw new SnapshotCorruptedError(`Failed to parse fieldVersionStateJson: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private restoreAliasEdges(syncSpaceId: string, causalMetadataJson: string, now: number): void {
    if (!causalMetadataJson?.trim() || causalMetadataJson.trim() === '{}') return
    try {
      const parsed = JSON.parse(causalMetadataJson) as { aliasEdges?: SyncAliasEdgePayloadV1[] }
      const edges = [...(parsed.aliasEdges ?? [])].sort((a, b) =>
        a.targetEntityType.localeCompare(b.targetEntityType) ||
        a.leftGeneration - b.leftGeneration ||
        a.leftSyncId.localeCompare(b.leftSyncId) ||
        a.rightSyncId.localeCompare(b.rightSyncId)
      )
      for (const edge of edges) this.aliases.applyEdge(syncSpaceId, edge, null, now)
    } catch (e) {
      throw new SnapshotCorruptedError(
        'Failed to parse Alias Edge snapshot state: ' + (e instanceof Error ? e.message : String(e))
      )
    }
  }

  private validateAuthEntities(
    syncSpaceId: string,
    entities: Array<{
      entityType: string
      entitySyncId: string
      generation?: number
      fields: Record<string, unknown>
    }>
  ): void {
    const ledgerEntities = entities.filter((entity) => entity.entityType === 'auth_ledger')
    if (ledgerEntities.length !== 1) {
      throw new SnapshotCorruptedError('AUTH Snapshot must contain exactly one auth_ledger entity')
    }
    const rawObjects = ledgerEntities[0]!.fields.objects
    if (!Array.isArray(rawObjects) || rawObjects.length === 0) {
      throw new SnapshotCorruptedError('AUTH Snapshot is missing signed ledger objects')
    }

    const snapshotObjects = rawObjects.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SnapshotCorruptedError('AUTH Snapshot contains an invalid protocol object')
      }
      return value as SyncAuthProtocolObject
    })
    if (!snapshotObjects.some((object) => object.objectType === 'SPACE_ROOT')) {
      throw new SnapshotCorruptedError('AUTH Snapshot has no SPACE_ROOT')
    }
    if (snapshotObjects.some((object) => object.syncSpaceId !== syncSpaceId)) {
      throw new SnapshotCorruptedError('AUTH Snapshot contains an object from another Sync Space')
    }
    const ids = new Set<string>()
    for (const object of snapshotObjects) {
      if (!object.authObjectId || ids.has(object.authObjectId)) {
        throw new SnapshotCorruptedError('AUTH Snapshot contains duplicate or empty authObjectId')
      }
      ids.add(object.authObjectId)
    }

    const localById = new Map(
      this.runtime.listAuthObjects(syncSpaceId).map((object) => [object.authObjectId, object] as const)
    )
    for (const snapshot of snapshotObjects) {
      const local = localById.get(snapshot.authObjectId)
      if (!local || canonicalJson(JSON.stringify(local)) !== canonicalJson(JSON.stringify(snapshot))) {
        throw new SyncRebaseUnsafeError(
          'REBASE_UNSAFE: Snapshot AUTH history is not present in the verified local ledger'
        )
      }
    }
  }

  private restoreBlobIndexes(
    syncSpaceId: string,
    lane: string,
    manifestIndexJson: string,
    referenceIndexJson: string,
    now: number
  ): void {
    let manifests: SyncBlobManifest[]
    let references: SyncBlobReferenceRecord[]
    try {
      const rawManifests = JSON.parse(manifestIndexJson || '[]') as unknown
      const rawReferences = JSON.parse(referenceIndexJson || '[]') as unknown
      if (!Array.isArray(rawManifests) || !Array.isArray(rawReferences)) {
        throw new Error('Blob indexes must be arrays')
      }
      manifests = rawManifests.map((value) => {
        const row = value as Partial<SyncBlobManifest>
        return {
          hash: String(row.hash ?? ''),
          totalBytes: Number(row.totalBytes ?? -1),
          mediaType: row.mediaType ?? null,
          compression: row.compression ?? null,
          encryptionInfoJson: row.encryptionInfoJson ?? null,
          availabilityPolicy: row.availabilityPolicy ?? 'LAZY',
          durability: row.durability as SyncBlobManifest['durability'],
          referenceCount: Number(row.referenceCount ?? 0)
        }
      })
      references = rawReferences as SyncBlobReferenceRecord[]
    } catch (error) {
      throw new SnapshotCorruptedError(
        `Failed to parse Blob indexes for lane ${lane}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const manifestHashes = new Set(manifests.map((manifest) => manifest.hash))
    if (references.some((reference) => reference.ownerEntityType === '__operation__')) {
      throw new SnapshotCorruptedError('Snapshot Blob index must not contain Operation-owned references')
    }
    for (const reference of references) {
      if (reference.replicationLaneId !== lane) {
        throw new SnapshotCorruptedError(
          `Blob reference lane ${reference.replicationLaneId} does not match shard ${lane}`
        )
      }
      if (!manifestHashes.has(reference.hash)) {
        throw new SnapshotCorruptedError(`Blob reference ${reference.hash} has no manifest in the same shard`)
      }
    }
    this.blobs.clearMaterializedLaneReferences(syncSpaceId, lane)
    for (const manifest of [...manifests].sort((a, b) => a.hash.localeCompare(b.hash))) {
      this.blobs.registerManifest(manifest, 'BLOB_MISSING', now)
    }
    for (const reference of references) {
      this.blobs.addReference(
        syncSpaceId,
        reference.replicationLaneId,
        reference.ownerEntityType,
        reference.ownerEntitySyncId,
        reference.ownerEntityGeneration,
        reference.referenceKind,
        reference.hash,
        now
      )
    }
  }

  private restoreTombstones(
    localAccountId: number,
    syncSpaceId: string,
    snapshotBundleId: string,
    json: string,
    now: number
  ): void {
    if (!json || !json.trim() || json.trim() === '[]') return
    try {
      const parsed = JSON.parse(json) as {
        deleted?: Array<{ entityType: string; entitySyncId: string; generation?: number; versionToken?: string; deletedAt?: number }>
        generations?: Record<string, number>
      }
      if (Array.isArray(parsed.deleted)) {
        const deleted = [...parsed.deleted].sort((a, b) => {
          const byType =
            (TOMBSTONE_ENTITY_ORDER[a.entityType] ?? 99) -
            (TOMBSTONE_ENTITY_ORDER[b.entityType] ?? 99)
          return byType || a.entitySyncId.localeCompare(b.entitySyncId)
        })
        for (const t of deleted) {
          const tombstoneGeneration = t.generation ?? 1
          if (
            this.aiHistory?.owns(t.entityType) &&
            this.aiHistory.isSnapshotEntityGenerationStale(
              syncSpaceId,
              t.entityType,
              t.entitySyncId,
              tombstoneGeneration
            )
          ) {
            throw new SyncLocalRecoverySnapshotRequiredError(
              `LOCAL_RECOVERY_REQUIRED: Snapshot tombstone ${t.entityType}/${t.entitySyncId} generation ${tombstoneGeneration} is behind local AI_HISTORY generation`
            )
          }
          this.state.recordTombstone(
            syncSpaceId,
            t.entityType,
            t.entitySyncId,
            tombstoneGeneration,
            t.versionToken ?? `TOMBSTONE|${snapshotBundleId}|${t.entitySyncId}`,
            t.deletedAt ?? now
          )
          this.aliases.reconcileDeleteWins(
            syncSpaceId,
            t.entityType as SyncEntityType,
            t.entitySyncId,
            tombstoneGeneration,
            now
          )
          const mapping = this.identities.findBySyncId(syncSpaceId, t.entityType as SyncEntityType, t.entitySyncId)
          if (this.aiHistory?.owns(t.entityType)) {
            this.aiHistory.materializeSnapshotTombstone(
              syncSpaceId,
              t.entityType,
              t.entitySyncId,
              tombstoneGeneration,
              t.versionToken ?? `TOMBSTONE|${snapshotBundleId}|${t.entitySyncId}`,
              t.deletedAt ?? now
            )
            continue
          }
          if (!mapping || (t.generation ?? 1) < mapping.generation) continue
          if (t.entityType === 'article') {
            this.blobs.removeOwnerReferences(
              syncSpaceId,
              'ARTICLE_STATE',
              'article',
              t.entitySyncId,
              t.generation ?? 1
            )
            this.database.prepare('DELETE FROM articles WHERE id=? AND account_id=?').run(mapping.localId, localAccountId)
          } else if (t.entityType === 'feed') {
            this.database.prepare('DELETE FROM feeds WHERE id=? AND account_id=?').run(mapping.localId, localAccountId)
            this.articleFilters?.deleteByFeed(mapping.localId)
            this.websiteParsePreferences?.delete(mapping.localId)
            this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?').run(mapping.localId)
          } else if (t.entityType === 'group') {
            this.database.prepare('DELETE FROM groups WHERE id=? AND account_id=?').run(mapping.localId, localAccountId)
          } else if (t.entityType === 'website_parse_preference') {
            const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', mapping.localId)
            if (feedMapping) {
              this.websiteParsePreferences?.applyUserSyncState(feedMapping.localId, null)
            }
          } else if (t.entityType === 'rsshub_subscription_source') {
            const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', mapping.localId)
            if (feedMapping) {
              this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?')
                .run(feedMapping.localId)
            }
          }
          if ((t.generation ?? 1) > mapping.generation) {
            this.database.prepare(
              'UPDATE sync_identity_mapping SET generation=?,updated_at=? WHERE sync_space_id=? AND entity_type=? AND local_id=?'
            ).run(t.generation ?? 1, now, syncSpaceId, t.entityType, mapping.localId)
          }
        }
      }
    } catch (e) {
      throw new SnapshotCorruptedError(`Failed to parse deletionGenerationSummaryJson: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private materializeEntity(
    localAccountId: number,
    syncSpaceId: string,
    entity: {
      entityType: string
      entitySyncId: string
      generation?: number
      fields: Record<string, unknown>
    },
    now: number
  ): void {
    const { entityType, entitySyncId, fields } = entity
    const generation = entity.generation ?? 0
    if (!entityType?.trim() || !entitySyncId?.trim()) {
      throw new SnapshotCorruptedError('Snapshot entity identity is blank')
    }
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new SnapshotCorruptedError(
        'Snapshot entity ' + entityType + '/' + entitySyncId + ' has invalid generation'
      )
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new SnapshotCorruptedError(
        'Snapshot entity ' + entityType + '/' + entitySyncId + ' has invalid fields'
      )
    }

    if (this.aiHistory?.owns(entityType)) {
      if (this.aiHistory.isSnapshotEntityGenerationStale(syncSpaceId, entityType, entitySyncId, generation)) {
        throw new SyncLocalRecoverySnapshotRequiredError(
          `LOCAL_RECOVERY_REQUIRED: Snapshot ${entityType}/${entitySyncId} generation ${generation} is behind local AI_HISTORY generation`
        )
      }
      this.aiHistory.materializeSnapshotEntity(syncSpaceId, entity, now)
      return
    }

    if (entityType === 'group') {
      let mapping = this.identities.findBySyncId(syncSpaceId, 'group', entitySyncId)
      const name = String(fields.name ?? 'Group')
      const sortOrder = Number(fields.sortOrder ?? 0)
      const isDefault = fields.isDefault ? 1 : 0

      if (mapping && generation < mapping.generation) {
        throw new SyncLocalRecoverySnapshotRequiredError(
          `LOCAL_RECOVERY_REQUIRED: Snapshot group ${entitySyncId} generation ${generation} is behind local generation ${mapping.generation}`
        )
      }
      if (mapping && generation > mapping.generation) {
        mapping = { ...mapping, generation, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
      if (mapping) {
        this.database.prepare('UPDATE groups SET name=?,sort_order=?,is_default=? WHERE id=? AND account_id=?')
          .run(name, sortOrder, isDefault, mapping.localId, localAccountId)
      } else {
        // 全新本地主键生成，隔离 Source 端的 localId，杜绝覆写冲突（R10-02, R10-03）
        const localId = randomUUID()
        this.database.prepare(`
          INSERT INTO groups(id,account_id,name,sort_order,is_default)
          VALUES(?,?,?,?,?)
        `).run(localId, localAccountId, name, sortOrder, isDefault)

        this.identities.insertMapping({
          syncSpaceId,
          entityType: 'group',
          localId,
          syncId: entitySyncId,
          canonicalKey: null,
          generation,
          createdAt: now,
          updatedAt: now
        })
      }
    } else if (entityType === 'feed') {
      let mapping = this.identities.findBySyncId(syncSpaceId, 'feed', entitySyncId)
      const groupSyncId = fields.groupSyncId ? String(fields.groupSyncId) : (fields.groupId ? String(fields.groupId) : null)
      const groupGeneration = fields.groupGeneration == null ? null : Number(fields.groupGeneration)
      if (!groupSyncId?.trim()) {
        throw new SnapshotCorruptedError('Feed ' + entitySyncId + ' has no groupSyncId')
      }
      if (groupGeneration != null && (!Number.isSafeInteger(groupGeneration) || groupGeneration < 0)) {
        throw new SnapshotCorruptedError('Feed ' + entitySyncId + ' has invalid groupGeneration')
      }
      let groupLocalId = 'DEFAULT_GROUP_ID'
      if (groupSyncId) {
        const groupMapping = this.identities.findBySyncId(syncSpaceId, 'group', groupSyncId)
        if (!groupMapping) {
          throw new SnapshotDependencyMissingError(`Missing group dependency ${groupSyncId} for feed ${entitySyncId}`)
        }
        if (groupGeneration != null) {
          if (!Number.isSafeInteger(groupGeneration) || groupGeneration < 0) {
            throw new SnapshotCorruptedError(`Feed ${entitySyncId} has invalid groupGeneration`)
          }
          if (groupMapping.generation !== groupGeneration) {
            throw new SnapshotCorruptedError(
              `Feed ${entitySyncId} references group ${groupSyncId} generation ${groupGeneration}, but mapping is generation ${groupMapping.generation}`
            )
          }
        } else if (groupMapping.generation > 0) {
          throw new SnapshotCorruptedError(
            `Feed ${entitySyncId} omits groupGeneration for revived group ${groupSyncId}`
          )
        }
        groupLocalId = groupMapping.localId
      }

      const name = String(fields.name ?? 'Feed')
      const url = String(fields.url ?? '')
      const sourcePageUrl = fields.sourcePageUrl ? String(fields.sourcePageUrl) : null
      if (typeof fields.sourceType !== 'string') {
        throw new SnapshotCorruptedError('Feed ' + entitySyncId + ' has no sourceType')
      }
      const sourceType = fields.sourceType.trim().toLowerCase()
      if (!['rss', 'website', 'json'].includes(sourceType)) {
        throw new SnapshotCorruptedError(
          'Feed ' + entitySyncId + ' has unsupported sourceType ' + fields.sourceType
        )
      }
      const canonicalFeedKey = feedCanonicalKey(
        sourceType as Parameters<typeof feedCanonicalKey>[0],
        url
      )
      const icon = fields.icon ? String(fields.icon) : null
      const isNotification = fields.isNotification ? 1 : 0
      const isFullContent = fields.isFullContent ? 1 : 0
      const isBrowser = fields.isBrowser ? 1 : 0
      const dynamicRendering = fields.dynamicRendering ? 1 : 0
      const createdAt = Number(fields.createdAt ?? now)
      const updatedAt = Number(fields.updatedAt ?? now)

      if (!mapping && url) {
        const existing = this.database.prepare('SELECT id FROM feeds WHERE account_id=? AND url=? LIMIT 1')
          .get(localAccountId, url) as { id: string } | undefined
        if (existing) {
          mapping = {
            syncSpaceId,
            entityType: 'feed',
            localId: existing.id,
            syncId: entitySyncId,
            canonicalKey: canonicalFeedKey,
            generation,
            createdAt: now,
            updatedAt: now
          }
          this.identities.insertMapping(mapping)
        }
      }
      if (mapping && generation < mapping.generation) {
        throw new SyncLocalRecoverySnapshotRequiredError(
          `LOCAL_RECOVERY_REQUIRED: Snapshot feed ${entitySyncId} generation ${generation} is behind local generation ${mapping.generation}`
        )
      }
      if (mapping && generation > mapping.generation) {
        mapping = { ...mapping, generation, updatedAt: now }
        this.identities.updateMappings([mapping])
      }

      if (mapping) {
        if (mapping.canonicalKey !== canonicalFeedKey) {
          mapping = { ...mapping, canonicalKey: canonicalFeedKey, updatedAt: now }
          this.identities.updateMappings([mapping])
        }
        this.database.prepare(`
          UPDATE feeds SET group_id=?,name=?,url=?,source_page_url=?,source_type=?,icon=?,is_notification=?,
                          is_full_content=?,is_browser=?,dynamic_rendering=?,updated_at=?
          WHERE id=? AND account_id=?
        `).run(groupLocalId, name, url, sourcePageUrl, sourceType, icon, isNotification, isFullContent, isBrowser, dynamicRendering, updatedAt, mapping.localId, localAccountId)
      } else {
        const localId = randomUUID()
        this.database.prepare(`
          INSERT INTO feeds(id,account_id,group_id,name,url,source_page_url,source_type,icon,is_notification,
                           is_full_content,is_browser,dynamic_rendering,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(localId, localAccountId, groupLocalId, name, url, sourcePageUrl, sourceType, icon, isNotification, isFullContent, isBrowser, dynamicRendering, createdAt, updatedAt)

        this.identities.insertMapping({
          syncSpaceId,
          entityType: 'feed',
          localId,
          syncId: entitySyncId,
          canonicalKey: canonicalFeedKey,
          generation,
          createdAt: now,
          updatedAt: now
        })
      }
    } else if (entityType === 'article') {
      let mapping = this.identities.findBySyncId(syncSpaceId, 'article', entitySyncId)
      if (mapping && generation < mapping.generation) {
        throw new SyncLocalRecoverySnapshotRequiredError(
          `LOCAL_RECOVERY_REQUIRED: Snapshot article ${entitySyncId} generation ${generation} is behind local generation ${mapping.generation}`
        )
      }
      if (mapping && generation > mapping.generation) {
        mapping = { ...mapping, generation, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
      const feedSyncId = fields.feedSyncId ? String(fields.feedSyncId) : (fields.feedId ? String(fields.feedId) : null)
      const feedGeneration = fields.feedGeneration == null ? null : Number(fields.feedGeneration)
      if (!feedSyncId) {
        throw new SnapshotDependencyMissingError(`Article ${entitySyncId} missing feedSyncId`)
      }
      const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', feedSyncId)
      if (!feedMapping) {
        // 严格阻断依赖缺失静默跳过（R10-05）
        throw new SnapshotDependencyMissingError(`Missing feed dependency ${feedSyncId} for article ${entitySyncId}`)
      }
      if (feedGeneration != null) {
        if (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0) {
          throw new SnapshotCorruptedError(`Article ${entitySyncId} has invalid feedGeneration`)
        }
        if (feedMapping.generation !== feedGeneration) {
          throw new SnapshotCorruptedError(
            `Article ${entitySyncId} references feed ${feedSyncId} generation ${feedGeneration}, but mapping is generation ${feedMapping.generation}`
          )
        }
      } else if (feedMapping.generation > 0) {
        throw new SnapshotCorruptedError(
          `Article ${entitySyncId} omits feedGeneration for revived feed ${feedSyncId}`
        )
      }
      const feedLocalId = feedMapping.localId
      const feedRow = this.database.prepare(
        'SELECT source_type,url FROM feeds WHERE id=? AND account_id=? LIMIT 1'
      ).get(feedLocalId, localAccountId) as { source_type: string; url: string } | undefined
      if (!feedRow) {
        throw new SnapshotDependencyMissingError(`Missing local feed ${feedLocalId} for article ${entitySyncId}`)
      }
      const canonicalArticleKey = articleCanonicalKey(
        feedCanonicalKey(
          feedRow.source_type as Parameters<typeof feedCanonicalKey>[0],
          feedRow.url
        ),
        fields.url ? String(fields.url) : null
      )

      const title = String(fields.title ?? '')
      const url = fields.url ? String(fields.url) : null
      const author = fields.author ? String(fields.author) : null
      const publishedAt = fields.publishedAt ? Number(fields.publishedAt) : null
      const description = String(fields.description ?? '')
      const contentHtml = fields.contentHtml ? String(fields.contentHtml) : null
      const fullContentHash = fields.fullContentHash ? String(fields.fullContentHash) : null
      const imageUrl = fields.imageUrl ? String(fields.imageUrl) : null
      const isUnread = fields.isUnread ? 1 : 0
      const isStarred = fields.isStarred ? 1 : 0
      const isReadLater = fields.isReadLater ? 1 : 0
      const createdAt = Number(fields.createdAt ?? now)
      const updatedAt = Number(fields.updatedAt ?? now)

      let localArticleId: string
      if (mapping) {
        if (mapping.canonicalKey !== canonicalArticleKey) {
          this.identities.updateMappings([
            { ...mapping, canonicalKey: canonicalArticleKey, updatedAt: now }
          ])
        }
        this.database.prepare(`
          UPDATE articles SET
            feed_id=?,title=?,url=?,author=?,published_at=?,description=?,content_html=?,image_url=?,
            is_unread=?,is_starred=?,is_read_later=?,updated_at=?
          WHERE id=? AND account_id=?
        `).run(
          feedLocalId,
          title,
          url,
          author,
          publishedAt,
          description,
          contentHtml,
          imageUrl,
          isUnread,
          isStarred,
          isReadLater,
          updatedAt,
          mapping.localId,
          localAccountId
        )
        localArticleId = mapping.localId
      } else {
        const localId = randomUUID()
        this.database.prepare(`
          INSERT INTO articles(id,account_id,feed_id,title,url,author,published_at,description,
                              content_html,full_content_html,image_url,is_unread,is_starred,is_read_later,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(localId, localAccountId, feedLocalId, title, url, author, publishedAt, description, contentHtml, null, imageUrl, isUnread, isStarred, isReadLater, createdAt, updatedAt)

        this.identities.insertMapping({
          syncSpaceId,
          entityType: 'article',
          localId,
          syncId: entitySyncId,
          canonicalKey: canonicalArticleKey,
          generation,
          createdAt: now,
          updatedAt: now
        })
        localArticleId = localId
      }
      if (fullContentHash) {
        this.businessApplier?.materializeSnapshotArticleFullContent(
          syncSpaceId,
          entitySyncId,
          generation,
          localAccountId,
          localArticleId,
          fullContentHash
        )
      }
    } else if (entityType === 'filter_rule') {
      throw new SyncRebaseUnsafeError(
        'REBASE_UNSAFE: CONFIG must be materialized through the staged external projection'
      )
    }
  }
}
