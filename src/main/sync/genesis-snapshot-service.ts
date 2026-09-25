import { randomUUID, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  SyncGenesisSessionRecord,
  SyncReplicationLane,
  SyncSnapshotBundleRecord,
  SyncSnapshotShardRecord
} from '../../shared/sync-runtime'
import {
  coverageDominates,
  type SyncCoverage,
  type SyncSnapshotBundleWire,
  type SyncSnapshotShardWire
} from '../../shared/sync-protocol'
import { SYNC_REPLICATION_LANES } from '../../shared/sync-runtime'
import type { SyncEntityType } from '../../shared/sync-identity'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { LlmChatRepository } from '../llm/chat-repository'
import { GenesisIdentityBackfillService } from './genesis-identity-backfill-service'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopOperationBuilder } from './sync-operation-builder'
import { canonicalJson } from './sync-operation-canonicalizer'
import { DesktopSyncRuntimeCoordinator, type DesktopGenesisCut } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import {
  happensBefore,
  parseOperationVersionToken,
  SyncVersionResolver,
  SyncVersionToken,
  type SyncFieldCandidate,
  type SyncGenesisMergePolicy
} from './sync-version-token'
import { encodeGenesisFrontiers } from './sync-genesis-codec'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import { authObjectId, authSigningDigest, authSigningMaterial } from './sync-auth-wire'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import {
  articleFullContentBlobRef,
  syncPayloadBlobRefs,
  SYNC_ARTICLE_FULL_CONTENT_FIELD,
  SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
} from './sync-blob-payload'
import { relationLocalId } from './sync-canonical-identity'
import { resolveLlmSyncPayloadReferences } from './llm-sync-mutation-capture'
import {
  citationAnnotationRefSyncPayload,
  citationAnnotationSyncPayload,
  citationRefSyncPayload,
  contextRefSyncPayload,
  conversationArticleSyncPayload,
  conversationSyncPayload,
  evidenceBlockSyncPayload,
  messageSyncPayload,
  toolCallSyncPayload
} from './llm-sync-payloads'
import {
  SNAPSHOT_HASH_SCHEMA_VERSION,
  snapshotCoverageCommitment,
  snapshotCoverageFromShards,
  snapshotRootHash,
  snapshotShardContentHash,
  snapshotSigningMaterial
} from './sync-snapshot-wire'

const PHASE_A_LANES: SyncReplicationLane[] = ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH']

type Row = Record<string, unknown>

interface GenesisEntity {
  entityType: string
  entitySyncId: string
  generation: number
  fields: Record<string, unknown>
}

interface GenesisFieldVersionSnapshot {
  entityType: string
  entitySyncId: string
  entityGeneration: number
  fieldId: string
  valueJson: string
  versionToken: string
  causalContextJson: string | null
  logicalClock: number | null
}

interface SnapshotTombstoneRow {
  entityType: string
  entitySyncId: string
  generation: number
  versionToken: string
  deletedAt: number
}

interface LanePayload {
  entities: GenesisEntity[]
  fieldVersions: GenesisFieldVersionSnapshot[]
}

function snapshotEntityTypesForLane(lane: SyncReplicationLane): readonly SyncEntityType[] {
  switch (lane) {
    case 'CORE_META':
      return ['alias_edge']
    case 'LIBRARY':
      return ['group', 'feed']
    case 'ARTICLE_STATE':
      return ['article']
    case 'CONFIG':
      return ['filter_rule', 'website_rule', 'json_rule', 'rsshub_settings', 'website_parse_preference', 'rsshub_subscription_source']
    case 'AI_HISTORY':
      return [
        'conversation',
        'conversation_article',
        'message',
        'tool_call',
        'context_ref',
        'evidence_block',
        'citation_ref',
        'citation_annotation',
        'citation_annotation_ref'
      ]
    case 'AUTH':
      return []
  }
}

export interface DesktopGenesisCutoverResult {
  syncSpaceId: string
  genesisSessionId: string
  genesisBaselineId: string
  crossDbCutId: string
  snapshotBundleId: string
  capturedAt: number
  tailOperationsBuilt: number
}

/**
 * R10 Genesis cutover for the Desktop local database.
 *
 * The cut is captured after outbox allocation has become transactional. The fixed view is
 * represented by lane shards, while all post-cut mutations remain ordinary outbox tail entries.
 */
