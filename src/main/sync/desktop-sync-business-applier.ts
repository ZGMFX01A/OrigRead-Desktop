import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type { SyncBlobManifest, SyncPayloadBlobRef } from '../../shared/sync-protocol'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncStateRepository, type SyncFieldVersionRecord } from './sync-state-repository'
import { parseOperationVersionToken, SyncVersionResolver, SyncVersionToken, type SyncFieldCandidate } from './sync-version-token'
import { operationId, sha256Hex } from './sync-operation-canonicalizer'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRule } from '../../shared/json-source'
import type { RssHubSettings } from '../../shared/rsshub'
import type { WebsiteRule } from '../../shared/website'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import {
  WebsiteParsePreferenceRepository,
  type WebsiteParsePreferenceUserSyncState
} from '../sources/website/website-parse-preference-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { SyncApplyDeferredError } from './sync-apply-coordinator'
import { articleCanonicalKey, configRuleSyncId, feedCanonicalKey } from './sync-canonical-identity'
import { DesktopSyncAliasResolver, type SyncAliasEdgePayloadV1 } from './sync-alias-protocol'
import { DesktopAiHistoryApplier } from './desktop-ai-history-applier'
import { DesktopSyncLocalEvictionService } from './sync-alias-protocol'
import {
  syncPayloadBlobRefs,
  SYNC_ARTICLE_FULL_CONTENT_FIELD,
  SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
} from './sync-blob-payload'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'

/**
 * Desktop 端业务数据库的 Received -> Applied 业务投影处理器。
 *
 * 核心设计准则：
 * 1. 严格使用跨端唯一的 Sync ID 作为身份媒介，绝不直接将其他设备的本地自增主键或 UUID 关联到本地行；
 * 2. 严格遵循因果一致性与依赖顺序：当操作引用的依赖实体（如 Feed 所属的 Group）尚未映射时，
 *    必须抛出 SyncApplyDeferredError，协调器捕获后记录为 DEFERRED，不推进 AppliedCoverage；
 * 3. 字段更新遵循确定性裁决（VersionToken 偏序与特定字段合并策略），防止并发冲突与旧值覆盖新值。
 */
export class DesktopSyncBusinessApplier {
  private readonly identities: SyncIdentityRepository
  private readonly aliases: DesktopSyncAliasResolver
  private readonly blobs: DesktopSyncBlobStateService
  private readonly localEviction: DesktopSyncLocalEvictionService

  constructor(
    private readonly database: DatabaseSync,
    private readonly state: SyncStateRepository,
    private readonly aiHistory?: DesktopAiHistoryApplier,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
    private readonly articleFilters?: ArticleFilterRepository,
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
    this.localEviction = new DesktopSyncLocalEvictionService(database)
  }

  private resolveFeedScopedConfigParent(
    syncSpaceId: string,
    feedSyncId: string,
    feedGeneration: number | null,
    label: string
  ): string | null {
    const feedMapping = this.identities.findBySyncId(syncSpaceId, 'feed', feedSyncId)
    if (!feedMapping) throw new SyncApplyDeferredError(label + ' is waiting for feed ' + feedSyncId)

    if (feedGeneration != null) {
      if (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0) {
        throw new SyncApplyDeferredError(label + ' has invalid feedGeneration')
      }
      if (feedMapping.generation < feedGeneration) {
        throw new SyncApplyDeferredError(
          label + ' is waiting for feed ' + feedSyncId + ' generation ' + feedGeneration
        )
      }
      if (feedMapping.generation > feedGeneration) return null
    } else if (feedMapping.generation > 0) {
      // Legacy feed-scoped CONFIG without parent generation is unambiguous only at generation 0.
      return null
    }

    const feedRow = this.database.prepare('SELECT 1 FROM feeds WHERE id=? LIMIT 1')
      .get(feedMapping.localId)
    if (feedRow) return feedMapping.localId

    const tombstone = this.database.prepare(
      "SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type='feed' AND entity_sync_id=? LIMIT 1"
    ).get(syncSpaceId, feedSyncId) as { generation: number } | undefined
    const expectedGeneration = feedGeneration ?? feedMapping.generation
    if (tombstone && tombstone.generation >= expectedGeneration) return null

    throw new SyncApplyDeferredError(label + ' is waiting for feed ' + feedSyncId)
  }

  private resolveGroupParent(
    syncSpaceId: string,
    groupSyncId: string,
    groupGeneration: number | null,
    label: string
  ): string | null {
    const groupMapping = this.identities.findBySyncId(syncSpaceId, 'group', groupSyncId)
    if (!groupMapping) throw new SyncApplyDeferredError(label + ' is waiting for group ' + groupSyncId)

    if (groupGeneration != null) {
      if (!Number.isSafeInteger(groupGeneration) || groupGeneration < 0) {
        throw new SyncApplyDeferredError(label + ' has invalid groupGeneration')
      }
      if (groupMapping.generation < groupGeneration) {
        throw new SyncApplyDeferredError(
          label + ' is waiting for group ' + groupSyncId + ' generation ' + groupGeneration
        )
      }
      if (groupMapping.generation > groupGeneration) return null
    } else if (groupMapping.generation > 0) {
      return null
    }

    const groupRow = this.database.prepare('SELECT 1 FROM groups WHERE id=? LIMIT 1')
      .get(groupMapping.localId)
    if (groupRow) return groupMapping.localId

    const tombstone = this.database.prepare(
      "SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type='group' AND entity_sync_id=? LIMIT 1"
    ).get(syncSpaceId, groupSyncId) as { generation: number } | undefined
    const expectedGeneration = groupGeneration ?? groupMapping.generation
    if (tombstone && tombstone.generation >= expectedGeneration) return null

    throw new SyncApplyDeferredError(label + ' is waiting for group ' + groupSyncId)
  }

  private pairedGenerationForWinner(
    operation: SyncOperationRecord,
    generationField: string,
    winnerToken: string
  ): number | null {
    const paired = this.state.listFieldCandidates(operation.syncSpaceId).find((row) =>
      row.entityType === operation.entityType &&
      row.entitySyncId === operation.entitySyncId &&
      row.entityGeneration === operation.entityGeneration &&
      row.fieldId === generationField &&
      this.sameRelationVersionOrigin(row.versionToken, winnerToken)
    )
    if (!paired) return null
    const parsed = JSON.parse(paired.valueJson) as unknown
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new SyncApplyDeferredError(
        'Invalid ' + generationField + ' for ' + operation.entityType + '/' + operation.entitySyncId
      )
    }
    return parsed
  }

  private sameRelationVersionOrigin(leftToken: string, rightToken: string): boolean {
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

  private pairedGenerationForProjectedField(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    idField: string,
    generationField: string
  ): number | null {
    const idWinner = this.state.findFieldVersion(syncSpaceId, entityType, entitySyncId, idField)
    if (!idWinner || idWinner.entityGeneration !== entityGeneration) {
      return this.rollbackBaselineGeneration(
        syncSpaceId,
        entityType,
        entitySyncId,
        entityGeneration,
        generationField
      )
    }
    const paired = this.state.listFieldCandidates(syncSpaceId).find((row) =>
      row.entityType === entityType &&
      row.entitySyncId === entitySyncId &&
      row.entityGeneration === entityGeneration &&
      row.fieldId === generationField &&
      this.sameRelationVersionOrigin(row.versionToken, idWinner.versionToken)
    )
    if (!paired) {
      const inbox = idWinner.sourceOperationId
        ? this.state.findInbox(idWinner.sourceOperationId)
        : null
      if (inbox?.state === 'REJECTED') {
        return this.rollbackBaselineGeneration(
          syncSpaceId,
          entityType,
          entitySyncId,
          entityGeneration,
          generationField
        )
      }
      return null
    }
    const parsed = JSON.parse(paired.valueJson) as unknown
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        'REBASE_UNSAFE: invalid ' + generationField + ' for ' + entityType + '/' + entitySyncId
      )
    }
    return parsed
  }

  private pairedGenerationForProjectedWinner(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    generationField: string,
    winnerToken: string
  ): number | null {
    const paired = this.state.listFieldCandidates(syncSpaceId).find((row) =>
      row.entityType === entityType &&
      row.entitySyncId === entitySyncId &&
      row.entityGeneration === entityGeneration &&
      row.fieldId === generationField &&
      this.sameRelationVersionOrigin(row.versionToken, winnerToken)
    )
    if (!paired) return null
    const parsed = JSON.parse(paired.valueJson) as unknown
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        'REBASE_UNSAFE: invalid ' + generationField + ' for ' + entityType + '/' + entitySyncId
      )
    }
    return parsed
  }

  private rollbackBaselineGeneration(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    generationField: string
  ): number | null {
    const baseline = this.database.prepare(`
      SELECT value_json FROM sync_field_rollback_baseline
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND field_id=?
      LIMIT 1
    `).get(
      syncSpaceId,
      entityType,
      entitySyncId,
      entityGeneration,
      generationField
    ) as { value_json: string } | undefined
    if (!baseline) return null
    const restored = this.decodeRollbackBaseline(baseline.value_json)
    const parsed = JSON.parse(restored.valueJson) as unknown
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        'REBASE_UNSAFE: invalid rollback baseline ' + generationField +
        ' for ' + entityType + '/' + entitySyncId
      )
    }
    return parsed
  }

  canApplyProvisionally(operation: SyncOperationRecord): boolean {
    if (operation.operationType !== 'FIELD_SET') return false
    const payload = parsePayload(operation.payloadJson)
    const field = typeof payload.field === 'string' ? payload.field : null
    if (operation.entityType === 'group') return field === 'name'
    if (operation.entityType === 'feed') return field === 'name'
    if (operation.entityType === 'article') return field === 'isStarred' || field === 'isUnread' || field === 'isReadLater'
    return false
  }

  shouldFetchBlob(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    reference: SyncPayloadBlobRef
  ): boolean {
    if (
      entityType !== 'article' ||
      reference.referenceKind !== SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    ) return true
    return !this.localEviction.isEvicted(
      syncSpaceId,
      'article',
      entitySyncId,
      entityGeneration,
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )
  }

  canApplyWithoutBlob(entityType: string, referenceKind: string): boolean {
    return this.aiHistory?.owns(entityType) === true &&
      this.aiHistory.canApplyWithoutBlob(entityType, referenceKind)
  }

  shouldRefillReferencedBlob(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    referenceKind: string
  ): boolean {
    if (
      entityType === 'article' &&
      referenceKind === SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    ) {
      if (this.localEviction.isEvicted(
        syncSpaceId,
        'article',
        entitySyncId,
        entityGeneration,
        referenceKind
      )) return false
      return this.aliases.resolveMapping(
        syncSpaceId,
        'article',
        entitySyncId,
        entityGeneration
      ) != null
    }
    return this.canApplyWithoutBlob(entityType, referenceKind)
  }

  persistFetchedBlob(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    referenceKind: string,
    manifest: SyncBlobManifest,
    bytes: Uint8Array
  ): void {
    if (entityType === 'article') {
      this.localBlobStore?.putVerified(manifest.hash, bytes)
      return
    }
    if (this.aiHistory?.owns(entityType)) {
      this.aiHistory.persistFetchedBlob(
        syncSpaceId,
        entityType,
        entitySyncId,
        entityGeneration,
        referenceKind,
        manifest.hash,
        bytes
      )
      return
    }
    throw new SyncApplyDeferredError('No Blob materializer for entity type ' + entityType)
  }

  persistAndMaterializeFetchedBlob(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    referenceKind: string,
    manifest: SyncBlobManifest,
    bytes: Uint8Array
  ): void {
    if (!this.blobs.isCurrentReference(syncSpaceId, entityType, entitySyncId, entityGeneration, referenceKind, manifest.hash)) {
      this.localBlobStore?.putVerified(manifest.hash, bytes)
      return
    }
    this.persistFetchedBlob(
      syncSpaceId,
      entityType,
      entitySyncId,
      entityGeneration,
      referenceKind,
      manifest,
      bytes
    )
    if (
      entityType !== 'article' ||
      referenceKind !== SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    ) return
    const binding = this.database.prepare(
      'SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1'
    ).get(syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding for Blob refill')
    const mapping = this.aliases.resolveMapping(
      syncSpaceId,
      'article',
      entitySyncId,
      entityGeneration
    )
    if (!mapping) throw new SyncApplyDeferredError('Missing Article mapping for Blob refill')
    this.materializeSnapshotArticleFullContent(
      syncSpaceId,
      entitySyncId,
      entityGeneration,
      binding.local_account_id,
      mapping.localId,
      manifest.hash
    )
  }

  materializeArticleBlobOwnersFromLocal(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    owners: ReadonlyArray<{
      ownerEntityType: string
      ownerEntitySyncId: string
      ownerEntityGeneration: number
      referenceKind: string
    }>
  ): void {
    const articleOwners = owners.filter((owner) =>
      owner.ownerEntityType === 'article' &&
      owner.referenceKind === SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND &&
      this.blobs.isCurrentReference(
        syncSpaceId,
        owner.ownerEntityType,
        owner.ownerEntitySyncId,
        owner.ownerEntityGeneration,
        owner.referenceKind,
        manifest.hash
      )
    )
    if (!articleOwners.length) return
    const bytes = this.localBlobStore?.readVerified(manifest.hash) ?? null
    if (!bytes || bytes.byteLength !== manifest.totalBytes) {
      this.blobs.markMissing(manifest.hash)
      return
    }
    const binding = this.database.prepare(
      'SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1'
    ).get(syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding for Blob refill')
    const content = Buffer.from(bytes).toString('utf8')
    this.blobs.markReadyVerified(manifest.hash, bytes.byteLength)
    for (const owner of articleOwners) {
      if (this.localEviction.isEvicted(
        syncSpaceId,
        'article',
        owner.ownerEntitySyncId,
        owner.ownerEntityGeneration,
        SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
      )) continue
      const mapping = this.aliases.resolveMapping(
        syncSpaceId,
        'article',
        owner.ownerEntitySyncId,
        owner.ownerEntityGeneration
      )
      if (!mapping) throw new SyncApplyDeferredError('Missing Article mapping for Blob refill')
      this.database.prepare(
        'UPDATE articles SET full_content_html=?,updated_at=? WHERE id=? AND account_id=?'
      ).run(content, Date.now(), mapping.localId, binding.local_account_id)
    }
  }

  /**
   * 应用远端同步操作至本地 SQLite 数据库。
   *
   * @param operation 待应用的同步操作记录
   * @throws SyncApplyDeferredError 当本地前置映射或依赖实体缺失时抛出
   */
  apply(operation: SyncOperationRecord): void {
    if (operation.schemaVersion !== 1 || operation.payloadSchemaVersion !== 1) {
      throw new SyncApplyDeferredError('Unsupported operation schema; retained for a compatible client')
    }
    if (operation.entityType === 'alias_edge') {
      if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('alias_edge only supports UPSERT')
      this.aliases.applyEdge(
        operation.syncSpaceId,
        parsePayload(operation.payloadJson) as unknown as SyncAliasEdgePayloadV1,
        operation.operationId
      )
      return
    }
    if (operation.entityType === 'filter_rule') {
      this.applyFilterRule(operation)
      return
    }
    if (operation.entityType === 'website_rule') {
      this.applyWebsiteRule(operation)
      return
    }
    if (operation.entityType === 'json_rule') {
      this.applyJsonRule(operation)
      return
    }
    if (operation.entityType === 'rsshub_settings') {
      this.applyRssHubSettings(operation)
      return
    }
    if (operation.entityType === 'website_parse_preference') {
      this.applyWebsiteParsePreference(operation)
      return
    }
    if (operation.entityType === 'rsshub_subscription_source') {
      this.applyRssHubSubscriptionSource(operation)
      return
    }
    if (operation.entityType === 'group') {
      this.applyGroup(operation)
      return
    }
    if (operation.entityType === 'feed') {
      this.applyFeed(operation)
      return
    }
    if (operation.entityType === 'article') {
      this.applyArticle(operation)
      return
    }
    if (this.aiHistory?.owns(operation.entityType)) {
      this.aiHistory.apply(operation)
      return
    }
    if (operation.operationType === 'RELATION_SET') {
      this.applyRelation(operation)
      return
    }
    throw new SyncApplyDeferredError(`Entity projection unavailable: ${operation.entityType}`)
  }

  private applyFilterRule(operation: SyncOperationRecord): void {
    if (!this.articleFilters) throw new SyncApplyDeferredError('Filter rule repository unavailable')
    let mapping = this.identities.findBySyncId(operation.syncSpaceId, 'filter_rule', operation.entitySyncId)
    if (mapping && mapping.generation > operation.entityGeneration) return
    const tombstone = this.database.prepare('SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?')
      .get(operation.syncSpaceId, 'filter_rule', operation.entitySyncId) as { generation: number } | undefined
    if (tombstone && tombstone.generation >= operation.entityGeneration) {
      if (operation.operationType === 'GLOBAL_DELETE' && mapping) {
        this.articleFilters.delete(mapping.localId)
      }
      return
    }
    const now = Date.now()
    if (!mapping) {
      mapping = { syncSpaceId: operation.syncSpaceId, entityType: 'filter_rule',
        localId: sha256Hex(`filter:${operation.syncSpaceId}:${operation.entitySyncId}`), syncId: operation.entitySyncId,
        canonicalKey: null, generation: operation.entityGeneration, createdAt: now, updatedAt: now }
      this.identities.insertMapping(mapping)
    } else if (mapping.generation < operation.entityGeneration) {
      mapping = { ...mapping, generation: operation.entityGeneration, updatedAt: now }
      this.identities.updateMappings([mapping])
    }
    if (operation.operationType === 'GLOBAL_DELETE') {
      this.articleFilters.delete(mapping.localId)
      this.state.recordTombstone(operation.syncSpaceId, 'filter_rule', operation.entitySyncId,
        operation.entityGeneration, SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence), now,
        operation.operationId)
      return
    }
    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET' ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? payload.fields ?? payload : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SyncApplyDeferredError('Unsupported filter rule mutation')
    const current = this.articleFilters.getById(mapping.localId)
    const values: Record<string, unknown> = { ...current }
    for (const [field, value] of Object.entries(fields)) {
      this.applyField(operation, field, value)
      const winner = this.state.findFieldVersion(operation.syncSpaceId, 'filter_rule', operation.entitySyncId, field)
      if (winner) values[field] = JSON.parse(winner.valueJson)
    }
    const retained = (field: string): unknown => {
      if (Object.prototype.hasOwnProperty.call(values, field)) return values[field]
      const winner = this.state.findFieldVersion(
        operation.syncSpaceId,
        'filter_rule',
        operation.entitySyncId,
        field
      )
      return winner?.entityGeneration === mapping!.generation
        ? JSON.parse(winner.valueJson)
        : undefined
    }
    let feedId = current?.feedId ?? null
    const retainedFeedSyncId = retained('feedSyncId')
    if (retainedFeedSyncId !== undefined) {
      if (retainedFeedSyncId == null) {
        feedId = null
      } else {
        const feedSyncIdVersion = this.state.findFieldVersion(
          operation.syncSpaceId,
          'filter_rule',
          operation.entitySyncId,
          'feedSyncId'
        )
        const feedGeneration = feedSyncIdVersion?.entityGeneration === mapping.generation
          ? this.pairedGenerationForWinner(operation, 'feedGeneration', feedSyncIdVersion.versionToken)
          : null
        const resolvedFeedId = this.resolveFeedScopedConfigParent(
          operation.syncSpaceId,
          String(retainedFeedSyncId),
          feedGeneration,
          'Filter rule ' + operation.entitySyncId
        )
        if (resolvedFeedId == null) {
          this.articleFilters.delete(mapping.localId)
          return
        }
        feedId = resolvedFeedId
      }
    }
    if (typeof values.keyword !== 'string') throw new SyncApplyDeferredError('Missing filter rule keyword')
    if (values.type !== undefined && values.type !== 'KEYWORD' && values.type !== 'REGEX') throw new SyncApplyDeferredError('Unsupported filter rule type')
    this.articleFilters.upsert({ id: mapping.localId, keyword: values.keyword, feedId,
      feedName: typeof values.feedName === 'string' ? values.feedName : null,
      type: values.type === 'REGEX' ? 'REGEX' : 'KEYWORD', enabled: values.enabled !== false })
  }

  private applyWebsiteRule(operation: SyncOperationRecord): void {
    if (!this.websiteRules) throw new SyncApplyDeferredError('Website rule repository unavailable')
    this.applyAtomicConfigRule<WebsiteRule>(
      operation,
      'website_rule',
      () => this.websiteRules!.listSyncRules(),
      (rules) => this.websiteRules!.replaceSyncRules(rules)
    )
  }

  private applyJsonRule(operation: SyncOperationRecord): void {
    if (!this.jsonRules) throw new SyncApplyDeferredError('JSON rule repository unavailable')
    this.applyAtomicConfigRule<JsonRule>(
      operation,
      'json_rule',
      () => this.jsonRules!.listSyncRules(),
      (rules) => this.jsonRules!.replaceSyncRules(rules)
    )
  }

  private applyAtomicConfigRule<T extends { id: string }>(
    operation: SyncOperationRecord,
    entityType: 'website_rule' | 'json_rule',
    read: () => T[],
    replace: (values: T[]) => unknown
  ): void {
    let mapping = this.identities.findBySyncId(operation.syncSpaceId, entityType, operation.entitySyncId)
    if (mapping && mapping.generation > operation.entityGeneration) return
    const tombstone = this.database.prepare(
      'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?'
    ).get(operation.syncSpaceId, entityType, operation.entitySyncId) as { generation: number } | undefined
    if (tombstone && tombstone.generation >= operation.entityGeneration) {
      if (operation.operationType === 'GLOBAL_DELETE' && mapping) {
        replace(read().filter((value) => value.id !== mapping!.localId))
      }
      return
    }
    const now = Date.now()

    if (operation.operationType === 'GLOBAL_DELETE') {
      if (mapping) replace(read().filter((value) => value.id !== mapping!.localId))
      this.state.recordTombstone(
        operation.syncSpaceId,
        entityType,
        operation.entitySyncId,
        operation.entityGeneration,
        SyncVersionToken.operation(
          operation.actorIncarnationId,
          operation.replicationLaneId,
          operation.sequence
        ),
        now,
        operation.operationId
      )
      return
    }

    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? payload.fields ?? payload : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !('rule' in fields)) {
      throw new SyncApplyDeferredError('Unsupported CONFIG rule mutation')
    }
    this.applyField(operation, 'rule', (fields as Record<string, unknown>).rule)
    const winner = this.state.findFieldVersion(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId,
      'rule'
    )
    if (!winner) throw new SyncApplyDeferredError('CONFIG rule winner is unavailable')
    let decoded: T
    try {
      decoded = JSON.parse(winner.valueJson) as T
    } catch (error) {
      throw new SyncApplyDeferredError(
        'Invalid ' + entityType + ' payload: ' + (error instanceof Error ? error.message : String(error))
      )
    }
    if (!decoded || typeof decoded.id !== 'string' || !decoded.id.trim()) {
      throw new SyncApplyDeferredError('CONFIG rule payload has no id')
    }
    const expectedSyncId = configRuleSyncId(entityType, decoded.id)
    if (expectedSyncId !== operation.entitySyncId) {
      throw new Error('CONFIG identity mismatch for ' + entityType + '/' + decoded.id)
    }
    if (!mapping) {
      mapping = {
        syncSpaceId: operation.syncSpaceId,
        entityType,
        localId: decoded.id,
        syncId: operation.entitySyncId,
        canonicalKey: null,
        generation: operation.entityGeneration,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
    } else {
      if (mapping.localId !== decoded.id) {
        throw new Error('CONFIG mapping localId mismatch for ' + entityType)
      }
      if (mapping.generation < operation.entityGeneration) {
        mapping = { ...mapping, generation: operation.entityGeneration, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
    }
    replace([...read().filter((value) => value.id !== decoded.id), decoded])
  }

  private applyRssHubSettings(operation: SyncOperationRecord): void {
    if (!this.rssHubSettings) throw new SyncApplyDeferredError('RSSHub settings repository unavailable')
    const entityType = 'rsshub_settings' as const
    const expectedSyncId = configRuleSyncId(entityType, 'rsshub-settings')
    if (operation.entitySyncId !== expectedSyncId) {
      throw new Error('RSSHub settings Sync identity mismatch')
    }
    if (operation.operationType === 'GLOBAL_DELETE') {
      throw new SyncApplyDeferredError('RSSHub settings cannot be globally deleted')
    }
    let mapping = this.identities.findBySyncId(operation.syncSpaceId, entityType, operation.entitySyncId)
    if (mapping && mapping.generation > operation.entityGeneration) return
    const now = Date.now()
    if (!mapping) {
      mapping = {
        syncSpaceId: operation.syncSpaceId,
        entityType,
        localId: 'rsshub-settings',
        syncId: operation.entitySyncId,
        canonicalKey: null,
        generation: operation.entityGeneration,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
    } else {
      if (mapping.localId !== 'rsshub-settings') throw new Error('RSSHub settings mapping localId mismatch')
      if (mapping.generation < operation.entityGeneration) {
        mapping = { ...mapping, generation: operation.entityGeneration, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
    }
    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? payload.fields ?? payload : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !('settings' in fields)) {
      throw new SyncApplyDeferredError('Unsupported RSSHub settings mutation')
    }
    this.applyField(operation, 'settings', (fields as Record<string, unknown>).settings)
    const winner = this.state.findFieldVersion(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId,
      'settings'
    )
    if (!winner) throw new SyncApplyDeferredError('RSSHub settings winner is unavailable')
    let settings: RssHubSettings
    try {
      settings = JSON.parse(winner.valueJson) as RssHubSettings
    } catch (error) {
      throw new SyncApplyDeferredError(
        'Invalid RSSHub settings payload: ' + (error instanceof Error ? error.message : String(error))
      )
    }
    this.rssHubSettings.replaceSyncSettings(settings)
  }

  private applyWebsiteParsePreference(operation: SyncOperationRecord): void {
    if (!this.websiteParsePreferences) {
      throw new SyncApplyDeferredError('Website parse preference repository unavailable')
    }
    const entityType = 'website_parse_preference' as const
    let mapping = this.identities.findBySyncId(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId
    )
    if (mapping && mapping.generation > operation.entityGeneration) return
    const tombstone = this.database.prepare(
      'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?'
    ).get(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId
    ) as { generation: number } | undefined
    if (tombstone && tombstone.generation >= operation.entityGeneration) {
      if (operation.operationType === 'GLOBAL_DELETE' && mapping) {
        const feedMapping = this.identities.findBySyncId(
          operation.syncSpaceId,
          'feed',
          mapping.localId
        )
        if (feedMapping) {
          this.websiteParsePreferences.applyUserSyncState(feedMapping.localId, null)
        }
      }
      return
    }

    const now = Date.now()
    if (operation.operationType === 'GLOBAL_DELETE') {
      if (mapping) {
        const feedMapping = this.identities.findBySyncId(
          operation.syncSpaceId,
          'feed',
          mapping.localId
        )
        if (feedMapping) {
          this.websiteParsePreferences.applyUserSyncState(feedMapping.localId, null)
        }
      }
      this.state.recordTombstone(
        operation.syncSpaceId,
        entityType,
        operation.entitySyncId,
        operation.entityGeneration,
        SyncVersionToken.operation(
          operation.actorIncarnationId,
          operation.replicationLaneId,
          operation.sequence
        ),
        now,
        operation.operationId
      )
      return
    }

    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? payload.fields ?? payload : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !('preference' in fields)) {
      throw new SyncApplyDeferredError('Unsupported website parse preference mutation')
    }

    this.applyField(
      operation,
      'preference',
      (fields as Record<string, unknown>).preference
    )
    const winner = this.state.findFieldVersion(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId,
      'preference'
    )
    if (!winner) {
      throw new SyncApplyDeferredError('Website parse preference winner is unavailable')
    }

    let raw: Record<string, unknown>
    try {
      const decoded = JSON.parse(winner.valueJson) as unknown
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('preference is not an object')
      }
      raw = decoded as Record<string, unknown>
    } catch (error) {
      throw new SyncApplyDeferredError(
        'Invalid website parse preference payload: ' +
          (error instanceof Error ? error.message : String(error))
      )
    }
    const feedSyncId = typeof raw.feedSyncId === 'string' ? raw.feedSyncId : ''
    if (!feedSyncId) {
      throw new SyncApplyDeferredError('Website parse preference payload has no feedSyncId')
    }
    const feedGeneration = raw.feedGeneration == null ? null : Number(raw.feedGeneration)
    const expectedSyncId = configRuleSyncId(entityType, feedSyncId)
    if (operation.entitySyncId !== expectedSyncId) {
      throw new Error('Website parse preference Sync identity mismatch')
    }
    const localFeedId = this.resolveFeedScopedConfigParent(
      operation.syncSpaceId,
      feedSyncId,
      feedGeneration,
      'Website parse preference ' + operation.entitySyncId
    )
    if (localFeedId == null) return

    if (!mapping) {
      mapping = {
        syncSpaceId: operation.syncSpaceId,
        entityType,
        localId: feedSyncId,
        syncId: operation.entitySyncId,
        canonicalKey: null,
        generation: operation.entityGeneration,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
    } else {
      if (mapping.localId !== feedSyncId) {
        throw new Error('Website parse preference mapping localId mismatch')
      }
      if (mapping.generation < operation.entityGeneration) {
        mapping = { ...mapping, generation: operation.entityGeneration, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
    }

    if (raw.__syncAbsent === true) {
      this.websiteParsePreferences.applyUserSyncState(localFeedId, null)
    } else {
      const preference: WebsiteParsePreferenceUserSyncState = {
        dynamicRenderingEnabled: raw.dynamicRenderingEnabled === true,
        preferredRuleId: typeof raw.preferredRuleId === 'string' ? raw.preferredRuleId : null,
        preferredRuleName: typeof raw.preferredRuleName === 'string' ? raw.preferredRuleName : null
      }
      this.websiteParsePreferences.applyUserSyncState(localFeedId, preference)
    }
  }

  private applyRssHubSubscriptionSource(operation: SyncOperationRecord): void {
    const entityType = 'rsshub_subscription_source' as const
    let mapping = this.identities.findBySyncId(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId
    )
    if (mapping && mapping.generation > operation.entityGeneration) return
    const tombstone = this.database.prepare(
      'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?'
    ).get(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId
    ) as { generation: number } | undefined
    if (tombstone && tombstone.generation >= operation.entityGeneration) {
      if (operation.operationType === 'GLOBAL_DELETE' && mapping) {
        const feedMapping = this.identities.findBySyncId(
          operation.syncSpaceId,
          'feed',
          mapping.localId
        )
        if (feedMapping) {
          this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?')
            .run(feedMapping.localId)
        }
      }
      return
    }

    const now = Date.now()
    if (operation.operationType === 'GLOBAL_DELETE') {
      if (mapping) {
        const feedMapping = this.identities.findBySyncId(
          operation.syncSpaceId,
          'feed',
          mapping.localId
        )
        if (feedMapping) {
          this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?')
            .run(feedMapping.localId)
        }
      }
      this.state.recordTombstone(
        operation.syncSpaceId,
        entityType,
        operation.entitySyncId,
        operation.entityGeneration,
        SyncVersionToken.operation(
          operation.actorIncarnationId,
          operation.replicationLaneId,
          operation.sequence
        ),
        now,
        operation.operationId
      )
      return
    }

    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? payload.fields ?? payload : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !('source' in fields)) {
      throw new SyncApplyDeferredError('Unsupported RSSHub subscription source mutation')
    }
    this.applyField(
      operation,
      'source',
      (fields as Record<string, unknown>).source
    )
    const winner = this.state.findFieldVersion(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId,
      'source'
    )
    if (!winner) {
      throw new SyncApplyDeferredError('RSSHub subscription source winner is unavailable')
    }

    let raw: Record<string, unknown>
    try {
      const decoded = JSON.parse(winner.valueJson) as unknown
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('source is not an object')
      }
      raw = decoded as Record<string, unknown>
    } catch (error) {
      throw new SyncApplyDeferredError(
        'Invalid RSSHub subscription source payload: ' +
          (error instanceof Error ? error.message : String(error))
      )
    }
    const feedSyncId = typeof raw.feedSyncId === 'string' ? raw.feedSyncId.trim() : ''
    const feedGeneration = raw.feedGeneration == null ? null : Number(raw.feedGeneration)
    const isAbsent = raw.__syncAbsent === true
    const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : ''
    if (!feedSyncId || (!isAbsent && !sourceUrl)) {
      throw new SyncApplyDeferredError(
        'RSSHub subscription source requires feedSyncId and sourceUrl'
      )
    }
    const expectedSyncId = configRuleSyncId(entityType, feedSyncId)
    if (operation.entitySyncId !== expectedSyncId) {
      throw new Error('RSSHub subscription source Sync identity mismatch')
    }
    const localFeedId = this.resolveFeedScopedConfigParent(
      operation.syncSpaceId,
      feedSyncId,
      feedGeneration,
      'RSSHub subscription source ' + operation.entitySyncId
    )
    if (localFeedId == null) return

    if (!mapping) {
      mapping = {
        syncSpaceId: operation.syncSpaceId,
        entityType,
        localId: feedSyncId,
        syncId: operation.entitySyncId,
        canonicalKey: null,
        generation: operation.entityGeneration,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
    } else {
      if (mapping.localId !== feedSyncId) {
        throw new Error('RSSHub subscription source mapping localId mismatch')
      }
      if (mapping.generation < operation.entityGeneration) {
        mapping = { ...mapping, generation: operation.entityGeneration, updatedAt: now }
        this.identities.updateMappings([mapping])
      }
    }
    if (isAbsent) {
      this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?').run(localFeedId)
    } else {
      this.database.prepare(`
        INSERT INTO rsshub_source_urls(feed_id,source_url)
        VALUES(?,?)
        ON CONFLICT(feed_id) DO UPDATE SET source_url=excluded.source_url
      `).run(localFeedId, sourceUrl)
    }
  }

  private applyGroup(operation: SyncOperationRecord): void {
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=?')
      .get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')

    const tombstone = this.database.prepare('SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?')
      .get(operation.syncSpaceId, 'group', operation.entitySyncId) as { generation: number } | undefined
    if (tombstone && operation.entityGeneration <= tombstone.generation) {
      if (operation.operationType === 'GLOBAL_DELETE') {
        this.aliases.applyGlobalDelete(operation)
      }
      return
    }

    if (operation.operationType === 'GLOBAL_DELETE') {
      const mapping = this.aliases.resolveMapping(
        operation.syncSpaceId,
        'group',
        operation.entitySyncId,
        operation.entityGeneration
      )
      if (mapping) {
        const dependent = this.database.prepare(
          'SELECT 1 FROM feeds WHERE account_id=? AND group_id=? LIMIT 1'
        ).get(binding.local_account_id, mapping.localId)
        if (dependent) {
          throw new SyncApplyDeferredError('Group delete is waiting for dependent Feed deletes')
        }
      }
      this.aliases.applyGlobalDelete(operation)
      return
    }

    const payload = parsePayload(operation.payloadJson)
    const fields = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT' ? (payload.fields ?? payload) : null
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SyncApplyDeferredError('Group operation projection unavailable')
    const values = fields as Record<string, unknown>
    if (Object.keys(values).length !== 1 || typeof values.name !== 'string') throw new SyncApplyDeferredError('Group payload requires a string name')

    const mapping = this.aliases.resolveMapping(
      operation.syncSpaceId, 'group', operation.entitySyncId, operation.entityGeneration
    )
    const group = mapping ? this.database.prepare('SELECT id,account_id FROM groups WHERE id=?').get(mapping.localId) as
      { id: string; account_id: number } | undefined : undefined
    if (group && group.account_id !== binding.local_account_id) throw new Error('Group belongs to another account')
    if (!group && operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('Missing group row')

    this.applyField(operation, 'name', values.name)
    const current = this.state.findFieldVersion(operation.syncSpaceId, 'group', operation.entitySyncId, 'name')
    if (!current) throw new SyncApplyDeferredError('Missing group field version')
    const name = JSON.parse(current.valueJson) as string

    if (group) {
      this.database.prepare('UPDATE groups SET name=? WHERE id=? AND account_id=?').run(name, group.id, binding.local_account_id)
    } else {
      const localId = mapping?.localId ?? randomUUID()
      this.database.prepare('INSERT INTO groups(id,account_id,name) VALUES(?,?,?)').run(localId, binding.local_account_id, name)
      if (!mapping) {
        this.identities.insertMapping({
          syncSpaceId: operation.syncSpaceId,
          entityType: 'group',
          localId,
          syncId: operation.entitySyncId,
          canonicalKey: null,
          generation: operation.entityGeneration,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
      }
    }
  }

  /**
   * 处理 Feed 订阅源的业务投影（创建、修改各属性、删除）。
   *
   * 依赖检查：若 Feed 依赖的分组在本地尚无映射，必须抛出 SyncApplyDeferredError。
   */
  private applyFeed(operation: SyncOperationRecord): void {
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=?')
      .get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')

    const tombstone = this.database.prepare('SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?')
      .get(operation.syncSpaceId, 'feed', operation.entitySyncId) as { generation: number } | undefined
    if (tombstone && operation.entityGeneration <= tombstone.generation) {
      if (operation.operationType === 'GLOBAL_DELETE') {
        this.aliases.applyGlobalDelete(operation)
      }
      return
    }

    if (operation.operationType === 'GLOBAL_DELETE') {
      const mapping = this.aliases.resolveMapping(
        operation.syncSpaceId,
        'feed',
        operation.entitySyncId,
        operation.entityGeneration
      )
      if (mapping) {
        const dependent = this.database.prepare(
          'SELECT 1 FROM articles WHERE account_id=? AND feed_id=? LIMIT 1'
        ).get(binding.local_account_id, mapping.localId)
        if (dependent) {
          throw new SyncApplyDeferredError('Feed delete is waiting for dependent Article deletes')
        }
      }
      this.aliases.applyGlobalDelete(operation)
      if (mapping) {
        this.articleFilters?.deleteByFeed(mapping.localId)
        this.websiteParsePreferences?.delete(mapping.localId)
      }
      return
    }

    if (operation.operationType === 'RELATION_SET') {
      this.applyRelation(operation)
      return
    }

    const payload = parsePayload(operation.payloadJson)
    const fieldMap: Record<string, unknown> = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : operation.operationType === 'UPSERT'
        ? (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields) ? payload.fields as Record<string, unknown> : payload)
        : {}
    if (typeof fieldMap.sourceType === 'string') {
      const normalized = fieldMap.sourceType.trim().toLowerCase()
      if (!['rss', 'website', 'json'].includes(normalized)) {
        throw new SyncApplyDeferredError('Unsupported Feed sourceType')
      }
      fieldMap.sourceType = normalized
    }

    const mapping = this.aliases.resolveMapping(
      operation.syncSpaceId, 'feed', operation.entitySyncId, operation.entityGeneration
    )
    const existingFeed = mapping ? this.database.prepare('SELECT * FROM feeds WHERE id=? AND account_id=?').get(mapping.localId, binding.local_account_id) as Record<string, unknown> | undefined : undefined
    if (!existingFeed && operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('Missing feed row for update')

    // 依赖 Group 检查
    const groupSyncId = typeof fieldMap.groupSyncId === 'string' ? fieldMap.groupSyncId : typeof fieldMap.groupId === 'string' ? fieldMap.groupId : null
    const groupGeneration = fieldMap.groupGeneration == null ? null : Number(fieldMap.groupGeneration)
    if (groupGeneration != null && (!Number.isSafeInteger(groupGeneration) || groupGeneration < 0)) {
      throw new SyncApplyDeferredError('Feed has invalid groupGeneration')
    }
    if (groupGeneration != null && !groupSyncId) {
      throw new SyncApplyDeferredError('Feed groupGeneration requires groupSyncId')
    }
    let targetLocalGroupId: string | null = existingFeed
      ? String(existingFeed.group_id)
      : (this.database.prepare('SELECT id FROM groups WHERE account_id=? LIMIT 1')
          .get(binding.local_account_id) as { id: string } | undefined)?.id ?? null
    if (!targetLocalGroupId) throw new SyncApplyDeferredError('No local group available for feed')

    // 记录并解析各字段胜出值
    if (groupGeneration != null) this.applyField(operation, 'groupGeneration', groupGeneration)
    if (groupSyncId) this.applyField(operation, 'groupSyncId', groupSyncId)
    for (const [field, value] of Object.entries(fieldMap)) {
      if (field === 'field' || field === 'value' || field === 'groupSyncId' ||
          field === 'groupId' || field === 'groupGeneration') continue
      this.applyField(operation, field, value)
    }

    const resolveField = (name: string, fallback: unknown): unknown => {
      const v = this.state.findFieldVersion(operation.syncSpaceId, 'feed', operation.entitySyncId, name)
      return v ? JSON.parse(v.valueJson) : fallback
    }

    const winningGroupVersion = this.state.findFieldVersion(
      operation.syncSpaceId,
      'feed',
      operation.entitySyncId,
      'groupSyncId'
    )
    const winningGroupSyncId = winningGroupVersion
      ? JSON.parse(winningGroupVersion.valueJson)
      : groupSyncId
    if (typeof winningGroupSyncId === 'string') {
      const winningGroupGeneration = winningGroupVersion
        ? this.pairedGenerationForWinner(operation, 'groupGeneration', winningGroupVersion.versionToken)
        : groupGeneration
      const winningLocalGroupId = this.resolveGroupParent(
        operation.syncSpaceId,
        winningGroupSyncId,
        winningGroupGeneration,
        'Feed ' + operation.entitySyncId
      )
      if (winningLocalGroupId == null) {
        if (!existingFeed) return
      } else {
        const winningGroup = this.database.prepare('SELECT id FROM groups WHERE id=? AND account_id=?')
          .get(winningLocalGroupId, binding.local_account_id)
        if (!winningGroup) throw new SyncApplyDeferredError('Missing winning group')
        targetLocalGroupId = winningLocalGroupId
      }
    }

    const feedName = String(resolveField('name', resolveField('title', existingFeed?.name ?? 'Feed')))
    const feedUrl = String(resolveField('url', existingFeed?.url ?? 'about:blank'))
    const icon = resolveField('icon', existingFeed?.icon ?? null) as string | null
    const sourceType = String(resolveField('sourceType', existingFeed?.source_type ?? 'rss')).trim().toLowerCase()
    if (!['rss', 'website', 'json'].includes(sourceType)) {
      throw new SyncApplyDeferredError('Unsupported Feed sourceType')
    }
    const isNotification = Boolean(resolveField('isNotification', existingFeed?.is_notification === 1)) ? 1 : 0
    const isFullContent = Boolean(resolveField('isFullContent', existingFeed?.is_full_content === 1)) ? 1 : 0
    const isBrowser = Boolean(resolveField('isBrowser', existingFeed?.is_browser === 1)) ? 1 : 0

    const now = Date.now()
    if (!existingFeed) {
      const localId = mapping?.localId ?? randomUUID()
      this.database.prepare(`
        INSERT INTO feeds(id,account_id,group_id,name,url,source_type,icon,is_notification,is_full_content,is_browser,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(localId, binding.local_account_id, targetLocalGroupId, feedName, feedUrl, sourceType, icon, isNotification, isFullContent, isBrowser, now, now)

      if (!mapping) {
        this.identities.insertMapping({
          syncSpaceId: operation.syncSpaceId,
          entityType: 'feed',
          localId,
          syncId: operation.entitySyncId,
          canonicalKey: feedCanonicalKey(sourceType as 'rss' | 'website' | 'json', feedUrl),
          generation: operation.entityGeneration,
          createdAt: now,
          updatedAt: now
        })
      }
    } else {
      this.database.prepare(`
        UPDATE feeds SET name=?,group_id=?,url=?,source_type=?,icon=?,is_notification=?,is_full_content=?,is_browser=?,updated_at=?
        WHERE id=? AND account_id=?
      `).run(feedName, targetLocalGroupId, feedUrl, sourceType, icon, isNotification, isFullContent, isBrowser, now, String(existingFeed.id), binding.local_account_id)
    }
  }

  /** Materialize Article metadata/state. A new Article may arrive entirely through Operations. */
  private applyArticle(operation: SyncOperationRecord): void {
    const binding = this.database.prepare(
      'SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1'
    ).get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')

    const tombstone = this.database.prepare(
      'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
    ).get(operation.syncSpaceId, 'article', operation.entitySyncId) as { generation: number } | undefined
    if (tombstone && operation.entityGeneration <= tombstone.generation) {
      if (operation.operationType === 'GLOBAL_DELETE') {
        this.aliases.applyGlobalDelete(operation)
      }
      return
    }

    if (operation.operationType === 'GLOBAL_DELETE') {
      this.aliases.applyGlobalDelete(operation)
      return
    }

    const payload = parsePayload(operation.payloadJson)
    let fields: Record<string, unknown>
    if (operation.operationType === 'FIELD_SET') {
      const field = typeof payload.field === 'string' ? payload.field : ''
      if (!field) throw new SyncApplyDeferredError('FIELD_SET requires a non-empty field')
      if (field === SYNC_ARTICLE_FULL_CONTENT_FIELD) {
        this.applyArticleFullContent(operation, payload.value)
        return
      }
      fields = { [field]: payload.value }
    } else if (operation.operationType === 'UPSERT') {
      fields = payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
        ? payload.fields as Record<string, unknown>
        : payload
    } else if (operation.operationType === 'RELATION_SET') {
      this.applyRelation(operation)
      return
    } else {
      throw new SyncApplyDeferredError(`Unsupported Article mutation type: ${operation.operationType}`)
    }

    const mapping = this.aliases.resolveMapping(
      operation.syncSpaceId, 'article', operation.entitySyncId, operation.entityGeneration
    )
    let article = mapping
      ? this.database.prepare('SELECT * FROM articles WHERE id=? AND account_id=? LIMIT 1')
          .get(mapping.localId, binding.local_account_id) as Record<string, unknown> | undefined
      : undefined
    let createdArticle = false
    const feedGeneration = fields.feedGeneration == null ? null : Number(fields.feedGeneration)
    if (feedGeneration != null && (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0)) {
      throw new SyncApplyDeferredError('Article has invalid feedGeneration')
    }
    const incomingFeedSyncId = typeof fields.feedSyncId === 'string' ? fields.feedSyncId : null
    if (feedGeneration != null && !incomingFeedSyncId) {
      throw new SyncApplyDeferredError('Article feedGeneration requires feedSyncId')
    }
    if (feedGeneration != null) this.applyField(operation, 'feedGeneration', feedGeneration)

    if (!article) {
      if (operation.operationType !== 'UPSERT') {
        throw new SyncApplyDeferredError('Missing article row for update')
      }
      const feedSyncId = incomingFeedSyncId
      if (!feedSyncId) throw new SyncApplyDeferredError('New Article UPSERT requires feedSyncId')
      const localFeedId = this.resolveFeedScopedConfigParent(
        operation.syncSpaceId,
        feedSyncId,
        feedGeneration,
        'Article ' + operation.entitySyncId
      )
      if (localFeedId == null) return
      const feedMapping = this.identities.findBySyncId(operation.syncSpaceId, 'feed', feedSyncId)
      if (!feedMapping) {
        throw new SyncApplyDeferredError('Missing dependent feed mapping for Article ' + operation.entitySyncId)
      }
      const feed = this.database.prepare('SELECT id FROM feeds WHERE id=? AND account_id=? LIMIT 1')
        .get(localFeedId, binding.local_account_id) as { id: string } | undefined
      if (!feed) throw new SyncApplyDeferredError('Missing dependent feed row ' + localFeedId)

      const now = Date.now()
      const localId = mapping?.localId ?? randomUUID()
      const title = typeof fields.title === 'string' ? fields.title : 'Article'
      const url = typeof fields.url === 'string' ? fields.url : ''
      const author = typeof fields.author === 'string' ? fields.author : null
      const publishedAt = Number.isSafeInteger(Number(fields.publishedAt))
        ? Number(fields.publishedAt)
        : now
      const description = typeof fields.description === 'string' ? fields.description : ''
      const contentHtml = typeof fields.contentHtml === 'string' ? fields.contentHtml : ''
      const imageUrl = typeof fields.imageUrl === 'string' ? fields.imageUrl : null
      const isUnread = fields.isUnread === false ? 0 : 1
      const isStarred = fields.isStarred === true ? 1 : 0
      const isReadLater = fields.isReadLater === true ? 1 : 0
      this.database.prepare(`
        INSERT INTO articles(
          id,account_id,feed_id,title,url,author,published_at,description,content_html,
          full_content_html,image_url,is_unread,is_starred,is_read_later,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)
      `).run(
        localId,
        binding.local_account_id,
        feed.id,
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
        now,
        now
      )
      if (!mapping) {
        this.identities.insertMapping({
          syncSpaceId: operation.syncSpaceId,
          entityType: 'article',
          localId,
          syncId: operation.entitySyncId,
          canonicalKey: articleCanonicalKey(feedMapping.canonicalKey, url),
          generation: operation.entityGeneration,
          createdAt: now,
          updatedAt: now
        })
      }
      article = this.database.prepare('SELECT * FROM articles WHERE id=? AND account_id=? LIMIT 1')
        .get(localId, binding.local_account_id) as Record<string, unknown> | undefined
      if (!article) throw new SyncApplyDeferredError('Unable to materialize Article row')
      createdArticle = true
    }

    for (const [field, value] of Object.entries(fields)) {
      if (field === 'field' || field === 'value' || field === 'feedGeneration') continue
      this.applyArticleField(operation, field, value, !createdArticle)
    }
  }

  /** Apply one Article metadata/state field after the Article row/mapping exists. */
  private applyArticleField(
    operation: SyncOperationRecord,
    field: string,
    value: unknown,
    captureBaseline = true
  ): void {
    if (field === SYNC_ARTICLE_FULL_CONTENT_FIELD) {
      this.applyArticleFullContent(operation, value)
      return
    }
    if (![
      'feedSyncId',
      'title',
      'url',
      'author',
      'publishedAt',
      'description',
      'contentHtml',
      'imageUrl',
      'isUnread',
      'isStarred',
      'isReadLater'
    ].includes(field)) {
      throw new SyncApplyDeferredError(`Article field projection unavailable: ${field}`)
    }
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1')
      .get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')

    const mapping = this.aliases.resolveMapping(
      operation.syncSpaceId, 'article', operation.entitySyncId, operation.entityGeneration
    )
    if (!mapping) throw new SyncApplyDeferredError(`Missing article mapping for ${operation.entitySyncId}`)

    const article = this.database.prepare('SELECT * FROM articles WHERE id=? AND account_id=?')
      .get(mapping.localId, binding.local_account_id) as Record<string, unknown> | undefined
    if (!article) throw new SyncApplyDeferredError(`Missing article row for ${mapping.localId}`)

    this.applyField(operation, field, value, captureBaseline)
    const current = this.state.findFieldVersion(operation.syncSpaceId, 'article', operation.entitySyncId, field)
    if (!current) return

    const resolved = JSON.parse(current.valueJson) as unknown
    const now = Date.now()
    switch (field) {
      case 'feedSyncId': {
        if (typeof resolved !== 'string') throw new SyncApplyDeferredError('Invalid Article feedSyncId')
        const feedGeneration = this.pairedGenerationForWinner(
          operation,
          'feedGeneration',
          current.versionToken
        )
        const localFeedId = this.resolveFeedScopedConfigParent(
          operation.syncSpaceId,
          resolved,
          feedGeneration,
          'Article ' + operation.entitySyncId
        )
        if (localFeedId == null) return
        if (!this.database.prepare('SELECT 1 FROM feeds WHERE id=? AND account_id=?')
          .get(localFeedId, binding.local_account_id)) {
          throw new SyncApplyDeferredError('Missing winning Article feed')
        }
        this.database.prepare('UPDATE articles SET feed_id=?,updated_at=? WHERE id=? AND account_id=?')
          .run(localFeedId, now, mapping.localId, binding.local_account_id)
        break
      }
      case 'title':
        if (typeof resolved !== 'string') throw new SyncApplyDeferredError('Invalid Article title')
        this.database.prepare('UPDATE articles SET title=?,updated_at=? WHERE id=? AND account_id=?')
          .run(resolved, now, mapping.localId, binding.local_account_id)
        break
      case 'url':
        this.database.prepare('UPDATE articles SET url=?,updated_at=? WHERE id=? AND account_id=?')
          .run(typeof resolved === 'string' ? resolved : '', now, mapping.localId, binding.local_account_id)
        break
      case 'author':
        this.database.prepare('UPDATE articles SET author=?,updated_at=? WHERE id=? AND account_id=?')
          .run(typeof resolved === 'string' ? resolved : null, now, mapping.localId, binding.local_account_id)
        break
      case 'publishedAt':
        this.database.prepare('UPDATE articles SET published_at=?,updated_at=? WHERE id=? AND account_id=?')
          .run(Number.isSafeInteger(Number(resolved)) ? Number(resolved) : Number(article.published_at ?? now),
            now, mapping.localId, binding.local_account_id)
        break
      case 'description':
        this.database.prepare('UPDATE articles SET description=?,updated_at=? WHERE id=? AND account_id=?')
          .run(typeof resolved === 'string' ? resolved : '', now, mapping.localId, binding.local_account_id)
        break
      case 'contentHtml':
        this.database.prepare('UPDATE articles SET content_html=?,updated_at=? WHERE id=? AND account_id=?')
          .run(typeof resolved === 'string' ? resolved : '', now, mapping.localId, binding.local_account_id)
        break
      case 'imageUrl':
        this.database.prepare('UPDATE articles SET image_url=?,updated_at=? WHERE id=? AND account_id=?')
          .run(typeof resolved === 'string' ? resolved : null, now, mapping.localId, binding.local_account_id)
        break
      case 'isUnread':
      case 'isStarred':
      case 'isReadLater': {
        const column = field === 'isUnread' ? 'is_unread' : field === 'isReadLater' ? 'is_read_later' : 'is_starred'
        this.database.prepare(`UPDATE articles SET ${column}=?,updated_at=? WHERE id=? AND account_id=?`)
          .run(resolved === true ? 1 : 0, now, mapping.localId, binding.local_account_id)
        break
      }
    }
  }

  private applyArticleFullContent(operation: SyncOperationRecord, value: unknown): void {
    const hash = typeof value === 'string' ? value : null
    if (!hash) throw new SyncApplyDeferredError('Article full-content operation has no Blob hash')
    const reference = syncPayloadBlobRefs(operation.payloadJson).find((ref) =>
      ref.field === SYNC_ARTICLE_FULL_CONTENT_FIELD &&
      ref.referenceKind === SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )
    if (!reference) throw new SyncApplyDeferredError('Article full-content operation has no Blob reference')
    if (reference.manifest.hash !== hash) throw new Error('Article full-content field hash does not match Blob manifest')

    const binding = this.database.prepare(
      'SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1'
    ).get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')
    const mapping = this.aliases.resolveMapping(
      operation.syncSpaceId,
      'article',
      operation.entitySyncId,
      operation.entityGeneration
    )
    if (!mapping) throw new SyncApplyDeferredError('Missing article mapping')
    const article = this.database.prepare(
      'SELECT id FROM articles WHERE id=? AND account_id=? LIMIT 1'
    ).get(mapping.localId, binding.local_account_id)
    if (!article) throw new SyncApplyDeferredError('Missing article row')

    const bytes = this.localBlobStore?.readVerified(hash) ?? null
    this.blobs.registerManifest(reference.manifest, bytes ? 'READY' : 'BLOB_MISSING')
    this.blobs.replaceOwnerReference(
      operation.syncSpaceId,
      operation.replicationLaneId,
      operation.entityType,
      operation.entitySyncId,
      operation.entityGeneration,
      reference.referenceKind,
      hash
    )

    this.applyField(operation, SYNC_ARTICLE_FULL_CONTENT_FIELD, hash)
    const winner = this.state.findFieldVersion(
      operation.syncSpaceId,
      'article',
      operation.entitySyncId,
      SYNC_ARTICLE_FULL_CONTENT_FIELD
    )
    const incomingToken = SyncVersionToken.operation(
      operation.actorIncarnationId,
      operation.replicationLaneId,
      operation.sequence
    )
    if (!winner || winner.versionToken !== incomingToken) return
    if (this.localEviction.isEvicted(
      operation.syncSpaceId,
      'article',
      operation.entitySyncId,
      operation.entityGeneration,
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )) return
    if (!bytes || bytes.byteLength !== reference.manifest.totalBytes) {
      this.blobs.markMissing(hash)
      throw new SyncApplyDeferredError('BLOB_MISSING:' + hash)
    }
    this.blobs.markReadyVerified(hash, bytes.byteLength)
    this.database.prepare(
      'UPDATE articles SET full_content_html=?,updated_at=? WHERE id=? AND account_id=?'
    ).run(Buffer.from(bytes).toString('utf8'), Date.now(), mapping.localId, binding.local_account_id)
  }

  materializeSnapshotArticleFullContent(
    syncSpaceId: string,
    entitySyncId: string,
    generation: number,
    localAccountId: number,
    localArticleId: string,
    hash: string
  ): void {
    if (this.localEviction.isEvicted(
      syncSpaceId,
      'article',
      entitySyncId,
      generation,
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )) return
    const bytes = this.localBlobStore?.readVerified(hash) ?? null
    if (!bytes) {
      this.blobs.markMissing(hash)
      return
    }
    this.blobs.markReadyVerified(hash, bytes.byteLength)
    this.database.prepare(
      'UPDATE articles SET full_content_html=?,updated_at=? WHERE id=? AND account_id=?'
    ).run(Buffer.from(bytes).toString('utf8'), Date.now(), localArticleId, localAccountId)
  }

  /**
   * 处理端点关系变更（例如 Feed 归属到 Group）。
   */
  private applyRelation(operation: SyncOperationRecord): void {
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1')
      .get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new SyncApplyDeferredError('Missing local Space binding')

    const payload = parsePayload(operation.payloadJson)
    const feedSyncId = typeof payload.feedSyncId === 'string' ? payload.feedSyncId : (operation.entityType === 'feed' ? operation.entitySyncId : typeof payload.fromSyncId === 'string' ? payload.fromSyncId : null)
    const groupSyncId = typeof payload.groupSyncId === 'string' ? payload.groupSyncId : typeof payload.targetGroupId === 'string' ? payload.targetGroupId : typeof payload.toSyncId === 'string' ? payload.toSyncId : null
    if (!feedSyncId || !groupSyncId) throw new SyncApplyDeferredError('Relation requires feedSyncId and groupSyncId')

    const feedGeneration = payload.feedGeneration == null
      ? (operation.entityType === 'feed' ? operation.entityGeneration : null)
      : Number(payload.feedGeneration)
    const groupGenerationRaw = payload.groupGeneration ?? payload.targetGroupGeneration
    const groupGeneration = groupGenerationRaw == null ? null : Number(groupGenerationRaw)
    if (feedGeneration != null && (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0)) {
      throw new SyncApplyDeferredError('Relation has invalid feedGeneration')
    }
    if (groupGeneration != null && (!Number.isSafeInteger(groupGeneration) || groupGeneration < 0)) {
      throw new SyncApplyDeferredError('Relation has invalid groupGeneration')
    }

    const localFeedId = this.resolveFeedScopedConfigParent(
      operation.syncSpaceId,
      feedSyncId,
      feedGeneration,
      'Relation'
    )
    if (localFeedId == null) return
    const feedMapping = this.identities.findBySyncId(operation.syncSpaceId, 'feed', feedSyncId)
    if (!feedMapping) throw new SyncApplyDeferredError('Missing feed mapping for relation: ' + feedSyncId)
    const feed = this.database.prepare('SELECT id FROM feeds WHERE id=? AND account_id=?')
      .get(localFeedId, binding.local_account_id)
    if (!feed) throw new SyncApplyDeferredError('Relation feed endpoint not found in local database')

    const fieldOperation = {
      ...operation,
      entityType: 'feed',
      entitySyncId: feedSyncId,
      entityGeneration: feedGeneration ?? feedMapping.generation
    }
    if (groupGeneration != null) {
      this.applyField(fieldOperation, 'groupGeneration', groupGeneration)
    }
    this.applyField(fieldOperation, 'groupSyncId', groupSyncId)
    const version = this.state.findFieldVersion(operation.syncSpaceId, 'feed', feedSyncId, 'groupSyncId')
    if (!version) throw new SyncApplyDeferredError('Missing winning relation version')
    const winningGroupSyncId = JSON.parse(version.valueJson) as unknown
    if (typeof winningGroupSyncId !== 'string') {
      throw new SyncApplyDeferredError('Invalid winning relation group')
    }
    const winningGroupGeneration = this.pairedGenerationForWinner(
      fieldOperation,
      'groupGeneration',
      version.versionToken
    )
    const winningLocalGroupId = this.resolveGroupParent(
      operation.syncSpaceId,
      winningGroupSyncId,
      winningGroupGeneration,
      'Relation'
    )
    if (winningLocalGroupId == null) return
    if (!this.database.prepare('SELECT id FROM groups WHERE id=? AND account_id=?')
      .get(winningLocalGroupId, binding.local_account_id)) {
      throw new SyncApplyDeferredError('Missing winning relation group')
    }
    this.database.prepare('UPDATE feeds SET group_id=?,updated_at=? WHERE id=? AND account_id=?')
      .run(winningLocalGroupId, Date.now(), localFeedId, binding.local_account_id)
  }

  private applyField(
    operation: SyncOperationRecord,
    field: string,
    value: unknown,
    captureBaseline = true
  ): void {
    const valueJson = stableValueJson(value)
    const versionToken = SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence)
    const current = this.state.findFieldVersion(operation.syncSpaceId, operation.entityType, operation.entitySyncId, field)
    const causalContext = decodeCausalCoverage(operation.causalContextJson)
    const candidate = { versionToken, valueJson, source: 'OPERATION' as const, causalContext, logicalClock: operation.logicalClock,
      observedGenesisBaselinesByLane: decodeObservedGenesis(operation.causalContextJson) }
    let previousOperation = current?.sourceOperationId
      ? this.database.prepare('SELECT causal_context_json,logical_clock FROM sync_operation_log WHERE operation_id=?').get(current.sourceOperationId) as { causal_context_json: string; logical_clock: number } | undefined
      : undefined
    if (!previousOperation && current) {
      const dot = parseOperationVersionToken(current.versionToken)
      if (dot) previousOperation = this.database.prepare(`SELECT causal_context_json,sequence AS logical_clock FROM sync_outbox
        WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=? AND sequence=?`)
        .get(operation.syncSpaceId, dot.actorIncarnationId, dot.replicationLaneId, dot.sequence) as { causal_context_json: string; logical_clock: number } | undefined
    }
    const policy = field === 'isUnread' ? 'READ_WINS' : field === 'isStarred' ? 'STARRED_WINS' : 'DETERMINISTIC'
    const candidates = new Map<string, SyncFieldCandidate>()
    const candidateMetadata = new Map<string, { causalContextJson: string | null; logicalClock: number | null }>()
    for (const row of this.state.listFieldCandidates(operation.syncSpaceId)) {
      if (row.entityType !== operation.entityType || row.entitySyncId !== operation.entitySyncId ||
          row.entityGeneration !== operation.entityGeneration || row.fieldId !== field) continue
      candidates.set(row.versionToken, { versionToken: row.versionToken, valueJson: row.valueJson,
        causalContext: row.causalContextJson ? decodeCausalCoverage(row.causalContextJson) : undefined,
        observedGenesisBaselinesByLane: row.causalContextJson ? decodeObservedGenesis(row.causalContextJson) : undefined,
        logicalClock: row.logicalClock ?? 0 })
      candidateMetadata.set(row.versionToken, { causalContextJson: row.causalContextJson ?? null, logicalClock: row.logicalClock ?? null })
    }
    if (current?.entityGeneration === operation.entityGeneration) {
      const currentContextJson = previousOperation?.causal_context_json ?? current.causalContextJson ?? null
      const currentLogicalClock = previousOperation?.logical_clock ?? current.logicalClock ?? null
      candidates.set(current.versionToken, { versionToken: current.versionToken, valueJson: current.valueJson,
          causalContext: currentContextJson ? decodeCausalCoverage(currentContextJson) : undefined,
          observedGenesisBaselinesByLane: currentContextJson ? decodeObservedGenesis(currentContextJson) : undefined,
          logicalClock: currentLogicalClock ?? 0 })
      candidateMetadata.set(current.versionToken, {
        causalContextJson: currentContextJson,
        logicalClock: currentLogicalClock
      })
    }
    const retained = this.database.prepare(`
      SELECT o.actor_incarnation_id,o.replication_lane_id,o.sequence,o.logical_clock,o.operation_type AS mutation_type,o.payload_json,o.causal_context_json
      FROM sync_operation_log o LEFT JOIN sync_inbox_operation i ON i.operation_id=o.operation_id
      WHERE o.sync_space_id=? AND o.entity_type=? AND o.entity_sync_id=? AND o.entity_generation=?
        AND (i.operation_id IS NULL OR i.state='APPLIED') AND o.build_status!='REJECTED'
      UNION ALL
      SELECT actor_incarnation_id,replication_lane_id,sequence,sequence AS logical_clock,mutation_type,payload_json,causal_context_json
      FROM sync_outbox WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=?
        AND status='PENDING_BUILD' AND genesis_included_at IS NULL
    `).all(operation.syncSpaceId, operation.entityType, operation.entitySyncId, operation.entityGeneration,
      operation.syncSpaceId, operation.entityType, operation.entitySyncId, operation.entityGeneration) as Array<{
        actor_incarnation_id: string; replication_lane_id: SyncOperationRecord['replicationLaneId']; sequence: number;
        logical_clock: number; mutation_type: string; payload_json: string; causal_context_json: string
      }>
    for (const row of retained) {
      const payload = parsePayload(row.payload_json)
      const fields = (payload.fields ?? payload) as Record<string, unknown>
      const fieldValue = row.mutation_type === 'FIELD_SET' && payload.field === field ? payload.value
        : row.mutation_type === 'RELATION_SET'
          ? field === 'groupSyncId'
            ? payload.groupSyncId ?? payload.targetGroupId ?? payload.toSyncId
            : field === 'groupGeneration'
              ? payload.groupGeneration ?? payload.targetGroupGeneration
              : undefined
        : row.mutation_type === 'UPSERT' ? fields[field] : undefined
      if (fieldValue === undefined) continue
      const token = SyncVersionToken.operation(row.actor_incarnation_id, row.replication_lane_id, row.sequence)
      candidates.set(token, { versionToken: token, valueJson: stableValueJson(fieldValue),
        causalContext: decodeCausalCoverage(row.causal_context_json), logicalClock: row.logical_clock,
        observedGenesisBaselinesByLane: decodeObservedGenesis(row.causal_context_json) })
      candidateMetadata.set(token, {
        causalContextJson: row.causal_context_json,
        logicalClock: row.logical_clock
      })
    }
    candidates.set(candidate.versionToken, candidate)
    candidateMetadata.set(candidate.versionToken, {
      causalContextJson: operation.causalContextJson,
      logicalClock: operation.logicalClock
    })
    for (const item of candidates.values()) {
      const dot = parseOperationVersionToken(item.versionToken)
      const metadata = candidateMetadata.get(item.versionToken)
      this.state.retainFieldCandidate({ syncSpaceId: operation.syncSpaceId, entityType: operation.entityType,
        entitySyncId: operation.entitySyncId, entityGeneration: operation.entityGeneration, fieldId: field,
        versionToken: item.versionToken, valueJson: item.valueJson,
        sourceOperationId: dot ? operationId(operation.syncSpaceId, dot.actorIncarnationId, dot.replicationLaneId as SyncOperationRecord['replicationLaneId'], dot.sequence) : null,
        causalContextJson: metadata?.causalContextJson ?? null, logicalClock: metadata?.logicalClock ?? null, updatedAt: Date.now() })
    }
    const winner = SyncVersionResolver.resolve([...candidates.values()], policy)
    const winnerDot = parseOperationVersionToken(winner.versionToken)
    const winnerMetadata = candidateMetadata.get(winner.versionToken)
    const version: SyncFieldVersionRecord = {
      syncSpaceId: operation.syncSpaceId,
      entityType: operation.entityType,
      entitySyncId: operation.entitySyncId,
      fieldId: field,
      entityGeneration: operation.entityGeneration,
      versionToken: winner.versionToken,
      sourceOperationId: winnerDot ? operationId(operation.syncSpaceId, winnerDot.actorIncarnationId, winnerDot.replicationLaneId as SyncOperationRecord['replicationLaneId'], winnerDot.sequence) : null,
      valueJson: winner.valueJson,
      causalContextJson: winnerMetadata?.causalContextJson ?? null,
      logicalClock: winnerMetadata?.logicalClock ?? null,
      updatedAt: Date.now()
    }
    const refreshStableBaseline =
      captureBaseline &&
      current?.sourceOperationId == null &&
      this.state.findInbox(operation.operationId)?.authorizationState === 'PROVISIONAL_AUTHORIZED'
    if (captureBaseline && (!current || refreshStableBaseline)) {
      this.captureRollbackBaseline(operation, field, refreshStableBaseline)
    }
    this.state.upsertFieldVersion(version)
  }

  private captureRollbackBaseline(operation: SyncOperationRecord, field: string, replace = false): void {
    // Only capture an existing local field before its first synchronized version.
    const mapping = this.identities.findBySyncId(operation.syncSpaceId, operation.entityType as any, operation.entitySyncId)
    if (!mapping || mapping.generation !== operation.entityGeneration) return
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=?').get(operation.syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) return
    let row: { value: unknown } | undefined
    if (operation.entityType === 'article') {
      const article = this.database.prepare(`
        SELECT feed_id,title,url,author,published_at,description,content_html,image_url,
               is_unread,is_starred,is_read_later,created_at
        FROM articles WHERE id=? AND account_id=? LIMIT 1
      `).get(mapping.localId, binding.local_account_id) as Record<string, unknown> | undefined
      if (article) {
        switch (field) {
          case 'feedSyncId': {
            const feed = this.identities.findByLocalId(
              operation.syncSpaceId,
              'feed',
              String(article.feed_id)
            )
            if (feed) row = { value: feed.syncId }
            break
          }
          case 'feedGeneration': {
            const feed = this.identities.findByLocalId(
              operation.syncSpaceId,
              'feed',
              String(article.feed_id)
            )
            if (feed) row = { value: feed.generation }
            break
          }
          case 'title': row = { value: String(article.title ?? '') }; break
          case 'url': row = { value: String(article.url ?? '') }; break
          case 'author': row = { value: article.author == null ? null : String(article.author) }; break
          case 'publishedAt': row = { value: Number(article.published_at ?? article.created_at ?? 0) }; break
          case 'description': row = { value: String(article.description ?? '') }; break
          case 'contentHtml': row = { value: String(article.content_html ?? '') }; break
          case 'imageUrl': row = { value: article.image_url == null ? null : String(article.image_url) }; break
          case 'isUnread': row = { value: Number(article.is_unread) === 1 }; break
          case 'isStarred': row = { value: Number(article.is_starred) === 1 }; break
          case 'isReadLater': row = { value: Number(article.is_read_later) === 1 }; break
        }
      }
    } else if (operation.entityType === 'group' && field === 'name') {
      row = this.database.prepare('SELECT name AS value FROM groups WHERE id=? AND account_id=?')
        .get(mapping.localId, binding.local_account_id) as { value: string } | undefined
    } else if (operation.entityType === 'feed') {
      const feed = this.database.prepare(`
        SELECT group_id,name,url,source_type,icon,is_notification,is_full_content,is_browser
        FROM feeds WHERE id=? AND account_id=? LIMIT 1
      `).get(mapping.localId, binding.local_account_id) as Record<string, unknown> | undefined
      if (feed) {
        switch (field) {
          case 'groupSyncId': {
            const group = this.identities.findByLocalId(
              operation.syncSpaceId,
              'group',
              String(feed.group_id)
            )
            if (group) row = { value: group.syncId }
            break
          }
          case 'groupGeneration': {
            const group = this.identities.findByLocalId(
              operation.syncSpaceId,
              'group',
              String(feed.group_id)
            )
            if (group) row = { value: group.generation }
            break
          }
          case 'name': row = { value: String(feed.name ?? '') }; break
          case 'url': row = { value: String(feed.url ?? '') }; break
          case 'sourceType': row = { value: String(feed.source_type ?? 'rss') }; break
          case 'icon': row = { value: feed.icon == null ? null : String(feed.icon) }; break
          case 'isNotification': row = { value: Number(feed.is_notification) === 1 }; break
          case 'isFullContent': row = { value: Number(feed.is_full_content) === 1 }; break
          case 'isBrowser': row = { value: Number(feed.is_browser) === 1 }; break
        }
      }
    } else if (operation.entityType === 'filter_rule') {
      const rule = this.articleFilters?.getById(mapping.localId)
      if (rule) {
        switch (field) {
          case 'keyword': row = { value: rule.keyword }; break
          case 'feedSyncId': {
            if (rule.feedId == null) row = { value: null }
            else {
              const feed = this.identities.findByLocalId(operation.syncSpaceId, 'feed', rule.feedId)
              if (feed) row = { value: feed.syncId }
            }
            break
          }
          case 'feedGeneration': {
            if (rule.feedId == null) row = { value: null }
            else {
              const feed = this.identities.findByLocalId(operation.syncSpaceId, 'feed', rule.feedId)
              if (feed) row = { value: feed.generation }
            }
            break
          }
          case 'feedName': row = { value: rule.feedName ?? null }; break
          case 'type': row = { value: rule.type }; break
          case 'enabled': row = { value: rule.enabled }; break
        }
      }
    } else if (operation.entityType === 'website_rule' && field === 'rule') {
      const rule = this.websiteRules?.listSyncRules().find((value) => value.id === mapping.localId)
      if (rule) row = { value: rule }
    } else if (operation.entityType === 'json_rule' && field === 'rule') {
      const rule = this.jsonRules?.listSyncRules().find((value) => value.id === mapping.localId)
      if (rule) row = { value: rule }
    } else if (operation.entityType === 'rsshub_settings' && field === 'settings') {
      if (this.rssHubSettings) row = { value: this.rssHubSettings.current() }
    } else if (operation.entityType === 'website_parse_preference' && field === 'preference') {
      const feed = this.identities.findBySyncId(operation.syncSpaceId, 'feed', mapping.localId)
      if (feed && this.websiteParsePreferences) {
        const state = this.websiteParsePreferences.getUserSyncState(feed.localId)
        row = {
          value: state
            ? {
                feedSyncId: feed.syncId,
                feedGeneration: feed.generation,
                dynamicRenderingEnabled: state.dynamicRenderingEnabled,
                preferredRuleId: state.preferredRuleId,
                preferredRuleName: state.preferredRuleName
              }
            : {
                feedSyncId: feed.syncId,
                feedGeneration: feed.generation,
                __syncAbsent: true
              }
        }
      }
    } else if (operation.entityType === 'rsshub_subscription_source' && field === 'source') {
      const feed = this.identities.findBySyncId(operation.syncSpaceId, 'feed', mapping.localId)
      if (feed) {
        const source = this.database.prepare(
          'SELECT source_url FROM rsshub_source_urls WHERE feed_id=? LIMIT 1'
        ).get(feed.localId) as { source_url: string } | undefined
        row = {
          value: source
            ? {
                feedSyncId: feed.syncId,
                feedGeneration: feed.generation,
                sourceUrl: source.source_url
              }
            : {
                feedSyncId: feed.syncId,
                feedGeneration: feed.generation,
                __syncAbsent: true
              }
        }
      }
    }
    if (!row) return
    const predecessor = replace
      ? this.state.findFieldVersion(
          operation.syncSpaceId,
          operation.entityType,
          operation.entitySyncId,
          field
        )
      : null
    const storedValueJson =
      predecessor && predecessor.sourceOperationId == null
        ? JSON.stringify({
            __syncRollbackBaselineV2: true,
            valueJson: stableValueJson(row.value),
            versionToken: predecessor.versionToken
          })
        : stableValueJson(row.value)
    const sql = replace
      ? `INSERT INTO sync_field_rollback_baseline
          (sync_space_id,entity_type,entity_sync_id,entity_generation,field_id,value_json) VALUES(?,?,?,?,?,?)
          ON CONFLICT(sync_space_id,entity_type,entity_sync_id,entity_generation,field_id)
          DO UPDATE SET value_json=excluded.value_json`
      : `INSERT OR IGNORE INTO sync_field_rollback_baseline
          (sync_space_id,entity_type,entity_sync_id,entity_generation,field_id,value_json) VALUES(?,?,?,?,?,?)`
    this.database.prepare(sql)
      .run(
        operation.syncSpaceId,
        operation.entityType,
        operation.entitySyncId,
        operation.entityGeneration,
        field,
        storedValueJson
      )
  }

  private decodeRollbackBaseline(raw: string): {
    valueJson: string
    versionToken: string | null
  } {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).__syncRollbackBaselineV2 === true
      ) {
        const valueJson = (parsed as Record<string, unknown>).valueJson
        const versionToken = (parsed as Record<string, unknown>).versionToken
        if (typeof valueJson !== 'string' || typeof versionToken !== 'string') {
          throw new Error('REBASE_UNSAFE: malformed rollback baseline envelope')
        }
        SyncVersionToken.source(versionToken)
        return { valueJson, versionToken }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('REBASE_UNSAFE:')
      ) {
        throw error
      }
    }
    return { valueJson: raw, versionToken: null }
  }

  /**
   * 当 sourceOperation 因授权撤销而被置为 REJECTED 时，回滚受污染的业务字段并重新决胜。
   *
   * @param syncSpaceId 同步空间 ID
   * @param entityType 实体类型 ('article' | 'feed' | 'group')
   * @param entitySyncId 实体跨端 Sync ID
   * @param field 字段名 (如 'isStarred', 'isUnread', 'name')
   * @param revokedOperationId 被撤销的操作 ID
   */
  rollbackField(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    field: string,
    revokedOperationId: string
  ): void {
    const current = this.state.findFieldVersion(syncSpaceId, entityType, entitySyncId, field)
    if (!current || current.sourceOperationId !== revokedOperationId) return

    if (!((entityType === 'article' && [
        'feedSyncId',
        'feedGeneration',
        'title',
        'url',
        'author',
        'publishedAt',
        'description',
        'contentHtml',
        'imageUrl',
        'isStarred',
        'isUnread',
        'isReadLater'
      ].includes(field)) ||
      (entityType === 'group' && field === 'name') ||
      (entityType === 'feed' && [
        'groupSyncId',
        'groupGeneration',
        'name',
        'url',
        'sourceType',
        'icon',
        'isNotification',
        'isFullContent',
        'isBrowser'
      ].includes(field)) ||
      (entityType === 'filter_rule' && [
        'keyword',
        'feedSyncId',
        'feedGeneration',
        'feedName',
        'type',
        'enabled'
      ].includes(field)) ||
      ((entityType === 'website_rule' || entityType === 'json_rule') && field === 'rule') ||
      (entityType === 'rsshub_settings' && field === 'settings') ||
      (entityType === 'website_parse_preference' && field === 'preference') ||
      (entityType === 'rsshub_subscription_source' && field === 'source')
    )) throw new Error('REBASE_UNSAFE: unsupported rollback projection')
    const mapping = this.identities.findBySyncId(syncSpaceId, entityType as any, entitySyncId)
    if (!mapping || mapping.generation !== current.entityGeneration) throw new Error('REBASE_UNSAFE: rollback generation mismatch')
    // Re-resolve from all retained same-generation candidates. Local pending Outbox rows
    // are merge candidates, not a reason to abandon AUTH rollback.
    const retainedRows = this.database.prepare(`
      SELECT
        o.operation_id AS source_operation_id,
        o.actor_incarnation_id,
        o.replication_lane_id,
        o.sequence,
        o.logical_clock,
        o.operation_type AS mutation_type,
        o.payload_json,
        o.causal_context_json
      FROM sync_operation_log o
      LEFT JOIN sync_inbox_operation i ON i.operation_id=o.operation_id
      WHERE o.sync_space_id=? AND o.entity_type=? AND o.entity_sync_id=? AND o.entity_generation=?
        AND o.operation_id!=?
        AND (i.operation_id IS NULL OR i.state='APPLIED')
        AND o.build_status!='REJECTED'
      UNION ALL
      SELECT
        NULL AS source_operation_id,
        actor_incarnation_id,
        replication_lane_id,
        sequence,
        sequence AS logical_clock,
        mutation_type,
        payload_json,
        causal_context_json
      FROM sync_outbox
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=?
        AND status='PENDING_BUILD' AND genesis_included_at IS NULL
    `).all(
      syncSpaceId,
      entityType,
      entitySyncId,
      current.entityGeneration,
      revokedOperationId,
      syncSpaceId,
      entityType,
      entitySyncId,
      current.entityGeneration
    ) as unknown as Array<Record<string, unknown>>

    const candidates: SyncFieldCandidate[] = []
    const sourceOperationIds = new Map<string, string>()
    const sourceMetadata = new Map<string, { causalContextJson: string | null; logicalClock: number | null }>()

    for (const row of retainedRows) {
      const payload = parsePayload(String(row.payload_json))
      let fieldValue: unknown
      const mutationType = String(row.mutation_type)
      if (mutationType === 'FIELD_SET' && String(payload.field) === field) {
        fieldValue = payload.value
      } else if (mutationType === 'RELATION_SET') {
        fieldValue = field === 'groupSyncId'
          ? payload.groupSyncId ?? payload.targetGroupId ?? payload.toSyncId
          : field === 'groupGeneration'
            ? payload.groupGeneration ?? payload.targetGroupGeneration
            : undefined
      } else if (mutationType === 'UPSERT') {
        const fields = (payload.fields ?? payload) as Record<string, unknown>
        if (field in fields) fieldValue = fields[field]
      }
      if (fieldValue !== undefined) {
        const rawCausal = row.causal_context_json == null ? '' : String(row.causal_context_json)
        const actor = String(row.actor_incarnation_id)
        const lane = String(row.replication_lane_id) as SyncOperationRecord['replicationLaneId']
        const sequence = Number(row.sequence)
        const token = SyncVersionToken.operation(actor, lane, sequence)
        candidates.push({
          versionToken: token,
          valueJson: stableValueJson(fieldValue),
          source: 'OPERATION',
          logicalClock: Number(row.logical_clock),
          causalContext: rawCausal.trim() ? decodeCausalCoverage(rawCausal) : undefined,
          observedGenesisBaselinesByLane: rawCausal.trim() ? decodeObservedGenesis(rawCausal) : undefined
        })
        sourceOperationIds.set(
          token,
          row.source_operation_id == null
            ? operationId(syncSpaceId, actor, lane, sequence)
            : String(row.source_operation_id)
        )
        sourceMetadata.set(token, {
          causalContextJson: rawCausal.trim() ? rawCausal : null,
          logicalClock: Number(row.logical_clock)
        })
      }
    }

    const policy = field === 'isUnread' ? 'READ_WINS' : field === 'isStarred' ? 'STARRED_WINS' : 'DETERMINISTIC'

    if (candidates.length > 0) {
      const winner = SyncVersionResolver.resolve(candidates, policy)
      const sourceOpId = sourceOperationIds.get(winner.versionToken) ?? null
      const metadata = sourceMetadata.get(winner.versionToken)
      this.updateProjectedTable(
        syncSpaceId,
        entityType,
        entitySyncId,
        field,
        JSON.parse(winner.valueJson),
        winner.versionToken
      )
      this.state.upsertFieldVersion({
        syncSpaceId,
        entityType,
        entitySyncId,
        fieldId: field,
        entityGeneration: current.entityGeneration,
        versionToken: winner.versionToken,
        sourceOperationId: sourceOpId,
        valueJson: winner.valueJson,
        causalContextJson: metadata?.causalContextJson ?? null,
        logicalClock: metadata?.logicalClock ?? null,
        updatedAt: Date.now()
      })
    } else {
      const baseline = this.database.prepare(`SELECT value_json FROM sync_field_rollback_baseline
        WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND field_id=?`)
        .get(syncSpaceId, entityType, entitySyncId, current.entityGeneration, field) as { value_json: string } | undefined
      if (!baseline) throw new Error('REBASE_UNSAFE: historical field baseline is unavailable')
      const restored = this.decodeRollbackBaseline(baseline.value_json)
      this.updateProjectedTable(
        syncSpaceId,
        entityType,
        entitySyncId,
        field,
        JSON.parse(restored.valueJson)
      )
      if (restored.versionToken) {
        this.state.upsertFieldVersion({
          syncSpaceId,
          entityType,
          entitySyncId,
          fieldId: field,
          entityGeneration: current.entityGeneration,
          versionToken: restored.versionToken,
          sourceOperationId: null,
          valueJson: restored.valueJson,
          updatedAt: Date.now()
        })
      } else {
        this.state.deleteFieldVersion(syncSpaceId, entityType, entitySyncId, field)
      }
    }
  }

  private updateProjectedTable(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    field: string,
    value: unknown,
    projectedWinnerToken?: string
  ): void {
    const mapping = this.identities.findBySyncId(syncSpaceId, entityType as any, entitySyncId)
    if (!mapping) throw new Error('REBASE_UNSAFE: rollback identity is unavailable')
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1')
      .get(syncSpaceId) as { local_account_id: number } | undefined
    if (!binding) throw new Error('REBASE_UNSAFE: rollback binding is unavailable')

    if (entityType === 'article') {
      if (field === 'feedGeneration') return
      const now = Date.now()
      switch (field) {
        case 'feedSyncId': {
          if (typeof value !== 'string') throw new Error('REBASE_UNSAFE: invalid Article feedSyncId')
          const feedGeneration = projectedWinnerToken
            ? this.pairedGenerationForProjectedWinner(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'feedGeneration',
                projectedWinnerToken
              )
            : this.pairedGenerationForProjectedField(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'feedSyncId',
                'feedGeneration'
              )
          const localFeedId = this.resolveFeedScopedConfigParent(
            syncSpaceId,
            value,
            feedGeneration,
            'Article ' + entitySyncId
          )
          if (localFeedId == null) return
          if (!this.database.prepare('SELECT 1 FROM feeds WHERE id=? AND account_id=? LIMIT 1')
            .get(localFeedId, binding.local_account_id)) {
            throw new Error('REBASE_UNSAFE: Article feed rollback target is unavailable')
          }
          this.database.prepare('UPDATE articles SET feed_id=?,updated_at=? WHERE id=? AND account_id=?')
            .run(localFeedId, now, mapping.localId, binding.local_account_id)
          break
        }
        case 'title':
          if (typeof value !== 'string') throw new Error('REBASE_UNSAFE: invalid Article title')
          this.database.prepare('UPDATE articles SET title=?,updated_at=? WHERE id=? AND account_id=?')
            .run(value, now, mapping.localId, binding.local_account_id)
          break
        case 'url':
          this.database.prepare('UPDATE articles SET url=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : '', now, mapping.localId, binding.local_account_id)
          break
        case 'author':
          this.database.prepare('UPDATE articles SET author=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : null, now, mapping.localId, binding.local_account_id)
          break
        case 'publishedAt':
          if (!Number.isSafeInteger(Number(value))) {
            throw new Error('REBASE_UNSAFE: invalid Article publishedAt')
          }
          this.database.prepare('UPDATE articles SET published_at=?,updated_at=? WHERE id=? AND account_id=?')
            .run(Number(value), now, mapping.localId, binding.local_account_id)
          break
        case 'description':
          this.database.prepare('UPDATE articles SET description=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : '', now, mapping.localId, binding.local_account_id)
          break
        case 'contentHtml':
          this.database.prepare('UPDATE articles SET content_html=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : '', now, mapping.localId, binding.local_account_id)
          break
        case 'imageUrl':
          this.database.prepare('UPDATE articles SET image_url=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : null, now, mapping.localId, binding.local_account_id)
          break
        case 'isStarred':
          this.database.prepare('UPDATE articles SET is_starred=?,updated_at=? WHERE id=? AND account_id=?')
            .run(value ? 1 : 0, now, mapping.localId, binding.local_account_id)
          break
        case 'isUnread':
          this.database.prepare('UPDATE articles SET is_unread=?,updated_at=? WHERE id=? AND account_id=?')
            .run(value ? 1 : 0, now, mapping.localId, binding.local_account_id)
          break
        case 'isReadLater':
          this.database.prepare('UPDATE articles SET is_read_later=?,updated_at=? WHERE id=? AND account_id=?')
            .run(value ? 1 : 0, now, mapping.localId, binding.local_account_id)
          break
        default:
          throw new Error(`REBASE_UNSAFE: unsupported Article rollback field ${field}`)
      }
      const article = this.database.prepare(
        'SELECT feed_id,url FROM articles WHERE id=? AND account_id=? LIMIT 1'
      ).get(mapping.localId, binding.local_account_id) as { feed_id: string; url: string } | undefined
      if (article) {
        const feedMapping = this.identities.findByLocalId(syncSpaceId, 'feed', article.feed_id)
        const canonicalKey = articleCanonicalKey(feedMapping?.canonicalKey, article.url)
        if (mapping.canonicalKey !== canonicalKey) {
          this.identities.updateMappings([{ ...mapping, canonicalKey, updatedAt: now }])
        }
      }
    } else if (entityType === 'group' && field === 'name') {
      this.database.prepare('UPDATE groups SET name=? WHERE id=? AND account_id=?')
        .run(String(value), mapping.localId, binding.local_account_id)
    } else if (entityType === 'feed') {
      if (field === 'groupGeneration') return
      const now = Date.now()
      switch (field) {
        case 'groupSyncId': {
          if (typeof value !== 'string') throw new Error('REBASE_UNSAFE: invalid Feed groupSyncId')
          const groupGeneration = projectedWinnerToken
            ? this.pairedGenerationForProjectedWinner(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'groupGeneration',
                projectedWinnerToken
              )
            : this.pairedGenerationForProjectedField(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'groupSyncId',
                'groupGeneration'
              )
          const localGroupId = this.resolveGroupParent(
            syncSpaceId,
            value,
            groupGeneration,
            'Feed ' + entitySyncId
          )
          if (localGroupId == null) return
          if (!this.database.prepare('SELECT 1 FROM groups WHERE id=? AND account_id=? LIMIT 1')
            .get(localGroupId, binding.local_account_id)) {
            throw new Error('REBASE_UNSAFE: Feed group rollback target is unavailable')
          }
          this.database.prepare('UPDATE feeds SET group_id=?,updated_at=? WHERE id=? AND account_id=?')
            .run(localGroupId, now, mapping.localId, binding.local_account_id)
          break
        }
        case 'name':
          this.database.prepare('UPDATE feeds SET name=?,updated_at=? WHERE id=? AND account_id=?')
            .run(String(value), now, mapping.localId, binding.local_account_id)
          break
        case 'url':
          this.database.prepare('UPDATE feeds SET url=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : '', now, mapping.localId, binding.local_account_id)
          break
        case 'sourceType':
          if (
            typeof value !== 'string' ||
            !['rss', 'website', 'json'].includes(value.trim().toLowerCase())
          ) {
            throw new Error('REBASE_UNSAFE: invalid Feed sourceType')
          }
          this.database.prepare('UPDATE feeds SET source_type=?,updated_at=? WHERE id=? AND account_id=?')
            .run(value.trim().toLowerCase(), now, mapping.localId, binding.local_account_id)
          break
        case 'icon':
          this.database.prepare('UPDATE feeds SET icon=?,updated_at=? WHERE id=? AND account_id=?')
            .run(typeof value === 'string' ? value : null, now, mapping.localId, binding.local_account_id)
          break
        case 'isNotification':
        case 'isFullContent':
        case 'isBrowser': {
          const column = field === 'isNotification'
            ? 'is_notification'
            : field === 'isFullContent'
              ? 'is_full_content'
              : 'is_browser'
          this.database.prepare(`UPDATE feeds SET ${column}=?,updated_at=? WHERE id=? AND account_id=?`)
            .run(value ? 1 : 0, now, mapping.localId, binding.local_account_id)
          break
        }
        default:
          throw new Error(`REBASE_UNSAFE: unsupported Feed rollback field ${field}`)
      }
      const feed = this.database.prepare(
        'SELECT source_type,url FROM feeds WHERE id=? AND account_id=? LIMIT 1'
      ).get(mapping.localId, binding.local_account_id) as { source_type: string; url: string } | undefined
      if (feed) {
        const canonicalKey = feedCanonicalKey(
          feed.source_type as Parameters<typeof feedCanonicalKey>[0],
          feed.url
        )
        if (mapping.canonicalKey !== canonicalKey) {
          this.identities.updateMappings([{ ...mapping, canonicalKey, updatedAt: now }])
        }
      }
    } else if (entityType === 'filter_rule') {
      if (!this.articleFilters) throw new Error('REBASE_UNSAFE: FilterRule repository is unavailable')
      if (field === 'feedGeneration') return
      const current = this.articleFilters.getById(mapping.localId)
      if (!current) return
      let next = { ...current }
      switch (field) {
        case 'feedSyncId': {
          if (value == null) {
            next = { ...next, feedId: null }
            break
          }
          if (typeof value !== 'string') throw new Error('REBASE_UNSAFE: invalid FilterRule feedSyncId')
          const feedGeneration = projectedWinnerToken
            ? this.pairedGenerationForProjectedWinner(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'feedGeneration',
                projectedWinnerToken
              )
            : this.pairedGenerationForProjectedField(
                syncSpaceId,
                entityType,
                entitySyncId,
                mapping.generation,
                'feedSyncId',
                'feedGeneration'
              )
          const localFeedId = this.resolveFeedScopedConfigParent(
            syncSpaceId,
            value,
            feedGeneration,
            'Filter rule ' + entitySyncId
          )
          if (localFeedId == null) {
            this.articleFilters.delete(mapping.localId)
            return
          }
          next = { ...next, feedId: localFeedId }
          break
        }
        case 'keyword':
          if (typeof value !== 'string') throw new Error('REBASE_UNSAFE: invalid FilterRule keyword')
          next = { ...next, keyword: value }
          break
        case 'feedName':
          next = { ...next, feedName: typeof value === 'string' ? value : null }
          break
        case 'type':
          if (value !== 'KEYWORD' && value !== 'REGEX') throw new Error('REBASE_UNSAFE: invalid FilterRule type')
          next = { ...next, type: value }
          break
        case 'enabled':
          if (typeof value !== 'boolean') throw new Error('REBASE_UNSAFE: invalid FilterRule enabled')
          next = { ...next, enabled: value }
          break
        default:
          throw new Error(`REBASE_UNSAFE: unsupported FilterRule rollback field ${field}`)
      }
      this.articleFilters.upsert(next)
    } else if (entityType === 'website_rule') {
      if (field !== 'rule' || !this.websiteRules) {
        throw new Error('REBASE_UNSAFE: unsupported WebsiteRule rollback projection')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('REBASE_UNSAFE: malformed WebsiteRule rollback payload')
      }
      const restored = value as WebsiteRule
      if (restored.id !== mapping.localId) {
        throw new Error('REBASE_UNSAFE: WebsiteRule rollback identity mismatch')
      }
      this.websiteRules.replaceSyncRules([
        ...this.websiteRules.listSyncRules().filter((rule) => rule.id !== restored.id),
        restored
      ])
    } else if (entityType === 'json_rule') {
      if (field !== 'rule' || !this.jsonRules) {
        throw new Error('REBASE_UNSAFE: unsupported JsonRule rollback projection')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('REBASE_UNSAFE: malformed JsonRule rollback payload')
      }
      const restored = value as JsonRule
      if (restored.id !== mapping.localId) {
        throw new Error('REBASE_UNSAFE: JsonRule rollback identity mismatch')
      }
      this.jsonRules.replaceSyncRules([
        ...this.jsonRules.listSyncRules().filter((rule) => rule.id !== restored.id),
        restored
      ])
    } else if (entityType === 'rsshub_settings') {
      if (field !== 'settings' || !this.rssHubSettings) {
        throw new Error('REBASE_UNSAFE: unsupported RSSHub settings rollback projection')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('REBASE_UNSAFE: malformed RSSHub settings rollback payload')
      }
      this.rssHubSettings.replaceSyncSettings(value as RssHubSettings)
    } else if (entityType === 'website_parse_preference') {
      if (field !== 'preference' || !this.websiteParsePreferences) {
        throw new Error('REBASE_UNSAFE: unsupported website parse preference rollback projection')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('REBASE_UNSAFE: malformed website parse preference rollback payload')
      }
      const raw = value as Record<string, unknown>
      const feedSyncId = typeof raw.feedSyncId === 'string' ? raw.feedSyncId : ''
      const feedGeneration = raw.feedGeneration == null ? null : Number(raw.feedGeneration)
      if (!feedSyncId) {
        throw new Error('REBASE_UNSAFE: website parse preference rollback has no feedSyncId')
      }
      const localFeedId = this.resolveFeedScopedConfigParent(
        syncSpaceId,
        feedSyncId,
        feedGeneration,
        'Website parse preference ' + entitySyncId
      )
      if (localFeedId == null) return
      if (raw.__syncAbsent === true) {
        this.websiteParsePreferences.applyUserSyncState(localFeedId, null)
      } else {
        this.websiteParsePreferences.applyUserSyncState(localFeedId, {
          dynamicRenderingEnabled: raw.dynamicRenderingEnabled === true,
          preferredRuleId: typeof raw.preferredRuleId === 'string' ? raw.preferredRuleId : null,
          preferredRuleName: typeof raw.preferredRuleName === 'string' ? raw.preferredRuleName : null
        })
      }
    } else if (entityType === 'rsshub_subscription_source') {
      if (field !== 'source') {
        throw new Error('REBASE_UNSAFE: unsupported RSSHub source rollback projection')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('REBASE_UNSAFE: malformed RSSHub source rollback payload')
      }
      const raw = value as Record<string, unknown>
      const feedSyncId = typeof raw.feedSyncId === 'string' ? raw.feedSyncId : ''
      const feedGeneration = raw.feedGeneration == null ? null : Number(raw.feedGeneration)
      if (!feedSyncId) {
        throw new Error('REBASE_UNSAFE: RSSHub source rollback has no feedSyncId')
      }
      const localFeedId = this.resolveFeedScopedConfigParent(
        syncSpaceId,
        feedSyncId,
        feedGeneration,
        'RSSHub subscription source ' + entitySyncId
      )
      if (localFeedId == null) return
      if (raw.__syncAbsent === true) {
        this.database.prepare('DELETE FROM rsshub_source_urls WHERE feed_id=?').run(localFeedId)
      } else {
        const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : ''
        if (!sourceUrl) throw new Error('REBASE_UNSAFE: RSSHub source rollback has no sourceUrl')
        this.database.prepare(`
          INSERT INTO rsshub_source_urls(feed_id,source_url)
          VALUES(?,?)
          ON CONFLICT(feed_id) DO UPDATE SET source_url=excluded.source_url
        `).run(localFeedId, sourceUrl)
      }
    }
  }
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stableValueJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValueJson).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValueJson(item)}`).join(',')}}`
  return 'null'
}

function decodeCausalCoverage(raw: string): Record<string, Record<string, number>> {
  const value = JSON.parse(raw) as { lanes?: Array<{ replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }> }
  return Object.fromEntries((value.lanes ?? []).map((lane) => [lane.replicationLaneId,
    Object.fromEntries(lane.actors.map((actor) => [actor.actorIncarnationId, actor.prefix]))]))
}

function decodeObservedGenesis(raw: string): Record<string, string[]> {
  const value = JSON.parse(raw) as { observedGenesisBaselinesByLane?: Record<string, string[]> }
  return value.observedGenesisBaselinesByLane ?? {}
}