export class DesktopGenesisSnapshotService {
  private readonly identities: SyncIdentityRepository
  private readonly blobState: DesktopSyncBlobStateService
  private readonly identityBackfill: GenesisIdentityBackfillService

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly coordinator: DesktopSyncRuntimeCoordinator,
    private readonly articleFilters: ArticleFilterRepository,
    identityBackfill?: GenesisIdentityBackfillService,
    private readonly operationBuilder: DesktopOperationBuilder = new DesktopOperationBuilder(runtime),
    private readonly signingKeys?: DesktopSyncDeviceSigningKeyStore,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
    private readonly websiteRules?: WebsiteRuleRepository,
    private readonly jsonRules?: JsonRuleRepository,
    private readonly rssHubSettings?: RssHubSettingsRepository,
    private readonly websiteParsePreferences?: WebsiteParsePreferenceRepository
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.blobState = new DesktopSyncBlobStateService(database)
    this.identityBackfill = identityBackfill ?? new GenesisIdentityBackfillService(
      database,
      articleFilters,
      websiteRules,
      jsonRules,
      rssHubSettings,
      websiteParsePreferences
    )
  }

  run(localAccountId: number, syncSpaceId?: string, genesisSessionId?: string, now = Date.now()): DesktopGenesisCutoverResult {
    const existingBinding = this.runtime.findBinding(localAccountId)
    const sessionId = genesisSessionId ?? existingBinding?.genesisSessionId ?? randomUUID()
    const prepared = this.coordinator.prepareSpace(localAccountId, syncSpaceId, now)
    this.ensureLocalSpaceRoot(prepared.syncSpaceId, now)
    this.coordinator.beginGenesisCapture(localAccountId, sessionId, now)
    try {
    const cut = this.coordinator.captureGenesisCut(localAccountId, now)

    let bundleId: string
    let sessionWasAlreadyActive = false
    this.coordinator.withGenesisBarrier(localAccountId, (session) => {
      if (session.stage === 'ACTIVE') {
        sessionWasAlreadyActive = true
        bundleId = this.findBundleForSession(session.genesisSessionId) ?? ''
        if (!bundleId) throw new Error(`Genesis snapshot is missing for session ${session.genesisSessionId}`)
        this.runtime.transaction(() => {
          const binding = this.runtime.findBinding(localAccountId)
          if (binding) this.runtime.upsertBinding({ ...binding, lifecycleState: 'ACTIVE', genesisSessionId: null, updatedAt: now })
        })
      } else if (session.stage === 'CUT_CAPTURED') {
        const report = this.identityBackfill.backfill(cut.syncSpaceId, localAccountId, now)
        if (report.conflicts.length > 0) {
          throw new Error(`Genesis canonical identity conflicts: ${report.conflicts.length}`)
        }
        bundleId = this.persistSnapshot(localAccountId, cut, session, now)
        return
      }
      const latest = this.runtime.findLatestGenesisSession(cut.syncSpaceId)
      const existingBundle = latest ? this.findBundleForSession(latest.genesisSessionId) : null
      if (!existingBundle) throw new Error(`Genesis snapshot is missing for session ${session.genesisSessionId}`)
      bundleId = existingBundle
    })

    const tailStartedAt = now
    if (!sessionWasAlreadyActive) this.runtime.transaction(() => {
      const session = this.runtime.findGenesisSession(cut.genesisSessionId)
      if (!session) throw new Error(`Genesis session ${cut.genesisSessionId} is missing`)
      if (session.stage !== 'TAIL_REPLAY' && session.stage !== 'ACTIVE') {
        this.runtime.upsertGenesisSession({ ...session, stage: 'TAIL_REPLAY', updatedAt: tailStartedAt })
      }
    })

    let tailOperationsBuilt = 0
    while (!sessionWasAlreadyActive) {
      const built = this.operationBuilder.buildPending(cut.syncSpaceId, 100, now)
      tailOperationsBuilt += built
      if (built === 0) break
    }
    if (!sessionWasAlreadyActive && this.runtime.listPendingOutbox(cut.syncSpaceId, 1).length > 0) {
      throw new Error('Genesis tail replay left pending outbox rows')
    }

    if (!sessionWasAlreadyActive) {
      this.coordinator.completeGenesisActivation(localAccountId, cut.genesisSessionId, now)
    }

    return {
      syncSpaceId: prepared.syncSpaceId,
      genesisSessionId: cut.genesisSessionId,
      genesisBaselineId: cut.genesisBaselineId,
      crossDbCutId: cut.crossDbCutId,
      snapshotBundleId: bundleId!,
      capturedAt: cut.capturedAt,
      tailOperationsBuilt
    }
    } catch (error) {
      this.runtime.transaction(() => {
        const binding = this.runtime.findBinding(localAccountId)
        const failedSessionId = binding?.genesisSessionId
        const session = failedSessionId ? this.runtime.findGenesisSession(failedSessionId) : null
        if (session) {
          this.runtime.upsertGenesisSession({
            ...session,
            stage: 'FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
            updatedAt: now
          })
        }
      })
      throw error
    }
  }

  exportWire(
    snapshotBundleId: string,
    selectedLanes?: ReadonlySet<SyncReplicationLane>
  ): SyncSnapshotBundleWire {
    if (!this.signingKeys) throw new Error('Snapshot signing key store is not configured')
    const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
    if (!bundle) throw new Error('Snapshot bundle not found: ' + snapshotBundleId)
    const session = this.runtime.findGenesisSession(bundle.genesisSessionId)
    if (!session) throw new Error('Genesis session is missing for Snapshot bundle: ' + snapshotBundleId)

    const persistedShards = this.runtime.listSnapshotShards(snapshotBundleId)
    const manifestLanes = new Set<string>(persistedShards.map((shard) => shard.replicationLaneId))
    const effectiveLanes = selectedLanes ? new Set<string>(selectedLanes) : manifestLanes
    for (const lane of effectiveLanes) {
      if (!manifestLanes.has(lane)) throw new Error('Snapshot scope contains an unknown lane: ' + lane)
    }
    for (const lane of ['AUTH', 'CORE_META']) {
      if (!effectiveLanes.has(lane)) throw new Error('Snapshot scope must include required core shard: ' + lane)
    }
    const wireShards: SyncSnapshotShardWire[] = persistedShards
      .filter((shard) => effectiveLanes.has(shard.replicationLaneId))
      .map((shard) => {
      const summary = JSON.parse(shard.deletionGenerationSummaryJson || '{}') as {
        deleted?: unknown
        generations?: unknown
      }
      const wire: SyncSnapshotShardWire = {
        replicationLaneId: shard.replicationLaneId,
        frontierJson: shard.frontierJson,
        entityStateJson: shard.entityStateJson,
        fieldVersionStateJson: shard.fieldVersionStateJson,
        causalMetadataJson: shard.causalMetadataJson,
        genesisCoverageJson: shard.genesisCoverageJson,
        deletionGenerationSummaryJson: shard.deletionGenerationSummaryJson,
        contentHash: '',
        deletionSummaryJson: canonicalJson(JSON.stringify(summary.deleted ?? [])),
        generationSummaryJson: canonicalJson(JSON.stringify(summary.generations ?? {})),
        blobManifestIndexJson: shard.blobManifestIndexJson,
        blobReferenceIndexJson: shard.blobReferenceIndexJson
      }
      return { ...wire, contentHash: snapshotShardContentHash(wire, SNAPSHOT_HASH_SCHEMA_VERSION) }
    })
    const coverage = snapshotCoverageFromShards(wireShards)
    const isScoped = effectiveLanes.size !== manifestLanes.size ||
      [...effectiveLanes].some((lane) => !manifestLanes.has(lane))
    const policyHash = isScoped
      ? sha256Hex(canonicalJson(JSON.stringify({
          basePolicyHash: bundle.policyHash,
          lanes: [...effectiveLanes].sort()
        })))
      : bundle.policyHash
    const wireBundleId = isScoped
      ? `${bundle.snapshotBundleId}:scope:${policyHash.slice(0, 16)}`
      : bundle.snapshotBundleId
    const authorDeviceId = this.runtime.findDeviceIdentity()?.deviceId
    if (!authorDeviceId) throw new Error('Device identity is unavailable for Snapshot signing')
    const unsigned: SyncSnapshotBundleWire = {
      snapshotBundleId: wireBundleId,
      syncSpaceId: bundle.syncSpaceId,
      snapshotClass: bundle.snapshotClass,
      genesisBaselineId: bundle.genesisBaselineId,
      rootHash: '',
      policyHash,
      capturedAt: bundle.capturedAt,
      shards: wireShards,
      coverage,
      hashSchemaVersion: SNAPSHOT_HASH_SCHEMA_VERSION,
      schemaVersion: 1,
      snapshotEpoch: 1,
      crossDbCutId: session.crossDbCutId,
      requiredCoreShardIds: ['AUTH', 'CORE_META'],
      coverageCommitment: bundle.snapshotClass === 'BOOTSTRAP_RECOVERY'
        ? snapshotCoverageCommitment(coverage)
        : null,
      authStabilityCheckpoint: bundle.authStabilityCheckpointId ?? null,
      authorDeviceId,
      authorSignature: null
    }
    const withRoot = { ...unsigned, rootHash: snapshotRootHash(unsigned) }
    return {
      ...withRoot,
      authorSignature: this.signingKeys.signBase64(authorDeviceId, snapshotSigningMaterial(withRoot))
    }
  }

  /**
   * Merge an already-verified remote baseline with a fresh local recovery Snapshot.
   *
   * This is used only after the normal installer refused a destructive rebase because the
   * remote baseline is behind locally compacted stable history. The caller therefore supplies
   * a target Snapshot that already passed the ordinary signature/hash/stability checks.
   */
  mergeRecoverySnapshot(
    localSnapshotBundleId: string,
    target: SyncSnapshotBundleWire,
    selectedLanes: ReadonlySet<SyncReplicationLane>,
    now = Date.now()
  ): SyncSnapshotBundleWire {
    const baseBundle = this.runtime.findSnapshotBundle(localSnapshotBundleId)
    if (!baseBundle) throw new Error('Local recovery Snapshot bundle not found: ' + localSnapshotBundleId)
    const session = this.runtime.findGenesisSession(baseBundle.genesisSessionId)
    if (!session) throw new Error('Genesis session is missing for recovery Snapshot merge')
    if (target.syncSpaceId !== baseBundle.syncSpaceId) {
      throw new Error('REBASE_UNSAFE: cannot merge Snapshots from different Sync Spaces')
    }

    const local = this.exportWire(localSnapshotBundleId, selectedLanes)
    const selectedLaneNames = new Set<string>(selectedLanes)
    const targetCoverage = Object.fromEntries(
      Object.entries(target.coverage).filter(([lane]) => selectedLaneNames.has(lane))
    ) as SyncCoverage
    const localByLane = new Map(local.shards.map((shard) => [shard.replicationLaneId, shard]))
    const targetByLane = new Map(target.shards.map((shard) => [shard.replicationLaneId, shard]))
    const lanes = [...selectedLanes].sort()
    const mergedShards = lanes.map((lane) => {
      const localShard = localByLane.get(lane)
      const targetShard = targetByLane.get(lane)
      if (!localShard || !targetShard) {
        throw new Error('REBASE_UNSAFE: causal Snapshot merge requires both sides of lane ' + lane)
      }
      return this.mergeRecoveryShard(
        lane as SyncReplicationLane,
        localShard,
        targetShard,
        local.genesisBaselineId ?? baseBundle.genesisBaselineId,
        target.genesisBaselineId ?? 'remote-legacy-baseline',
        local.coverage[lane] ?? {},
        targetCoverage[lane] ?? {},
        now
      )
    })
    const coverage = snapshotCoverageFromShards(mergedShards)
    if (!coverageDominates(coverage, local.coverage) || !coverageDominates(coverage, targetCoverage)) {
      throw new Error('REBASE_UNSAFE: merged recovery Snapshot does not dominate both inputs')
    }

    const mergeStamp = sha256Hex(canonicalJson(JSON.stringify({
      localRootHash: local.rootHash,
      targetRootHash: target.rootHash,
      lanes
    }))).slice(0, 24)
    const bundleId = `${baseBundle.snapshotBundleId}:merge:${mergeStamp}`
    const requiredCoreShardIds = ['AUTH', 'CORE_META']
    const unsigned: SyncSnapshotBundleWire = {
      snapshotBundleId: bundleId,
      syncSpaceId: baseBundle.syncSpaceId,
      snapshotClass: 'WORKING',
      genesisBaselineId: baseBundle.genesisBaselineId,
      rootHash: '',
      policyHash: local.policyHash,
      capturedAt: now,
      shards: mergedShards,
      coverage,
      hashSchemaVersion: SNAPSHOT_HASH_SCHEMA_VERSION,
      schemaVersion: 1,
      snapshotEpoch: 1,
      crossDbCutId: session.crossDbCutId,
      requiredCoreShardIds,
      coverageCommitment: null,
      authStabilityCheckpoint: null,
      authorDeviceId: null,
      authorSignature: null
    }
    const rootHash = snapshotRootHash(unsigned)
    const shardRecords: SyncSnapshotShardRecord[] = mergedShards.map((shard) => ({
      snapshotBundleId: bundleId,
      syncSpaceId: baseBundle.syncSpaceId,
      replicationLaneId: shard.replicationLaneId as SyncReplicationLane,
      frontierJson: shard.frontierJson,
      entityStateJson: shard.entityStateJson,
      fieldVersionStateJson: shard.fieldVersionStateJson,
      causalMetadataJson: shard.causalMetadataJson,
      genesisCoverageJson: shard.genesisCoverageJson,
      deletionGenerationSummaryJson: stableJson({
        schemaVersion: 1,
        deleted: parseJsonArray(shard.deletionSummaryJson),
        generations: parseJsonObject(shard.generationSummaryJson)
      }),
      blobManifestIndexJson: shard.blobManifestIndexJson ?? '[]',
      blobReferenceIndexJson: shard.blobReferenceIndexJson ?? '[]',
      contentHash: shard.contentHash,
      createdAt: now
    }))

    this.runtime.transaction(() => {
      this.runtime.upsertSnapshotBundle({
        snapshotBundleId: bundleId,
        syncSpaceId: baseBundle.syncSpaceId,
        genesisSessionId: baseBundle.genesisSessionId,
        genesisBaselineId: baseBundle.genesisBaselineId,
        snapshotClass: 'WORKING',
        authStabilityCheckpointId: null,
        rootHash,
        policyHash: local.policyHash,
        capturedAt: now,
        createdAt: now
      })
      for (const shard of shardRecords) this.runtime.upsertSnapshotShard(shard)
    })
    return this.exportWire(bundleId, selectedLanes)
  }

  private mergeRecoveryShard(
    lane: SyncReplicationLane,
    local: SyncSnapshotShardWire,
    target: SyncSnapshotShardWire,
    localBaselineId: string,
    targetBaselineId: string,
    localFrontier: Record<string, number>,
    targetFrontier: Record<string, number>,
    now: number
  ): SyncSnapshotShardWire {
    const generations = mergeGenerationMaps(
      snapshotGenerationMap(local),
      snapshotGenerationMap(target)
    )
    const tombstones = mergeSnapshotTombstones(
      snapshotTombstones(local, now),
      snapshotTombstones(target, now)
    )

    let entities: GenesisEntity[]
    let fieldVersions: GenesisFieldVersionSnapshot[]
    if (lane === 'AUTH') {
      // Never re-sign peer-supplied AUTH objects merely because a business Snapshot is being
      // merged. AUTH objects must first enter the verified local ledger through normal AUTH
      // exchange; the fresh local recovery shard is therefore the only AUTH state we publish.
      entities = normalizeSnapshotEntities(local, lane)
      fieldVersions = []
    } else if (lane === 'CORE_META') {
      // CORE_META contains device-local capture metadata on Desktop and historical mapping
      // metadata on Android. Business entity/generation state is merged from the owning lanes,
      // so never let a peer's local device identity overwrite this device's CORE_META row.
      entities = normalizeSnapshotEntities(local, lane)
      fieldVersions = normalizeSnapshotFieldVersions(
        local,
        entities,
        localBaselineId,
        lane
      )
    } else {
      const merged = mergeSnapshotBusinessState(
        lane,
        normalizeSnapshotEntities(local, lane),
        normalizeSnapshotEntities(target, lane),
        normalizeSnapshotFieldVersions(local, normalizeSnapshotEntities(local, lane), localBaselineId, lane),
        normalizeSnapshotFieldVersions(target, normalizeSnapshotEntities(target, lane), targetBaselineId, lane),
        localBaselineId,
        targetBaselineId,
        tombstones
      )
      entities = merged.entities
      fieldVersions = merged.fieldVersions
    }

    for (const entity of entities) {
      const key = snapshotEntityKey(entity.entityType, entity.entitySyncId)
      generations[key] = Math.max(generations[key] ?? 0, entity.generation)
    }
    for (const tombstone of tombstones) {
      const key = snapshotEntityKey(tombstone.entityType, tombstone.entitySyncId)
      generations[key] = Math.max(generations[key] ?? 0, tombstone.generation)
    }

    const entityStateJson = stableJson({ schemaVersion: 1, lane, entities: sortSnapshotEntities(entities) })
    const fieldVersionStateJson = stableJson(sortSnapshotFieldVersions(fieldVersions))
    const frontierJson = encodeGenesisFrontiers({
      [lane]: mergeActorFrontiers(localFrontier, targetFrontier)
    })
    const causalMetadataJson = mergeSnapshotCausalMetadata(local, target, now)
    const genesisCoverageJson = stableJson({
      schemaVersion: 2,
      genesisBaselines: [...new Set([localBaselineId, targetBaselineId])].sort(),
      entityCount: entities.length
    })
    const deletionSummaryJson = stableJson(
      [...tombstones].sort(compareSnapshotTombstones)
    )
    const generationSummaryJson = stableJson(
      Object.fromEntries(Object.entries(generations).sort(([a], [b]) => a.localeCompare(b)))
    )
    const blobIndexes = mergeSnapshotBlobIndexes(local, target, entities, tombstones)
    const deletionGenerationSummaryJson = stableJson({
      schemaVersion: 1,
      deleted: JSON.parse(deletionSummaryJson),
      generations: JSON.parse(generationSummaryJson)
    })
    const merged: SyncSnapshotShardWire = {
      replicationLaneId: lane,
      frontierJson,
      entityStateJson,
      fieldVersionStateJson,
      causalMetadataJson,
      genesisCoverageJson,
      deletionGenerationSummaryJson,
      contentHash: '',
      deletionSummaryJson,
      generationSummaryJson,
      blobManifestIndexJson: blobIndexes.manifestIndexJson,
      blobReferenceIndexJson: blobIndexes.referenceIndexJson
    }
    return {
      ...merged,
      contentHash: snapshotShardContentHash(merged, SNAPSHOT_HASH_SCHEMA_VERSION)
    }
  }

  promoteToGcBaseline(
    snapshotBundleId: string,
    checkpointId: string,
    now = Date.now(),
    selectedLanes?: ReadonlySet<SyncReplicationLane>
  ): SyncSnapshotBundleWire {
    if (!checkpointId.trim()) throw new Error('GC_BASELINE requires AuthStabilityCheckpoint')
    const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
    if (!bundle) throw new Error('Snapshot bundle not found: ' + snapshotBundleId)
    if (bundle.snapshotClass !== 'WORKING' && bundle.snapshotClass !== 'GC_BASELINE') {
      throw new Error('Only WORKING Snapshot can be promoted to GC_BASELINE')
    }

    const authHistory = this.runtime.listAuthObjects(bundle.syncSpaceId)
    const latestCheckpoint = [...authHistory].reverse()
      .find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')
    if (!latestCheckpoint || latestCheckpoint.authObjectId !== checkpointId) {
      throw new Error('GC_BASELINE must reference the current AuthStabilityCheckpoint')
    }
    const payload = JSON.parse(latestCheckpoint.payloadJson) as Record<string, unknown>
    const acceptedRaw = payload.acceptedPrefixByActorLane
    if (!acceptedRaw || typeof acceptedRaw !== 'object' || Array.isArray(acceptedRaw)) {
      throw new Error('AuthStabilityCheckpoint has no acceptedPrefixByActorLane')
    }

    const currentWire = this.exportWire(snapshotBundleId, selectedLanes)
    const accepted = acceptedRaw as SyncCoverage
    if (!coverageDominates(accepted, currentWire.coverage)) {
      throw new Error('GC_BASELINE Snapshot exceeds stable authorized coverage')
    }
    for (const [lane, actors] of Object.entries(currentWire.coverage)) {
      for (const [actor, prefix] of Object.entries(actors)) {
        const provisional = this.database.prepare(`
          SELECT 1 FROM sync_inbox_operation
          WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
            AND sequence<=? AND state='APPLIED'
            AND authorization_state='PROVISIONAL_AUTHORIZED'
          LIMIT 1
        `).get(bundle.syncSpaceId, lane, actor, prefix)
        if (provisional) {
          throw new Error(`GC_BASELINE contains provisional effect at ${lane}/${actor}<=${prefix}`)
        }
      }
    }

    return this.promoteSnapshotVariant(bundle, currentWire, 'GC_BASELINE', checkpointId, now)
  }

  promoteToBootstrapRecovery(
    snapshotBundleId: string,
    checkpointId: string,
    now = Date.now(),
    selectedLanes?: ReadonlySet<SyncReplicationLane>
  ): SyncSnapshotBundleWire {
    if (!checkpointId.trim()) throw new Error('BOOTSTRAP_RECOVERY requires AuthStabilityCheckpoint')
    const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
    if (!bundle) throw new Error('Snapshot bundle not found: ' + snapshotBundleId)
    if (bundle.snapshotClass !== 'WORKING' && bundle.snapshotClass !== 'BOOTSTRAP_RECOVERY') {
      throw new Error('Only WORKING Snapshot can be promoted to BOOTSTRAP_RECOVERY')
    }
    const checkpoint = [...this.runtime.listAuthObjects(bundle.syncSpaceId)].reverse()
      .find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')
    if (!checkpoint || checkpoint.authObjectId !== checkpointId) {
      throw new Error('BOOTSTRAP_RECOVERY must reference the current AuthStabilityCheckpoint')
    }
    const payload = JSON.parse(checkpoint.payloadJson) as Record<string, unknown>
    const currentWire = this.exportWire(snapshotBundleId, selectedLanes)
    if (payload.acceptedSnapshotBundleId !== currentWire.snapshotBundleId) {
      throw new Error('Recovery checkpoint does not accept Snapshot ' + currentWire.snapshotBundleId)
    }
    const accepted = payload.acceptedPrefixByActorLane
    if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
      throw new Error('AuthStabilityCheckpoint has no acceptedPrefixByActorLane')
    }
    if (!coverageDominates(accepted as SyncCoverage, currentWire.coverage)) {
      throw new Error('BOOTSTRAP_RECOVERY Snapshot exceeds stable authorized coverage')
    }
    return this.promoteSnapshotVariant(bundle, currentWire, 'BOOTSTRAP_RECOVERY', checkpointId, now)
  }

  private promoteSnapshotVariant(
    baseBundle: SyncSnapshotBundleRecord,
    currentWire: SyncSnapshotBundleWire,
    snapshotClass: 'GC_BASELINE' | 'BOOTSTRAP_RECOVERY',
    checkpointId: string,
    now: number
  ): SyncSnapshotBundleWire {
    const selectedLanes = new Set(currentWire.shards.map((shard) => shard.replicationLaneId))
    const baseShards = this.runtime.listSnapshotShards(baseBundle.snapshotBundleId)
      .filter((shard) => selectedLanes.has(shard.replicationLaneId))
    const promotedBundle: SyncSnapshotBundleRecord = {
      ...baseBundle,
      snapshotBundleId: currentWire.snapshotBundleId,
      snapshotClass,
      policyHash: currentWire.policyHash,
      rootHash: currentWire.rootHash,
      authStabilityCheckpointId: checkpointId,
      createdAt: now
    }
    this.runtime.transaction(() => {
      this.runtime.upsertSnapshotBundle(promotedBundle)
      for (const shard of baseShards) {
        this.runtime.upsertSnapshotShard({
          ...shard,
          snapshotBundleId: currentWire.snapshotBundleId
        })
      }
    })
    return this.exportWire(currentWire.snapshotBundleId)
  }

  private persistSnapshot(
    localAccountId: number,
    cut: DesktopGenesisCut,
    session: SyncGenesisSessionRecord,
    now: number
  ): string {
    const lanePayloads = this.buildLanePayloads(localAccountId, cut)
    const policyHash = sha256Hex(canonicalJson(JSON.stringify({
      defaultPolicy: 'DETERMINISTIC',
      fieldPolicies: { isStarred: 'STARRED_WINS', isUnread: 'READ_WINS' },
      lanes: PHASE_A_LANES
    })))
    const bundleId = `snapshot:${cut.genesisBaselineId}`
    const shards = PHASE_A_LANES.map((lane) => this.toShard(bundleId, cut, lane, lanePayloads[lane]!, now))
    const requiredCoreShardIds = ['AUTH', 'CORE_META']
    const persistedWireShards: SyncSnapshotShardWire[] = shards.map((shard) => {
      const summary = JSON.parse(shard.deletionGenerationSummaryJson) as { deleted?: unknown; generations?: unknown }
      return {
        replicationLaneId: shard.replicationLaneId,
        frontierJson: shard.frontierJson,
        entityStateJson: shard.entityStateJson,
        fieldVersionStateJson: shard.fieldVersionStateJson,
        causalMetadataJson: shard.causalMetadataJson,
        genesisCoverageJson: shard.genesisCoverageJson,
        deletionGenerationSummaryJson: shard.deletionGenerationSummaryJson,
        contentHash: shard.contentHash,
        deletionSummaryJson: canonicalJson(JSON.stringify(summary.deleted ?? [])),
        generationSummaryJson: canonicalJson(JSON.stringify(summary.generations ?? {})),
        blobManifestIndexJson: shard.blobManifestIndexJson,
        blobReferenceIndexJson: shard.blobReferenceIndexJson
      }
    })
    const persistedCoverage = snapshotCoverageFromShards(persistedWireShards)
    const rootHash = snapshotRootHash({
      snapshotBundleId: bundleId,
      syncSpaceId: cut.syncSpaceId,
      snapshotClass: 'WORKING',
      genesisBaselineId: cut.genesisBaselineId,
      rootHash: '',
      policyHash,
      capturedAt: cut.capturedAt,
      shards: persistedWireShards,
      coverage: persistedCoverage,
      hashSchemaVersion: SNAPSHOT_HASH_SCHEMA_VERSION,
      schemaVersion: 1,
      snapshotEpoch: 1,
      crossDbCutId: cut.crossDbCutId,
      requiredCoreShardIds,
      coverageCommitment: null,
      authStabilityCheckpoint: null,
      authorDeviceId: null,
      authorSignature: null
    })

    this.runtime.transaction(() => {
      this.runtime.upsertSnapshotBundle({
        snapshotBundleId: bundleId,
        syncSpaceId: cut.syncSpaceId,
        genesisSessionId: session.genesisSessionId,
        genesisBaselineId: cut.genesisBaselineId,
        snapshotClass: 'WORKING',
        rootHash,
        policyHash,
        capturedAt: cut.capturedAt,
        createdAt: now
      })
      for (const shard of shards) this.runtime.upsertSnapshotShard(shard)
      this.markCutOutboxIncluded(cut, now)
      this.runtime.upsertGenesisSession({ ...session, stage: 'SNAPSHOT_BUILT', capturedAt: cut.capturedAt, updatedAt: now })
    })
    return bundleId
  }

  private buildLanePayloads(localAccountId: number, cut: DesktopGenesisCut): Record<SyncReplicationLane, LanePayload> {
    const state = new SyncStateRepository(this.database)
    for (const operation of this.runtime.listAllOperationsForRecovery(cut.syncSpaceId)) {
      const inbox = state.findInbox(operation.operationId)
      if (inbox?.state !== 'APPLIED') continue
      const frontier = cut.laneFrontiers[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0
      if (operation.sequence > frontier) {
        throw new Error(
          'REBASE_UNSAFE: Snapshot materialized state contains applied Operation ' +
          operation.replicationLaneId + '/' + operation.actorIncarnationId + '/' + operation.sequence +
          ' beyond declared cut frontier ' + frontier
        )
      }
    }
    const payloads = Object.fromEntries(
      SYNC_REPLICATION_LANES.map((lane) => [lane, { entities: [], fieldVersions: [] }])
    ) as unknown as Record<SyncReplicationLane, LanePayload>

    const snapshotFieldVersion = (
      lane: SyncReplicationLane,
      entityType: string,
      entitySyncId: string,
      entityGeneration: number,
      fieldId: string,
      value: unknown
    ): GenesisFieldVersionSnapshot => {
      const valueJson = canonicalJson(JSON.stringify(value))
      const current = state.findFieldVersion(cut.syncSpaceId, entityType, entitySyncId, fieldId)
      let causalContextJson = current?.causalContextJson ?? null
      let logicalClock = current?.logicalClock ?? null

      if (current && (!causalContextJson || logicalClock == null) && current.sourceOperationId) {
        const retained = this.database.prepare(
          'SELECT causal_context_json,logical_clock FROM sync_operation_log WHERE operation_id=? LIMIT 1'
        ).get(current.sourceOperationId) as { causal_context_json: string; logical_clock: number } | undefined
        causalContextJson = retained?.causal_context_json ?? causalContextJson
        logicalClock = retained?.logical_clock ?? logicalClock
      }
      if (current && (!causalContextJson || logicalClock == null)) {
        const dot = parseOperationVersionToken(current.versionToken)
        if (dot) {
          const pending = this.database.prepare(`
            SELECT causal_context_json,sequence AS logical_clock
            FROM sync_outbox
            WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=? AND sequence=?
            LIMIT 1
          `).get(
            cut.syncSpaceId,
            dot.actorIncarnationId,
            dot.replicationLaneId,
            dot.sequence
          ) as { causal_context_json: string; logical_clock: number } | undefined
          causalContextJson = pending?.causal_context_json ?? causalContextJson
          logicalClock = pending?.logical_clock ?? logicalClock
        }
      }

      let source: 'GENESIS' | 'OPERATION' | null = null
      if (current) {
        try { source = SyncVersionToken.source(current.versionToken) } catch { source = null }
      }
      const reusable = current &&
        current.entityGeneration === entityGeneration &&
        canonicalJson(current.valueJson) === valueJson &&
        (source === 'GENESIS' || (source === 'OPERATION' && causalContextJson != null && logicalClock != null))

      return {
        entityType,
        entitySyncId,
        entityGeneration,
        fieldId,
        valueJson,
        versionToken: reusable
          ? current.versionToken
          : SyncVersionToken.genesis(cut.genesisBaselineId, lane, entitySyncId, fieldId),
        causalContextJson: reusable ? causalContextJson : null,
        logicalClock: reusable ? logicalClock : null
      }
    }

    const add = (lane: SyncReplicationLane, entityType: string, localId: string, fields: Record<string, unknown>): void => {
      const mapping = this.identities.findByLocalId(cut.syncSpaceId, entityType as Parameters<SyncIdentityRepository['findByLocalId']>[1], localId)
      if (!mapping) throw new Error(`Missing Genesis mapping for ${entityType}/${localId}`)
      const entity: GenesisEntity = {
        entityType,
        entitySyncId: mapping.syncId,
        generation: mapping.generation,
        fields
      }
      payloads[lane]!.entities.push(entity)
      for (const [fieldId, value] of Object.entries(fields)) {
        payloads[lane]!.fieldVersions.push(
          snapshotFieldVersion(
            lane,
            entityType,
            mapping.syncId,
            mapping.generation,
            fieldId,
            value
          )
        )
      }
    }
    const addAi = (entityType: string, localId: string, payloadJson: string): void => {
      const resolvedJson = resolveLlmSyncPayloadReferences(this.identities, cut.syncSpaceId, payloadJson)
      const mapping = this.identities.findByLocalId(
        cut.syncSpaceId,
        entityType as Parameters<SyncIdentityRepository['findByLocalId']>[1],
        localId
      )
      if (!mapping) throw new Error(`Missing Genesis mapping for ${entityType}/${localId}`)
      const blobRefs = syncPayloadBlobRefs(resolvedJson)
      if (blobRefs.length && !this.localBlobStore) {
        throw new Error('AI_HISTORY Genesis requires the local Blob store')
      }
      for (const ref of blobRefs) {
        const bytes = this.localBlobStore!.readVerified(ref.manifest.hash)
        if (!bytes || bytes.byteLength !== ref.manifest.totalBytes) {
          throw new Error(`Genesis AI_HISTORY Blob is missing or invalid: ${ref.manifest.hash}`)
        }
        this.blobState.registerManifest(ref.manifest, 'READY', cut.capturedAt)
        this.blobState.markReadyVerified(ref.manifest.hash, bytes.byteLength, cut.capturedAt)
        this.blobState.replaceOwnerReference(
          cut.syncSpaceId,
          'AI_HISTORY',
          entityType,
          mapping.syncId,
          mapping.generation,
          ref.referenceKind,
          ref.manifest.hash,
          cut.capturedAt
        )
      }
      add('AI_HISTORY', entityType, localId, JSON.parse(resolvedJson) as Record<string, unknown>)
    }

    const groups = this.database.prepare(`
      SELECT id,name FROM groups WHERE account_id=? ORDER BY id
    `).all(localAccountId) as unknown as Row[]
    for (const row of groups) add('LIBRARY', 'group', String(row.id), {
      name: String(row.name)
    })

    const feeds = this.database.prepare(`
      SELECT id,group_id,name,url,source_type,icon,is_notification,is_full_content,is_browser
      FROM feeds WHERE account_id=? ORDER BY id
    `).all(localAccountId) as unknown as Row[]
    for (const row of feeds) {
      const groupMapping = this.identities.findByLocalId(cut.syncSpaceId, 'group', String(row.group_id))
      const groupSyncId = groupMapping?.syncId ?? null
      add('LIBRARY', 'feed', String(row.id), {
        groupSyncId, groupGeneration: groupMapping?.generation ?? null, name: String(row.name), url: String(row.url),
        sourceType: String(row.source_type), icon: row.icon == null ? null : String(row.icon),
        isNotification: Number(row.is_notification) === 1, isFullContent: Number(row.is_full_content) === 1,
        isBrowser: Number(row.is_browser) === 1
      })
    }

    const articles = this.database.prepare(`
      SELECT id,feed_id,title,url,author,published_at,description,content_html,full_content_html,image_url,
             is_unread,is_starred,is_read_later,created_at,updated_at
      FROM articles WHERE account_id=? ORDER BY id
    `).all(localAccountId) as unknown as Row[]
    for (const row of articles) {
      const localArticleId = String(row.id)
      const articleMapping = this.identities.findByLocalId(cut.syncSpaceId, 'article', localArticleId)
      if (!articleMapping) throw new Error(`Missing Genesis mapping for article/${localArticleId}`)
      const feedMapping = this.identities.findByLocalId(cut.syncSpaceId, 'feed', String(row.feed_id))
      const feedSyncId = feedMapping?.syncId ?? null
      const inlineFullContent = row.full_content_html == null ? null : String(row.full_content_html)
      let fullContentHash = (this.database.prepare(`
        SELECT hash FROM sync_blob_reference
        WHERE sync_space_id=? AND replication_lane_id='ARTICLE_STATE'
          AND owner_entity_type='article' AND owner_entity_sync_id=? AND owner_entity_generation=?
          AND reference_kind=?
        ORDER BY created_at DESC LIMIT 1
      `).get(
        cut.syncSpaceId,
        articleMapping.syncId,
        articleMapping.generation,
        SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
      ) as { hash: string } | undefined)?.hash ?? null

      if (inlineFullContent?.trim()) {
        const blobStore = this.requireBlobStore()
        const reference = articleFullContentBlobRef(inlineFullContent)
        blobStore.putUtf8Text(reference, inlineFullContent)
        this.blobState.registerManifest(reference.manifest, 'READY', cut.capturedAt)
        this.blobState.markReadyVerified(reference.manifest.hash, reference.manifest.totalBytes, cut.capturedAt)
        this.blobState.replaceOwnerReference(
          cut.syncSpaceId,
          'ARTICLE_STATE',
          'article',
          articleMapping.syncId,
          articleMapping.generation,
          reference.referenceKind,
          reference.manifest.hash,
          cut.capturedAt
        )
        fullContentHash = reference.manifest.hash
      }

      add('ARTICLE_STATE', 'article', localArticleId, {
        feedSyncId, feedGeneration: feedMapping?.generation ?? null,
        title: String(row.title), url: row.url == null ? null : String(row.url),
        author: row.author == null ? null : String(row.author), publishedAt: row.published_at == null ? null : Number(row.published_at),
        description: String(row.description), contentHtml: row.content_html == null ? null : String(row.content_html),
        fullContentHash,
        imageUrl: row.image_url == null ? null : String(row.image_url), isUnread: Number(row.is_unread) === 1,
        isStarred: Number(row.is_starred) === 1, isReadLater: Number(row.is_read_later) === 1
      })
      payloads.ARTICLE_STATE!.fieldVersions = payloads.ARTICLE_STATE!.fieldVersions.filter((version) =>
        !(version.entityType === 'article' &&
          version.entitySyncId === articleMapping.syncId &&
          version.fieldId === 'fullContentHash')
      )
      if (fullContentHash) {
        payloads.ARTICLE_STATE!.fieldVersions.push(
          snapshotFieldVersion(
            'ARTICLE_STATE',
            'article',
            articleMapping.syncId,
            articleMapping.generation,
            SYNC_ARTICLE_FULL_CONTENT_FIELD,
            fullContentHash
          )
        )
      }
    }

    for (const rule of this.articleFilters.getAll()) {
      let feedSyncId: string | null = null
      let feedGeneration: number | null = null
      if (rule.feedId) {
        const feedMapping = this.identities.findByLocalId(cut.syncSpaceId, 'feed', rule.feedId)
          ?? this.identities.findBySyncId(cut.syncSpaceId, 'feed', rule.feedId)
        if (!feedMapping) {
          throw new Error(
            'Filter rule ' + rule.id + ' references an unmapped feed ' + rule.feedId
          )
        }
        feedSyncId = feedMapping.syncId
        feedGeneration = feedMapping.generation
      }
      add('CONFIG', 'filter_rule', rule.id, {
        keyword: rule.keyword, feedSyncId, feedGeneration, feedName: rule.feedName, type: rule.type, enabled: rule.enabled
      })
    }
    for (const rule of this.websiteRules?.listSyncRules() ?? []) {
      add('CONFIG', 'website_rule', rule.id, { rule })
    }
    for (const rule of this.jsonRules?.listSyncRules() ?? []) {
      add('CONFIG', 'json_rule', rule.id, { rule })
    }
    if (this.rssHubSettings) {
      add('CONFIG', 'rsshub_settings', 'rsshub-settings', { settings: this.rssHubSettings.current() })
    }
    if (this.websiteParsePreferences) {
      const feedIds = new Set(feeds.map((row) => String(row.id)))
      for (const [localFeedId, preference] of this.websiteParsePreferences.listUserSyncStates(feedIds)) {
        const feedMapping = this.identities.findByLocalId(cut.syncSpaceId, 'feed', localFeedId)
        if (!feedMapping) {
          throw new Error('Website parse preference references an unmapped feed ' + localFeedId)
        }
        add('CONFIG', 'website_parse_preference', feedMapping.syncId, {
          preference: {
            feedSyncId: feedMapping.syncId,
            feedGeneration: feedMapping.generation,
            dynamicRenderingEnabled: preference.dynamicRenderingEnabled,
            preferredRuleId: preference.preferredRuleId,
            preferredRuleName: preference.preferredRuleName
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
    `).all(localAccountId) as unknown as Array<{ feed_id: string; source_url: string }>
    for (const row of rssHubSubscriptionSources) {
      const feedMapping = this.identities.findByLocalId(cut.syncSpaceId, 'feed', row.feed_id)
      if (!feedMapping) {
        throw new Error('RSSHub subscription source references an unmapped feed ' + row.feed_id)
      }
      add('CONFIG', 'rsshub_subscription_source', feedMapping.syncId, {
        source: {
          feedSyncId: feedMapping.syncId,
          feedGeneration: feedMapping.generation,
          sourceUrl: row.source_url
        }
      })
    }

    const llm = new LlmChatRepository(this.database)
    for (const conversation of llm.listConversations()) {
      addAi('conversation', conversation.id, conversationSyncPayload(conversation))
      for (const relation of llm.getConversationArticles(conversation.id)) {
        addAi(
          'conversation_article',
          relationLocalId('conversation_article', relation.conversationId, relation.articleId),
          conversationArticleSyncPayload(relation, this.requireBlobStore())
        )
      }

      const stableMessages = llm.getMessages(conversation.id, false).filter((message) => message.status !== 'STREAMING')
      const stableMessageIds = new Set(stableMessages.map((message) => message.id))
      const stableAssistantIds = new Set(
        stableMessages.filter((message) => message.role === 'ASSISTANT').map((message) => message.id)
      )
      for (const message of stableMessages) {
        addAi('message', message.id, messageSyncPayload(message))
      }
      for (const toolCall of llm.getToolCalls(conversation.id)) {
        if (!stableAssistantIds.has(toolCall.assistantMessageId)) continue
        if (!['COMPLETE', 'DENIED', 'ERROR'].includes(toolCall.status)) continue
        addAi('tool_call', toolCall.id, toolCallSyncPayload(toolCall, this.requireBlobStore()))
      }
      for (const assistantId of stableAssistantIds) {
        const contextRefs = llm.getContextRefsForAssistant(assistantId)
        for (const contextRef of contextRefs) {
          addAi('context_ref', contextRef.id, contextRefSyncPayload(contextRef, this.requireBlobStore()))
          for (const evidence of llm.getEvidenceBlocks(contextRef.id)) {
            addAi('evidence_block', evidence.id, evidenceBlockSyncPayload(evidence, this.requireBlobStore()))
          }
        }
        for (const citation of llm.getCitationRefsForAssistant(assistantId)) {
          addAi('citation_ref', citation.id, citationRefSyncPayload(citation, this.requireBlobStore()))
        }
        const annotations = llm.getCitationAnnotationsForAssistant(assistantId)
        const annotationIds = new Set(annotations.map((annotation) => annotation.id))
        for (const annotation of annotations) {
          addAi('citation_annotation', annotation.id, citationAnnotationSyncPayload(annotation))
        }
        for (const relation of llm.getCitationAnnotationRefsForAssistant(assistantId)) {
          if (!annotationIds.has(relation.annotationId)) continue
          addAi(
            'citation_annotation_ref',
            relationLocalId('citation_annotation_ref', relation.annotationId, relation.citationRefId),
            citationAnnotationRefSyncPayload(relation)
          )
        }
      }
      void stableMessageIds
    }
    payloads.AI_HISTORY!.entities.sort((a, b) =>
      a.entityType.localeCompare(b.entityType) || a.entitySyncId.localeCompare(b.entitySyncId)
    )

    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    const coreFields = {
      localAccountId,
      syncSpaceId: cut.syncSpaceId,
      lifecycleState: binding?.lifecycleState ?? 'GENESIS_CAPTURING',
      deviceId: device?.deviceId ?? null,
      witnessId: device?.witnessId ?? null
    }
    const coreMappingId = `${cut.syncSpaceId}:core`
    const coreEntity = { entityType: 'sync_core', entitySyncId: coreMappingId, generation: 0, fields: coreFields }
    payloads.CORE_META!.entities.push(coreEntity)
    for (const [fieldId, value] of Object.entries(coreFields)) {
      payloads.CORE_META!.fieldVersions.push(
        snapshotFieldVersion('CORE_META', 'sync_core', coreMappingId, 0, fieldId, value)
      )
    }
    const authObjects = this.runtime.listAuthObjects(cut.syncSpaceId)
    if (!authObjects.some((object) => object.objectType === 'SPACE_ROOT')) {
      throw new Error('Genesis AUTH shard requires a verified SPACE_ROOT')
    }
    payloads.AUTH!.entities.push({
      entityType: 'auth_ledger',
      entitySyncId: `${cut.syncSpaceId}:auth`,
      generation: Math.max(...authObjects.map((object) => object.authEpoch)),
      fields: { objects: authObjects }
    })
    // Capture every historical field candidate, including concurrent losers, before log GC.
    for (const operation of this.runtime.listAllOperationsForRecovery(cut.syncSpaceId)) {
      const inbox = state.findInbox(operation.operationId)
      if (operation.buildStatus === 'REJECTED' || (inbox && inbox.state !== 'APPLIED')) continue
      const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>
      const fields = operation.operationType === 'FIELD_SET' ? { [String(payload.field)]: payload.value }
        : ['UPSERT', 'RELATION_SET'].includes(operation.operationType) ? (payload.fields ?? payload) as Record<string, unknown> : {}
      for (const [fieldId, value] of Object.entries(fields)) {
        state.retainFieldCandidate({ syncSpaceId: cut.syncSpaceId, entityType: operation.entityType,
          entitySyncId: operation.entitySyncId, entityGeneration: operation.entityGeneration, fieldId,
          versionToken: SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence),
          valueJson: canonicalJson(JSON.stringify(value)), sourceOperationId: operation.operationId,
          causalContextJson: operation.causalContextJson, logicalClock: operation.logicalClock, updatedAt: cut.capturedAt })
      }
    }
    const retainedCandidates = state.listFieldCandidates(cut.syncSpaceId)
    for (const payload of Object.values(payloads)) {
      const versions = payload.fieldVersions.flatMap((winner) => [winner, ...retainedCandidates.filter((row) =>
        row.entityType === winner.entityType && row.entitySyncId === winner.entitySyncId &&
        row.entityGeneration === winner.entityGeneration && row.fieldId === winner.fieldId
      ).map((row) => ({ entityType: row.entityType, entitySyncId: row.entitySyncId,
        entityGeneration: row.entityGeneration, fieldId: row.fieldId, versionToken: row.versionToken,
        valueJson: row.valueJson, causalContextJson: row.causalContextJson ?? null, logicalClock: row.logicalClock ?? null }))])
      payload.fieldVersions = sortSnapshotFieldVersions([...new Map(versions.map((row) =>
        [JSON.stringify([row.entityType,row.entitySyncId,row.entityGeneration,row.fieldId,row.versionToken]),row])).values()])
    }
    return payloads
  }

  private requireBlobStore(): DesktopSyncLocalBlobStore {
    if (!this.localBlobStore) throw new Error('AI_HISTORY Genesis requires the local Blob store')
    return this.localBlobStore
  }

  private toShard(
    bundleId: string,
    cut: DesktopGenesisCut,
    lane: SyncReplicationLane,
    payload: LanePayload,
    now: number
  ): SyncSnapshotShardRecord {
    const entityStateJson = stableJson({ schemaVersion: 1, lane, entities: payload.entities })
    const fieldVersionStateJson = stableJson(
      [...payload.fieldVersions].sort((left, right) =>
        left.entityType.localeCompare(right.entityType) ||
        left.entitySyncId.localeCompare(right.entitySyncId) ||
        left.fieldId.localeCompare(right.fieldId)
      )
    )
    const frontierJson = encodeGenesisFrontiers({ [lane]: cut.laneFrontiers[lane] ?? {} })
    const aliasEdges = lane === 'CORE_META'
      ? (this.database.prepare(`
          SELECT entity_type,left_sync_id,left_generation,right_sync_id,right_generation
          FROM sync_alias_edge
          WHERE sync_space_id=?
          ORDER BY entity_type,left_generation,left_sync_id,right_sync_id
        `).all(cut.syncSpaceId) as unknown as Array<{
          entity_type: string
          left_sync_id: string
          left_generation: number
          right_sync_id: string
          right_generation: number
        }>).map((row) => ({
          targetEntityType: row.entity_type,
          leftSyncId: row.left_sync_id,
          leftGeneration: Number(row.left_generation),
          rightSyncId: row.right_sync_id,
          rightGeneration: Number(row.right_generation)
        }))
      : []
    const causalMetadataJson = stableJson({
      schemaVersion: 1,
      crossDbCutId: cut.crossDbCutId,
      capturedAt: cut.capturedAt,
      aliasEdges,
      observedGenesisBaselinesByLane: Object.fromEntries(PHASE_A_LANES.map((candidateLane) => [
        candidateLane,
        [cut.genesisBaselineId]
      ]))
    })
    const genesisCoverageJson = stableJson({ schemaVersion: 1, genesisBaselineId: cut.genesisBaselineId, entityCount: payload.entities.length })
    const laneEntityTypes = snapshotEntityTypesForLane(lane)
    const tombstones = laneEntityTypes.length === 0
      ? []
      : this.database.prepare(`
          SELECT entity_type,entity_sync_id,generation,version_token,deleted_at
          FROM sync_entity_tombstone
          WHERE sync_space_id=? AND entity_type IN (${laneEntityTypes.map(() => '?').join(',')})
          ORDER BY entity_type,entity_sync_id
        `).all(cut.syncSpaceId, ...laneEntityTypes) as unknown as Array<{
          entity_type: SyncEntityType
          entity_sync_id: string
          generation: number
          version_token: string
          deleted_at: number
        }>
    const generations = new Map(
      payload.entities.map((entity) => [
        `${entity.entityType}:${entity.entitySyncId}`,
        entity.generation
      ])
    )
    for (const tombstone of tombstones) {
      const key = `${tombstone.entity_type}:${tombstone.entity_sync_id}`
      generations.set(key, Math.max(generations.get(key) ?? 0, Number(tombstone.generation)))
    }
    const deletionGenerationSummaryJson = stableJson({
      schemaVersion: 1,
      deleted: tombstones.map((row) => ({
        entityType: row.entity_type,
        entitySyncId: row.entity_sync_id,
        generation: Number(row.generation),
        versionToken: row.version_token,
        deletedAt: Number(row.deleted_at)
      })),
      generations: Object.fromEntries([...generations.entries()].sort(([a], [b]) => a.localeCompare(b)))
    })
    const blobIndexes = this.blobState.snapshotIndexes(cut.syncSpaceId, lane)
    const deletionGenerationSummary = JSON.parse(deletionGenerationSummaryJson) as { deleted?: unknown; generations?: unknown }
    const hashWire: SyncSnapshotShardWire = {
      replicationLaneId: lane,
      frontierJson,
      entityStateJson,
      fieldVersionStateJson,
      causalMetadataJson,
      genesisCoverageJson,
      deletionGenerationSummaryJson,
      contentHash: '',
      deletionSummaryJson: canonicalJson(JSON.stringify(deletionGenerationSummary.deleted ?? [])),
      generationSummaryJson: canonicalJson(JSON.stringify(deletionGenerationSummary.generations ?? {})),
      blobManifestIndexJson: blobIndexes.manifestIndexJson,
      blobReferenceIndexJson: blobIndexes.referenceIndexJson
    }
    const contentHash = snapshotShardContentHash(hashWire, SNAPSHOT_HASH_SCHEMA_VERSION)
    return {
      snapshotBundleId: bundleId,
      syncSpaceId: cut.syncSpaceId,
      replicationLaneId: lane,
      frontierJson,
      entityStateJson,
      fieldVersionStateJson,
      causalMetadataJson,
      genesisCoverageJson,
      deletionGenerationSummaryJson,
      blobManifestIndexJson: blobIndexes.manifestIndexJson,
      blobReferenceIndexJson: blobIndexes.referenceIndexJson,
      contentHash,
      createdAt: now
    }
  }

  private markCutOutboxIncluded(cut: DesktopGenesisCut, now: number): void {
    for (const row of this.runtime.listGenesisCandidates(cut.syncSpaceId)) {
      if (!PHASE_A_LANES.includes(row.replicationLaneId)) continue
      const frontier = cut.laneFrontiers[row.replicationLaneId]?.[row.actorIncarnationId] ?? 0
      if (row.sequence <= frontier) {
        this.runtime.markOutboxGenesisIncluded(row.outboxId, now)
        const operation = this.runtime.findOperationByDot(row.actorIncarnationId, row.replicationLaneId, row.sequence)
        if (operation) this.runtime.upsertGenesisOperationCoverage(operation.operationId, cut.genesisSessionId, now)
      }
    }
  }

  private ensureLocalSpaceRoot(syncSpaceId: string, now: number): void {
    const existing = this.runtime.listAuthObjects(syncSpaceId)
    if (existing.length > 0) {
      if (!existing.some((object) => object.objectType === 'SPACE_ROOT')) {
        throw new Error(`AUTH ledger for ${syncSpaceId} has no SPACE_ROOT`)
      }
      return
    }
    if (!this.signingKeys) throw new Error('Genesis SPACE_ROOT requires device signing keys')
    const device = this.runtime.findDeviceIdentity()
    if (!device) throw new Error('Device identity must exist before creating SPACE_ROOT')

    const publicKey = this.signingKeys.publicKeySpkiBase64(device.deviceId)
    const payloadJson = canonicalJson(JSON.stringify({
      ownerPublicKeySpkiBase64: publicKey,
      publicKeySpkiBase64: publicKey,
      spaceRootPublicKey: publicKey
    }))
    const payloadHash = sha256Hex(payloadJson)
    const unsigned = {
      protocolVersion: 1 as const,
      authObjectId: authObjectId(syncSpaceId, 0, 'SPACE_ROOT', device.deviceId, payloadHash, 0),
      syncSpaceId,
      authEpoch: 0,
      authSequence: 0,
      objectType: 'SPACE_ROOT' as const,
      authorDeviceId: device.deviceId,
      ownerDeviceId: device.deviceId,
      targetDeviceId: null,
      previousEpochFinalAcceptedPrefixByActorLane: {},
      revokeCutoffByActorLane: null,
      payloadJson,
      payloadHash,
      signingDigest: '',
      authorSignature: ''
    }
    const signingDigest = authSigningDigest(unsigned)
    const root = {
      ...unsigned,
      signingDigest,
      authorSignature: this.signingKeys.signBase64(device.deviceId, authSigningMaterial(unsigned))
    }

    const state = new SyncStateRepository(this.database)
    state.registerPeer({
      syncSpaceId,
      deviceId: device.deviceId,
      publicKeySpkiBase64: publicKey,
      status: 'ACTIVE',
      authEpoch: 0,
      updatedAt: now
    })
    new DesktopAuthLedgerService(this.runtime, state).append(syncSpaceId, [root], now)
  }

  private findBundleForSession(sessionId: string): string | null {
    const row = this.database.prepare(
      'SELECT snapshot_bundle_id FROM sync_snapshot_bundle WHERE genesis_session_id=? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as { snapshot_bundle_id: string } | undefined
    return row?.snapshot_bundle_id ?? null
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (value == null || !value.trim()) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('Snapshot merge metadata must be a JSON array')
  return parsed
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (value == null || !value.trim()) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Snapshot merge metadata must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function snapshotEntityKey(entityType: string, entitySyncId: string): string {
  return entityType + ':' + entitySyncId
}

function snapshotVersionKey(
  entityType: string,
  entitySyncId: string,
  entityGeneration: number,
  fieldId: string
): string {
  return [entityType, entitySyncId, String(entityGeneration), fieldId].join('\u0000')
}

function safeSnapshotGeneration(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function snapshotGenerationMap(shard: SyncSnapshotShardWire): Record<string, number> {
  const direct = parseJsonObject(shard.generationSummaryJson)
  let combined: Record<string, unknown> = {}
  if (shard.deletionGenerationSummaryJson?.trim()) {
    const parsed = JSON.parse(shard.deletionGenerationSummaryJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      combined = parsed as Record<string, unknown>
    }
  }
  const nested = combined.generations
  const source = Object.keys(direct).length > 0
    ? direct
    : nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : {}
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const generation = safeSnapshotGeneration(raw, -1)
    if (generation >= 0) result[key] = generation
  }
  return result
}

function mergeGenerationMaps(
  left: Record<string, number>,
  right: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    result[key] = Math.max(result[key] ?? 0, value)
  }
  return result
}

function snapshotTombstones(shard: SyncSnapshotShardWire, now: number): SnapshotTombstoneRow[] {
  let rawRows: unknown[] = []
  if (shard.deletionSummaryJson?.trim()) {
    const parsed = JSON.parse(shard.deletionSummaryJson) as unknown
    if (Array.isArray(parsed)) rawRows = parsed
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).deleted)) {
      rawRows = (parsed as Record<string, unknown>).deleted as unknown[]
    }
  } else if (shard.deletionGenerationSummaryJson?.trim()) {
    const parsed = JSON.parse(shard.deletionGenerationSummaryJson) as unknown
    if (Array.isArray(parsed)) rawRows = parsed
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).deleted)) {
      rawRows = (parsed as Record<string, unknown>).deleted as unknown[]
    }
  }
  const generations = snapshotGenerationMap(shard)
  return rawRows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Snapshot tombstone row is malformed')
    }
    const row = raw as Record<string, unknown>
    const entityType = String(row.entityType ?? '')
    const entitySyncId = String(row.entitySyncId ?? '')
    if (!entityType || !entitySyncId) throw new Error('Snapshot tombstone identity is incomplete')
    const generation = safeSnapshotGeneration(
      row.generation,
      Math.max(1, generations[snapshotEntityKey(entityType, entitySyncId)] ?? 1)
    )
    const deletedAt = Number(row.deletedAt)
    return {
      entityType,
      entitySyncId,
      generation,
      versionToken: String(
        row.versionToken ??
        ('TOMBSTONE|MERGE|' + entityType + '|' + entitySyncId + '|' + String(generation))
      ),
      deletedAt: Number.isSafeInteger(deletedAt) && deletedAt >= 0 ? deletedAt : now
    }
  })
}

function mergeSnapshotTombstones(
  left: SnapshotTombstoneRow[],
  right: SnapshotTombstoneRow[]
): SnapshotTombstoneRow[] {
  const result = new Map<string, SnapshotTombstoneRow>()
  for (const candidate of [...left, ...right]) {
    const key = snapshotEntityKey(candidate.entityType, candidate.entitySyncId)
    const current = result.get(key)
    if (!current ||
      candidate.generation > current.generation ||
      (candidate.generation === current.generation &&
        (candidate.versionToken > current.versionToken ||
          (candidate.versionToken === current.versionToken && candidate.deletedAt > current.deletedAt)))) {
      result.set(key, candidate)
    }
  }
  return [...result.values()].sort(compareSnapshotTombstones)
}

function compareSnapshotTombstones(left: SnapshotTombstoneRow, right: SnapshotTombstoneRow): number {
  return left.entityType.localeCompare(right.entityType) ||
    left.entitySyncId.localeCompare(right.entitySyncId) ||
    left.generation - right.generation ||
    left.versionToken.localeCompare(right.versionToken)
}

function mergeActorFrontiers(
  left: Record<string, number>,
  right: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const actor of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const prefix = Math.max(left[actor] ?? 0, right[actor] ?? 0)
    if (prefix > 0) result[actor] = prefix
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

function mergeSnapshotCausalMetadata(
  left: SyncSnapshotShardWire,
  right: SyncSnapshotShardWire,
  now: number
): string {
  const a = parseJsonObject(left.causalMetadataJson)
  const b = parseJsonObject(right.causalMetadataJson)
  const aliasEdges = new Map<string, unknown>()
  for (const raw of [
    ...(Array.isArray(a.aliasEdges) ? a.aliasEdges : []),
    ...(Array.isArray(b.aliasEdges) ? b.aliasEdges : [])
  ]) {
    aliasEdges.set(stableJson(raw), raw)
  }
  const observed: Record<string, string[]> = {}
  for (const root of [a, b]) {
    const value = root.observedGenesisBaselinesByLane
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const [lane, baselines] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(baselines)) continue
      const current = new Set(observed[lane] ?? [])
      for (const baseline of baselines) {
        if (typeof baseline === 'string' && baseline) current.add(baseline)
      }
      observed[lane] = [...current].sort()
    }
  }
  return stableJson({
    schemaVersion: 2,
    crossDbCutId: typeof a.crossDbCutId === 'string' ? a.crossDbCutId
      : typeof b.crossDbCutId === 'string' ? b.crossDbCutId : null,
    capturedAt: now,
    aliasEdges: [...aliasEdges.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, value]) => value),
    observedGenesisBaselinesByLane: Object.fromEntries(
      Object.entries(observed).sort(([x], [y]) => x.localeCompare(y))
    )
  })
}

function sortSnapshotEntities(values: GenesisEntity[]): GenesisEntity[] {
  return [...values].sort((left, right) =>
    left.entityType.localeCompare(right.entityType) ||
    left.entitySyncId.localeCompare(right.entitySyncId) ||
    left.generation - right.generation
  )
}

function sortSnapshotFieldVersions(
  values: GenesisFieldVersionSnapshot[]
): GenesisFieldVersionSnapshot[] {
  return [...values].sort((left, right) =>
    left.entityType.localeCompare(right.entityType) ||
    left.entitySyncId.localeCompare(right.entitySyncId) ||
    left.entityGeneration - right.entityGeneration ||
    left.fieldId.localeCompare(right.fieldId) || left.versionToken.localeCompare(right.versionToken)
  )
}

function normalizeSnapshotEntities(
  shard: SyncSnapshotShardWire,
  lane: SyncReplicationLane
): GenesisEntity[] {
  const parsed = JSON.parse(shard.entityStateJson) as unknown
  const generations = snapshotGenerationMap(shard)
  const normalize = (raw: unknown): GenesisEntity | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const row = raw as Record<string, unknown>
    const entityType = String(row.entityType ?? '')
    const entitySyncId = String(row.entitySyncId ?? '')
    if (!entityType || !entitySyncId) return null
    const key = snapshotEntityKey(entityType, entitySyncId)
    const fields = row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields)
      ? row.fields as Record<string, unknown>
      : {}
    return {
      entityType,
      entitySyncId,
      generation: safeSnapshotGeneration(row.generation, generations[key] ?? 0),
      fields: { ...fields }
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.map(normalize).filter((value): value is GenesisEntity => value != null)
  }
  if (!parsed || typeof parsed !== 'object') return []
  const root = parsed as Record<string, unknown>
  if (Array.isArray(root.entities)) {
    return root.entities.map(normalize).filter((value): value is GenesisEntity => value != null)
  }

  if (lane === 'LIBRARY') {
    const result: GenesisEntity[] = []
    for (const raw of Array.isArray(root.groups) ? root.groups : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      const entitySyncId = String(row.syncId ?? '')
      if (!entitySyncId) continue
      const entityType = 'group'
      result.push({
        entityType,
        entitySyncId,
        generation: generations[snapshotEntityKey(entityType, entitySyncId)] ?? 0,
        fields: { name: String(row.name ?? 'Group') }
      })
    }
    for (const raw of Array.isArray(root.feeds) ? root.feeds : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      const entitySyncId = String(row.syncId ?? '')
      if (!entitySyncId) continue
      const entityType = 'feed'
      result.push({
        entityType,
        entitySyncId,
        generation: generations[snapshotEntityKey(entityType, entitySyncId)] ?? 0,
        fields: {
          groupSyncId: row.groupSyncId ?? null,
          groupGeneration: row.groupGeneration ?? null,
          name: row.name ?? 'Feed',
          icon: row.icon ?? null,
          url: row.url ?? '',
          sourceType: row.sourceType ?? 'RSS',
          isNotification: Boolean(row.isNotification),
          isFullContent: Boolean(row.isFullContent),
          isBrowser: Boolean(row.isBrowser)
        }
      })
    }
    return result
  }

  if (lane === 'ARTICLE_STATE' && Array.isArray(root.articles)) {
    return root.articles.flatMap((raw): GenesisEntity[] => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const row = raw as Record<string, unknown>
      const entitySyncId = String(row.syncId ?? '')
      if (!entitySyncId) return []
      const fields: Record<string, unknown> = {
        feedSyncId: row.feedSyncId ?? null,
        feedGeneration: row.feedGeneration ?? null,
        title: row.title ?? '',
        url: row.link ?? row.url ?? null,
        author: row.author ?? null,
        publishedAt: row.date ?? row.publishedAt ?? null,
        description: row.description ?? '',
        contentHtml: row.contentHtml ?? '',
        imageUrl: row.imageUrl ?? null,
        isUnread: Boolean(row.isUnread),
        isStarred: Boolean(row.isStarred),
        isReadLater: Boolean(row.isReadLater)
      }
      if (row.fullContentHash != null) fields.fullContentHash = row.fullContentHash
      return [{
        entityType: 'article',
        entitySyncId,
        generation: generations[snapshotEntityKey('article', entitySyncId)] ?? 0,
        fields
      }]
    })
  }

  if (lane === 'CONFIG' && Array.isArray(root.rules)) {
    return root.rules.map((raw, index) => {
      const row = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {}
      const entitySyncId = String(row.id ?? ('legacy-filter-rule-' + String(index)))
      return {
        entityType: 'filter_rule',
        entitySyncId,
        generation: generations[snapshotEntityKey('filter_rule', entitySyncId)] ?? 0,
        fields: { ...row }
      }
    })
  }
  return []
}

function snapshotEntityValueForVersion(
  entity: GenesisEntity,
  fieldId: string
): unknown {
  if (entity.entityType === 'article' && fieldId === SYNC_ARTICLE_FULL_CONTENT_FIELD) {
    return entity.fields.fullContentHash
  }
  return entity.fields[fieldId]
}

function normalizeValueJson(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      return stableJson(JSON.parse(raw))
    } catch {
      throw new Error('Snapshot field-version valueJson is malformed')
    }
  }
  return stableJson(raw ?? null)
}

function normalizeSnapshotFieldVersions(
  shard: SyncSnapshotShardWire,
  entities: GenesisEntity[],
  baselineId: string,
  lane: SyncReplicationLane
): GenesisFieldVersionSnapshot[] {
  if (!shard.fieldVersionStateJson?.trim() || shard.fieldVersionStateJson.trim() === '{}') return []
  const parsed = JSON.parse(shard.fieldVersionStateJson) as unknown
  const byIdentity = new Map(entities.map((entity) => [
    snapshotEntityKey(entity.entityType, entity.entitySyncId),
    entity
  ]))
  const bySyncId = new Map<string, GenesisEntity[]>()
  for (const entity of entities) {
    const bucket = bySyncId.get(entity.entitySyncId) ?? []
    bucket.push(entity)
    bySyncId.set(entity.entitySyncId, bucket)
  }
  const resolveEntity = (entityType: string | null, entitySyncId: string): GenesisEntity | null => {
    if (entityType) return byIdentity.get(snapshotEntityKey(entityType, entitySyncId)) ?? null
    const candidates = bySyncId.get(entitySyncId) ?? []
    if (candidates.length > 1) {
      throw new Error('Snapshot field-version entity type is ambiguous for ' + entitySyncId)
    }
    return candidates[0] ?? null
  }
  const result: GenesisFieldVersionSnapshot[] = []
  const append = (
    entityType: string | null,
    entitySyncId: string,
    generationRaw: unknown,
    fieldId: string,
    versionToken: string,
    valueJsonRaw: unknown,
    causalContextJsonRaw: unknown,
    logicalClockRaw: unknown
  ): void => {
    const entity = resolveEntity(entityType, entitySyncId)
    if (!entity) return
    const entityGeneration = safeSnapshotGeneration(generationRaw, entity.generation)
    if (entityGeneration !== entity.generation) {
      throw new Error('Snapshot field-version generation does not match entity state')
    }
    const fallbackValue = snapshotEntityValueForVersion(entity, fieldId)
    const valueJson = valueJsonRaw == null
      ? stableJson(fallbackValue ?? null)
      : normalizeValueJson(valueJsonRaw)
    SyncVersionToken.source(versionToken)
    const logicalClock = logicalClockRaw == null ? null : Number(logicalClockRaw)
    if (logicalClock != null && (!Number.isSafeInteger(logicalClock) || logicalClock < 0)) {
      throw new Error('Snapshot field-version logicalClock is invalid')
    }
    result.push({
      entityType: entity.entityType,
      entitySyncId,
      entityGeneration,
      fieldId,
      valueJson,
      versionToken,
      causalContextJson: causalContextJsonRaw == null ? null : String(causalContextJsonRaw),
      logicalClock
    })
  }

  if (Array.isArray(parsed)) {
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Snapshot field-version row is malformed')
      }
      const row = raw as Record<string, unknown>
      const entitySyncId = String(row.entitySyncId ?? '')
      const fieldId = String(row.fieldId ?? '')
      const versionToken = String(row.versionToken ?? '')
      if (!entitySyncId || !fieldId || !versionToken) {
        throw new Error('Snapshot field-version row is incomplete')
      }
      append(
        row.entityType == null ? null : String(row.entityType),
        entitySyncId,
        row.entityGeneration,
        fieldId,
        versionToken,
        row.valueJson,
        row.causalContextJson,
        row.logicalClock
      )
    }
    return sortSnapshotFieldVersions(result)
  }

  if (!parsed || typeof parsed !== 'object') return []
  const root = parsed as Record<string, unknown>
  const fieldsRoot = root.fields && typeof root.fields === 'object' && !Array.isArray(root.fields)
    ? root.fields as Record<string, unknown>
    : root
  for (const [entityKey, rawFields] of Object.entries(fieldsRoot)) {
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) continue
    const separator = entityKey.indexOf(':')
    if (separator <= 0 || separator === entityKey.length - 1) continue
    const entityType = entityKey.slice(0, separator)
    const entitySyncId = entityKey.slice(separator + 1)
    const entity = resolveEntity(entityType, entitySyncId)
    if (!entity) continue
    for (const [fieldId, rawToken] of Object.entries(rawFields as Record<string, unknown>)) {
      if (typeof rawToken !== 'string' || !rawToken) continue
      append(
        entityType,
        entitySyncId,
        entity.generation,
        fieldId,
        rawToken,
        null,
        null,
        null
      )
    }
  }

  // A legacy Snapshot may omit a VersionToken for fields that were added later. Those fields
  // become explicit Genesis candidates from that Snapshot baseline instead of being dropped.
  const existing = new Set(result.map((row) =>
    snapshotVersionKey(row.entityType, row.entitySyncId, row.entityGeneration, row.fieldId)
  ))
  for (const entity of entities) {
    for (const [fieldName, value] of Object.entries(entity.fields)) {
      const fieldId = entity.entityType === 'article' && fieldName === 'fullContentHash'
        ? SYNC_ARTICLE_FULL_CONTENT_FIELD
        : fieldName
      const key = snapshotVersionKey(entity.entityType, entity.entitySyncId, entity.generation, fieldId)
      if (existing.has(key)) continue
      result.push({
        entityType: entity.entityType,
        entitySyncId: entity.entitySyncId,
        entityGeneration: entity.generation,
        fieldId,
        valueJson: stableJson(value),
        versionToken: SyncVersionToken.genesis(baselineId, lane, entity.entitySyncId, fieldId),
        causalContextJson: null,
        logicalClock: null
      })
    }
  }
  return sortSnapshotFieldVersions(result)
}

function decodeFieldCausalMetadata(raw: string | null): {
  causalContext?: SyncCoverage
  observedGenesisBaselinesByLane?: Record<string, string[]>
} {
  if (!raw?.trim()) return {}
  const parsed = JSON.parse(raw) as {
    lanes?: Array<{
      replicationLaneId?: unknown
      actors?: Array<{ actorIncarnationId?: unknown; prefix?: unknown }>
    }>
    observedGenesisBaselinesByLane?: Record<string, unknown>
  }
  const causalContext: SyncCoverage = {}
  for (const lane of parsed.lanes ?? []) {
    const laneId = String(lane.replicationLaneId ?? '')
    if (!laneId) continue
    const actors: Record<string, number> = {}
    for (const actor of lane.actors ?? []) {
      const actorId = String(actor.actorIncarnationId ?? '')
      const prefix = Number(actor.prefix)
      if (actorId && Number.isSafeInteger(prefix) && prefix > 0) actors[actorId] = prefix
    }
    if (Object.keys(actors).length) causalContext[laneId] = actors
  }
  const observed: Record<string, string[]> = {}
  if (parsed.observedGenesisBaselinesByLane &&
      typeof parsed.observedGenesisBaselinesByLane === 'object' &&
      !Array.isArray(parsed.observedGenesisBaselinesByLane)) {
    for (const [lane, values] of Object.entries(parsed.observedGenesisBaselinesByLane)) {
      if (Array.isArray(values)) {
        observed[lane] = values.filter((value): value is string => typeof value === 'string').sort()
      }
    }
  }
  return {
    causalContext: Object.keys(causalContext).length ? causalContext : undefined,
    observedGenesisBaselinesByLane: Object.keys(observed).length ? observed : undefined
  }
}

function snapshotFieldCandidate(row: GenesisFieldVersionSnapshot): SyncFieldCandidate {
  const causal = decodeFieldCausalMetadata(row.causalContextJson)
  return {
    versionToken: row.versionToken,
    valueJson: row.valueJson,
    source: SyncVersionToken.source(row.versionToken),
    causalContext: causal.causalContext,
    observedGenesisBaselinesByLane: causal.observedGenesisBaselinesByLane,
    logicalClock: row.logicalClock ?? 0
  }
}

function snapshotPolicyForField(fieldId: string): SyncGenesisMergePolicy {
  if (fieldId === 'isUnread') return 'READ_WINS'
  if (fieldId === 'isStarred') return 'STARRED_WINS'
  return 'DETERMINISTIC'
}

function mergeSnapshotBusinessState(
  lane: SyncReplicationLane,
  localEntities: GenesisEntity[],
  targetEntities: GenesisEntity[],
  localVersions: GenesisFieldVersionSnapshot[],
  targetVersions: GenesisFieldVersionSnapshot[],
  localBaselineId: string,
  targetBaselineId: string,
  tombstones: SnapshotTombstoneRow[]
): { entities: GenesisEntity[]; fieldVersions: GenesisFieldVersionSnapshot[] } {
  const localEntityMap = new Map(localEntities.map((entity) => [
    snapshotEntityKey(entity.entityType, entity.entitySyncId),
    entity
  ]))
  const targetEntityMap = new Map(targetEntities.map((entity) => [
    snapshotEntityKey(entity.entityType, entity.entitySyncId),
    entity
  ]))
  const tombstoneMap = new Map(tombstones.map((value) => [
    snapshotEntityKey(value.entityType, value.entitySyncId),
    value
  ]))
  const localVersionMap = new Map(localVersions.map((version) => [
    snapshotVersionKey(version.entityType, version.entitySyncId, version.entityGeneration, version.fieldId),
    version
  ]))
  const targetVersionMap = new Map(targetVersions.map((version) => [
    snapshotVersionKey(version.entityType, version.entitySyncId, version.entityGeneration, version.fieldId),
    version
  ]))
  const entityKeys = [...new Set([...localEntityMap.keys(), ...targetEntityMap.keys()])].sort()
  const entities: GenesisEntity[] = []
  const fieldVersions: GenesisFieldVersionSnapshot[] = []

  const versionFor = (
    source: 'local' | 'target',
    entity: GenesisEntity,
    fieldId: string,
    value: unknown
  ): GenesisFieldVersionSnapshot => {
    const map = source === 'local' ? localVersionMap : targetVersionMap
    const found = map.get(snapshotVersionKey(
      entity.entityType,
      entity.entitySyncId,
      entity.generation,
      fieldId
    ))
    if (found) return found
    const baselineId = source === 'local' ? localBaselineId : targetBaselineId
    return {
      entityType: entity.entityType,
      entitySyncId: entity.entitySyncId,
      entityGeneration: entity.generation,
      fieldId,
      valueJson: stableJson(value),
      versionToken: SyncVersionToken.genesis(baselineId, lane, entity.entitySyncId, fieldId),
      causalContextJson: null,
      logicalClock: null
    }
  }

  const copyEntity = (source: 'local' | 'target', entity: GenesisEntity): void => {
    const fields: Record<string, unknown> = { ...entity.fields }
    entities.push({ ...entity, fields })
    const versionFieldIds = new Set<string>()
    for (const fieldName of Object.keys(fields)) {
      versionFieldIds.add(
        entity.entityType === 'article' && fieldName === 'fullContentHash'
          ? SYNC_ARTICLE_FULL_CONTENT_FIELD
          : fieldName
      )
    }
    for (const fieldId of versionFieldIds) {
      const entityField = entity.entityType === 'article' && fieldId === SYNC_ARTICLE_FULL_CONTENT_FIELD
        ? 'fullContentHash'
        : fieldId
      fieldVersions.push(versionFor(source, entity, fieldId, fields[entityField]))
    }
  }

  for (const key of entityKeys) {
    const local = localEntityMap.get(key)
    const target = targetEntityMap.get(key)
    const maxEntityGeneration = Math.max(local?.generation ?? -1, target?.generation ?? -1)
    const tombstone = tombstoneMap.get(key)
    if (tombstone && tombstone.generation >= maxEntityGeneration) continue

    if (!target || (local && local.generation > target.generation)) {
      if (local) copyEntity('local', local)
      continue
    }
    if (!local || target.generation > local.generation) {
      copyEntity('target', target)
      continue
    }

    const mergedFields: Record<string, unknown> = {}
    const localVersionFields = localVersions
      .filter((version) => version.entityType === local.entityType &&
        version.entitySyncId === local.entitySyncId &&
        version.entityGeneration === local.generation)
      .map((version) => version.fieldId === SYNC_ARTICLE_FULL_CONTENT_FIELD && local.entityType === 'article'
        ? 'fullContentHash'
        : version.fieldId)
    const targetVersionFields = targetVersions
      .filter((version) => version.entityType === target.entityType &&
        version.entitySyncId === target.entitySyncId &&
        version.entityGeneration === target.generation)
      .map((version) => version.fieldId === SYNC_ARTICLE_FULL_CONTENT_FIELD && target.entityType === 'article'
        ? 'fullContentHash'
        : version.fieldId)
    const fields = [...new Set([
      ...Object.keys(local.fields),
      ...Object.keys(target.fields),
      ...localVersionFields,
      ...targetVersionFields
    ])].sort()
    const winnerRows = new Map<string, GenesisFieldVersionSnapshot>()

    for (const entityField of fields) {
      const fieldId = local.entityType === 'article' && entityField === 'fullContentHash'
        ? SYNC_ARTICLE_FULL_CONTENT_FIELD
        : entityField
      const localHas = Object.prototype.hasOwnProperty.call(local.fields, entityField)
      const targetHas = Object.prototype.hasOwnProperty.call(target.fields, entityField)
      const localRow = localVersionMap.get(snapshotVersionKey(
        local.entityType,
        local.entitySyncId,
        local.generation,
        fieldId
      ))
      const targetRow = targetVersionMap.get(snapshotVersionKey(
        target.entityType,
        target.entitySyncId,
        target.generation,
        fieldId
      ))
      const candidates: Array<{
        row: GenesisFieldVersionSnapshot
        candidate: SyncFieldCandidate
      }> = []
      for (const row of [...localVersions, ...targetVersions]) {
        if (row.entityType === local.entityType && row.entitySyncId === local.entitySyncId &&
            row.entityGeneration === local.generation && row.fieldId === fieldId) {
          candidates.push({ row, candidate: snapshotFieldCandidate(row) })
        }
      }
      if (localHas || localRow) {
        const row = localRow ?? versionFor('local', local, fieldId, local.fields[entityField])
        candidates.push({ row, candidate: snapshotFieldCandidate(row) })
      }
      if (targetHas || targetRow) {
        const row = targetRow ?? versionFor('target', target, fieldId, target.fields[entityField])
        candidates.push({ row, candidate: snapshotFieldCandidate(row) })
      }
      if (!candidates.length) continue
      assertMergeCompleteSnapshotOperationCandidates(
        candidates.map((item) => item.row),
        lane
      )
      const winner = SyncVersionResolver.resolve(
        candidates.map((item) => item.candidate),
        snapshotPolicyForField(fieldId)
      )
      const winnerRow = candidates
        .filter((item) => item.row.versionToken === winner.versionToken)
        .sort((a, b) =>
          Number(Boolean(a.row.causalContextJson)) - Number(Boolean(b.row.causalContextJson)) ||
          (a.row.logicalClock ?? 0) - (b.row.logicalClock ?? 0)
        )
        .at(-1)!.row
      mergedFields[entityField] = JSON.parse(winner.valueJson) as unknown
      winnerRows.set(entityField, winnerRow)
      fieldVersions.push(...[...new Map(candidates.map(({ row }) => [row.versionToken, row])).values()])
    }
    const pinRelationGeneration = (idField: string, generationField: string): void => {
      const idWinner = winnerRows.get(idField)
      if (!idWinner) return
      const paired = fieldVersions
        .filter((row) =>
          row.entityType === local.entityType &&
          row.entitySyncId === local.entitySyncId &&
          row.entityGeneration === local.generation &&
          row.fieldId === generationField &&
          sameSnapshotRelationVersionOrigin(row.versionToken, idWinner.versionToken)
        )
        .sort((a, b) =>
          Number(Boolean(a.causalContextJson)) - Number(Boolean(b.causalContextJson)) ||
          (a.logicalClock ?? 0) - (b.logicalClock ?? 0)
        )
        .at(-1)
      mergedFields[generationField] = paired
        ? JSON.parse(paired.valueJson) as unknown
        : null
    }
    if (local.entityType === 'feed') {
      pinRelationGeneration('groupSyncId', 'groupGeneration')
    } else if (local.entityType === 'article') {
      pinRelationGeneration('feedSyncId', 'feedGeneration')
    } else if (local.entityType === 'filter_rule') {
      pinRelationGeneration('feedSyncId', 'feedGeneration')
    }
    entities.push({
      entityType: local.entityType,
      entitySyncId: local.entitySyncId,
      generation: local.generation,
      fields: mergedFields
    })
  }
  return {
    entities: sortSnapshotEntities(entities),
    fieldVersions: sortSnapshotFieldVersions(fieldVersions)
  }
}

function sameSnapshotRelationVersionOrigin(leftToken: string, rightToken: string): boolean {
  if (leftToken === rightToken) return true
  if (!leftToken.startsWith('GENESIS_V1|') || !rightToken.startsWith('GENESIS_V1|')) return false
  const left = leftToken.split('|')
  const right = rightToken.split('|')
  return left.length === 6 &&
    right.length === 6 &&
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2] &&
    left[3] === right[3]
}

function assertMergeCompleteSnapshotOperationCandidates(
  rows: GenesisFieldVersionSnapshot[],
  lane: SyncReplicationLane
): void {
  const operationRows = [...new Map(
    rows
      .filter((row) => SyncVersionToken.source(row.versionToken) === 'OPERATION')
      .map((row) => [row.versionToken, row])
  ).values()]
  for (const row of operationRows) {
    const dot = parseOperationVersionToken(row.versionToken)
    if (!dot) throw new Error('REBASE_UNSAFE: Snapshot Operation VersionToken is malformed')
    if (dot.replicationLaneId !== lane) {
      throw new Error('REBASE_UNSAFE: Snapshot field winner belongs to another replication lane')
    }
  }
  for (let leftIndex = 0; leftIndex < operationRows.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < operationRows.length; rightIndex++) {
      const left = operationRows[leftIndex]!
      const right = operationRows[rightIndex]!
      const leftDot = parseOperationVersionToken(left.versionToken)!
      const rightDot = parseOperationVersionToken(right.versionToken)!
      if (
        leftDot.actorIncarnationId === rightDot.actorIncarnationId &&
        leftDot.replicationLaneId === rightDot.replicationLaneId
      ) continue
      const leftCandidate = snapshotFieldCandidate(left)
      const rightCandidate = snapshotFieldCandidate(right)
      if (
        happensBefore(leftCandidate, rightCandidate) ||
        happensBefore(rightCandidate, leftCandidate)
      ) continue
      if (
        left.causalContextJson == null ||
        right.causalContextJson == null ||
        left.logicalClock == null ||
        right.logicalClock == null
      ) {
        throw new Error(
          'REBASE_UNSAFE: incomparable legacy Snapshot Operation winners lack merge-complete causal metadata'
        )
      }
    }
  }
}

function mergeSnapshotBlobIndexes(
  left: SyncSnapshotShardWire,
  right: SyncSnapshotShardWire,
  entities: GenesisEntity[],
  tombstones: SnapshotTombstoneRow[]
): { manifestIndexJson: string; referenceIndexJson: string } {
  const manifests = new Map<string, Record<string, unknown>>()
  for (const raw of [
    ...parseJsonArray(left.blobManifestIndexJson),
    ...parseJsonArray(right.blobManifestIndexJson)
  ]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Snapshot Blob manifest is malformed')
    }
    const row = raw as Record<string, unknown>
    const hash = String(row.hash ?? '')
    if (!hash) throw new Error('Snapshot Blob manifest hash is missing')
    const previous = manifests.get(hash)
    if (previous) {
      const immutable = (value: Record<string, unknown>): string => {
        const copy = { ...value }
        delete copy.referenceCount
        return stableJson(copy)
      }
      if (immutable(previous) !== immutable(row)) {
        throw new Error('Snapshot Blob manifest collision for hash ' + hash)
      }
    } else {
      manifests.set(hash, row)
    }
  }

  const survivingGeneration = new Map(entities.map((entity) => [
    snapshotEntityKey(entity.entityType, entity.entitySyncId),
    entity.generation
  ]))
  const tombstoneGeneration = new Map(tombstones.map((row) => [
    snapshotEntityKey(row.entityType, row.entitySyncId),
    row.generation
  ]))
  const references = new Map<string, Record<string, unknown>>()
  for (const raw of [
    ...parseJsonArray(left.blobReferenceIndexJson),
    ...parseJsonArray(right.blobReferenceIndexJson)
  ]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Snapshot Blob reference is malformed')
    }
    const row = raw as Record<string, unknown>
    const ownerType = String(row.ownerEntityType ?? '')
    const ownerSyncId = String(row.ownerEntitySyncId ?? '')
    const ownerGeneration = safeSnapshotGeneration(row.ownerEntityGeneration, -1)
    const hash = String(row.hash ?? '')
    const referenceKind = String(row.referenceKind ?? '')
    const lane = String(row.replicationLaneId ?? '')
    if (!ownerType || !ownerSyncId || ownerGeneration < 0 || !hash || !referenceKind || !lane) {
      throw new Error('Snapshot Blob reference identity is incomplete')
    }
    const entityKey = snapshotEntityKey(ownerType, ownerSyncId)
    const surviving = survivingGeneration.get(entityKey)
    if (surviving == null || surviving !== ownerGeneration) continue
    if ((tombstoneGeneration.get(entityKey) ?? -1) >= surviving) continue
    const key = [
      lane,
      ownerType,
      ownerSyncId,
      String(ownerGeneration),
      referenceKind,
      hash
    ].join('\u0000')
    references.set(key, row)
  }
  const sortedReferences = [...references.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
  const referenceCounts = new Map<string, number>()
  for (const row of sortedReferences) {
    const hash = String(row.hash)
    referenceCounts.set(hash, (referenceCounts.get(hash) ?? 0) + 1)
  }
  const sortedManifests = [...referenceCounts.keys()].sort().map((hash) => {
    const manifest = manifests.get(hash)
    if (!manifest) throw new Error('Snapshot Blob reference has no manifest: ' + hash)
    return { ...manifest, referenceCount: referenceCounts.get(hash) ?? 0 }
  })
  return {
    manifestIndexJson: stableJson(sortedManifests),
    referenceIndexJson: stableJson(sortedReferences)
  }
}

function stableJson(value: unknown): string {
  return canonicalJson(JSON.stringify(value))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
