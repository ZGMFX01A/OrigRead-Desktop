import type { DatabaseSync } from 'node:sqlite'
import type { ArticleFilterRule } from '../../shared/filter-rules'
import type { JsonRule } from '../../shared/json-source'
import type { RssHubSettings } from '../../shared/rsshub'
import type { SyncIdentityMappingRecord } from '../../shared/sync-identity'
import type { SyncWritableActorContext } from '../../shared/sync-runtime'
import type { WebsiteRule } from '../../shared/website'
import type { WebsiteParsePreferenceUserSyncState } from '../sources/website/website-parse-preference-repository'
import { articleCandidateKey, configRuleSyncId, feedCandidateKey, newSyncId } from './sync-canonical-identity'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { DesktopSyncRuntimeCoordinator, SyncActorRollbackDetectedError } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { SyncVersionToken } from './sync-version-token'
import { operationId } from './sync-operation-canonicalizer'
import {
  articleFullContentBlobRef,
  SYNC_ARTICLE_FULL_CONTENT_FIELD,
  SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
} from './sync-blob-payload'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { DesktopSyncLocalEvictionService } from './sync-alias-protocol'
import { libraryRowExists, libraryRows, type SyncLibrarySelection } from './sync-library-selection'
import { hasDeletedDefaultGroup, isAccountDefaultGroup } from './sync-default-group-recovery'

export interface LibrarySyncMutationCapture {
  captureLibraryMutation?<T>(accountId: number, mutate: () => T, selection?: boolean | SyncLibrarySelection): T
  bootstrapCurrentLibraryState?(accountId: number): boolean
  captureFilterRulesMutation?<T>(
    accountId: number,
    readRules: () => ArticleFilterRule[],
    replaceRules: (rules: ArticleFilterRule[]) => unknown,
    mutate: () => T
  ): T
  captureWebsiteRulesMutation?<T>(
    accountId: number,
    readRules: () => WebsiteRule[],
    replaceRules: (rules: WebsiteRule[]) => unknown,
    mutate: () => T
  ): T
  captureJsonRulesMutation?<T>(
    accountId: number,
    readRules: () => JsonRule[],
    replaceRules: (rules: JsonRule[]) => unknown,
    mutate: () => T
  ): T
  captureRssHubSettingsMutation?<T>(
    accountId: number,
    readSettings: () => RssHubSettings,
    replaceSettings: (settings: RssHubSettings) => unknown,
    mutate: () => T
  ): T
  captureWebsiteParsePreferenceMutation?<T>(
    accountId: number,
    feedId: string,
    readState: () => WebsiteParsePreferenceUserSyncState | null,
    replaceState: (state: WebsiteParsePreferenceUserSyncState | null) => unknown,
    mutate: () => T
  ): T
  captureWebsiteParsePreferencesMutation?<T>(
    accountId: number,
    feedIds: Set<string>,
    readStates: () => Map<string, WebsiteParsePreferenceUserSyncState | null>,
    replaceStates: (states: Map<string, WebsiteParsePreferenceUserSyncState | null>) => unknown,
    mutate: () => T
  ): T
  captureRssHubSubscriptionSourceMutation?<T>(
    accountId: number,
    feedId: string,
    readState: () => string | null,
    replaceState: (state: string | null) => unknown,
    mutate: () => T
  ): T
  captureRssHubSubscriptionSourcesMutation?<T>(
    accountId: number,
    feedIds: Set<string>,
    readStates: () => Map<string, string | null>,
    replaceStates: (states: Map<string, string | null>) => unknown,
    mutate: () => T
  ): T
  captureArticleField(
    accountId: number,
    articleIds: string[],
    field: 'isUnread' | 'isStarred' | 'isReadLater',
    value: boolean,
    mutate: () => void
  ): void

  captureArticleFullContent(
    accountId: number,
    articleId: string,
    html: string,
    mutate: () => void
  ): void

  markArticleFullContentEvicted(accountId: number, articleId: string): void
}

/**
 * Desktop local business mutation boundary for ARTICLE_STATE.
 *
 * No active/capturing Sync Space => behaves exactly like the old repository. When Sync is capturing/active,
 * field mutation + Dot allocation + Outbox rows commit in one SQLite transaction.
 */
export class DesktopLibrarySyncMutationCapture implements LibrarySyncMutationCapture {
  private readonly identities: SyncIdentityRepository
  private readonly blobs: DesktopSyncBlobStateService
  private readonly localEviction: DesktopSyncLocalEvictionService

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly coordinator: DesktopSyncRuntimeCoordinator,
    private readonly allocator: DesktopSyncOutboxAllocator,
    private readonly localBlobStore: DesktopSyncLocalBlobStore
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.blobs = new DesktopSyncBlobStateService(database)
    this.localEviction = new DesktopSyncLocalEvictionService(database)
  }

  bootstrapCurrentLibraryState(accountId: number): boolean {
    const context = this.coordinator.currentWritableContext(accountId)
    if (!context) return false
    const completed = this.database.prepare(`
      SELECT 1 AS present
      FROM sync_space_join_bootstrap
      WHERE sync_space_id=? AND local_account_id=?
      LIMIT 1
    `).get(context.syncSpaceId, accountId) as { present: number } | undefined
    const restoreDefault = hasDeletedDefaultGroup(this.database, { accountId, syncSpaceId: context.syncSpaceId })
    if (completed && !restoreDefault) return false

    this.runtime.transaction(() => {
      // 旧 actor 的错误删除阻塞了顺序前缀；合法新 incarnation 才能先到达目标端恢复实体。
      if (restoreDefault) this.coordinator.rotateActor(accountId, 'default-group-delete-recovery')
      this.captureLibraryMutation(accountId, () => {
        this.database.prepare(`
          INSERT INTO sync_space_join_bootstrap(sync_space_id,local_account_id,completed_at)
          VALUES(?,?,?)
          ON CONFLICT(sync_space_id,local_account_id) DO UPDATE SET completed_at=excluded.completed_at
        `).run(context.syncSpaceId, accountId, Date.now())
      }, true)
    })
    return true
  }

  captureLibraryMutation<T>(accountId: number, mutate: () => T, selection: boolean | SyncLibrarySelection = false): T {
    const forceEmitCurrentState = selection === true
    const scope = typeof selection === 'object' ? selection : undefined
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()
    type LibraryRow = {
      type: 'group' | 'feed' | 'article'
      id: string
      fields: Record<string, unknown>
    }
    const read = (): Map<string, LibraryRow> => {
      const rows = new Map<string, LibraryRow>()
      for (const row of libraryRows({ database: this.database, accountId, scope, type: 'group' })) {
        rows.set('group:' + row.id, { type: 'group', id: String(row.id), fields: { name: row.name } })
      }
      for (const row of libraryRows({ database: this.database, accountId, scope, type: 'feed' })) {
        rows.set('feed:' + row.id, { type: 'feed', id: String(row.id), fields: {
          name: row.name, url: row.url, sourceType: row.source_type, icon: row.icon,
          groupLocalId: row.group_id, isNotification: row.is_notification === 1,
          isFullContent: row.is_full_content === 1, isBrowser: row.is_browser === 1
        } })
      }
      for (const row of libraryRows({ database: this.database, accountId, scope, type: 'article' })) {
        rows.set('article:' + row.id, { type: 'article', id: String(row.id), fields: {
          feedLocalId: row.feed_id,
          title: row.title,
          url: row.url ?? '',
          author: row.author,
          publishedAt: row.published_at ?? row.created_at,
          description: row.description,
          contentHtml: row.content_html ?? '',
          imageUrl: row.image_url,
          isUnread: row.is_unread === 1,
          isStarred: row.is_starred === 1,
          isReadLater: row.is_read_later === 1
        } })
      }
      return rows
    }
    const attempt = (): T => this.runtime.transaction(() => {
      const before = read()
      const result = mutate()
      const after = read()
      const state = new SyncStateRepository(this.database)
      const ensure = (
        type: 'group' | 'feed' | 'article',
        id: string,
        fields: Record<string, unknown>,
        reviveIfDeleted = false
      ): SyncIdentityMappingRecord => {
        const existing = this.identities.findByLocalId(context!.syncSpaceId, type, id)
        if (existing) {
          if (reviveIfDeleted) {
            const tombstone = this.database.prepare(
              'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
            ).get(context!.syncSpaceId, type, existing.syncId) as { generation: number } | undefined
            if (tombstone && tombstone.generation >= existing.generation) {
              const revived = { ...existing, generation: tombstone.generation + 1, updatedAt: Date.now() }
              this.identities.updateMappings([revived])
              return revived
            }
          }
          return existing
        }
        const now = Date.now()
        let canonicalKey: string | null = null
        if (type === 'feed') {
          canonicalKey = feedCandidateKey(
            String(fields.sourceType) as 'rss' | 'website' | 'json',
            String(fields.url)
          )
        } else if (type === 'article') {
          const feedId = String(fields.feedLocalId ?? '')
          const feed = after.get('feed:' + feedId) ?? before.get('feed:' + feedId)
          if (!feed) throw new Error(`Article ${id} has no local feed`)
          const feedMapping = ensure('feed', feed.id, feed.fields)
          canonicalKey = articleCandidateKey(feedMapping.canonicalKey, typeof fields.url === 'string' ? fields.url : null)
        }
        const mapping: SyncIdentityMappingRecord = {
          syncSpaceId: context!.syncSpaceId, entityType: type, localId: id, syncId: newSyncId(),
          canonicalKey,
          generation: 0, createdAt: now, updatedAt: now
        }
        this.identities.insertMapping(mapping)
        return mapping
      }
      // Map insertion order is Group -> Feed -> Article, so dependencies are mapped before use.
      for (const [key, row] of after) {
        const old = before.get(key)
        const known = this.identities.findByLocalId(context!.syncSpaceId, row.type, row.id)
        if (!forceEmitCurrentState && known && old && JSON.stringify(old.fields) === JSON.stringify(row.fields)) continue
        // 旧误删历史不改写；完整捕获以新 generation 恢复默认组，并重新签出 Feed 的父组版本。
        const restoreDefault = forceEmitCurrentState && row.type === 'group' &&
          isAccountDefaultGroup(this.database, { accountId, groupId: row.id })
        let mapping = ensure(row.type, row.id, row.fields, old == null || restoreDefault)
        // 创建时的 canonical key 与版本属于身份证据，修改 URL 不重写它。
        const fields = { ...row.fields }
        if (row.type === 'feed') {
          const groupId = String(fields.groupLocalId)
          const group = after.get('group:' + groupId)
          if (!group) throw new Error('Feed has no local group')
          const groupMapping = ensure('group', groupId, group.fields)
          fields.groupSyncId = groupMapping.syncId
          fields.groupGeneration = groupMapping.generation
          delete fields.groupLocalId
        }
        if (row.type === 'article') {
          const feedId = String(fields.feedLocalId)
          const feed = after.get('feed:' + feedId)
          if (!feed) throw new Error('Article has no local feed')
          const feedMapping = ensure('feed', feedId, feed.fields)
          fields.feedSyncId = feedMapping.syncId
          fields.feedGeneration = feedMapping.generation
          delete fields.feedLocalId
        }
        if (!forceEmitCurrentState && known && old) {
          for (const field of Object.keys(fields)) {
            const sourceField = field === 'groupSyncId'
              ? 'groupLocalId'
              : field === 'groupGeneration'
                ? 'groupLocalId'
              : field === 'feedSyncId'
                ? 'feedLocalId'
                : field === 'feedGeneration'
                  ? 'feedLocalId'
                : field
            if (JSON.stringify(row.fields[sourceField]) === JSON.stringify(old.fields[sourceField])) delete fields[field]
          }
        }
        const observedEntityVersion: Record<string, string> = {}
        for (const field of Object.keys(fields).sort()) {
          const previous = state.findFieldVersion(context!.syncSpaceId, row.type, mapping.syncId, field)
          if (previous?.entityGeneration === mapping.generation) {
            observedEntityVersion[field] = previous.versionToken
          }
        }
        const lane = row.type === 'article' ? 'ARTICLE_STATE' : 'LIBRARY'
        const outbox = this.allocator.allocate(context!, lane, {
          entityType: row.type, entitySyncId: mapping.syncId, entityGeneration: mapping.generation,
          mutationType: 'UPSERT', payloadJson: JSON.stringify({ fields }),
          observedEntityVersionJson: JSON.stringify(observedEntityVersion)
        })
        for (const [fieldId, value] of Object.entries(fields)) state.upsertFieldVersion({
          syncSpaceId: context!.syncSpaceId, entityType: row.type, entitySyncId: mapping.syncId,
          entityGeneration: mapping.generation, fieldId,
          versionToken: SyncVersionToken.operation(outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence),
          sourceOperationId: operationId(outbox.syncSpaceId, outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence),
          valueJson: JSON.stringify(value),
          causalContextJson: outbox.causalContextJson,
          logicalClock: outbox.sequence,
          updatedAt: outbox.createdAt
        })
      }
      const deletedRows = [...before.entries()]
        .filter(([key, row]) => !after.has(key) && !libraryRowExists({
          database: this.database, accountId, type: row.type, id: row.id
        }))
        .map(([, row]) => row)
        .sort((left, right) => {
          const rank = (type: LibraryRow['type']): number =>
            type === 'article' ? 0 : type === 'feed' ? 1 : type === 'group' ? 2 : 3
          return rank(left.type) - rank(right.type)
        })
      for (const row of deletedRows) {
        const mapping = ensure(row.type, row.id, row.fields)
        const lane = row.type === 'article' ? 'ARTICLE_STATE' : 'LIBRARY'
        const outbox = this.allocator.allocate(context!, lane, {
          entityType: row.type, entitySyncId: mapping.syncId, entityGeneration: mapping.generation,
          mutationType: 'GLOBAL_DELETE', payloadJson: '{}'
        })
        state.recordTombstone(context!.syncSpaceId, row.type, mapping.syncId, mapping.generation,
          SyncVersionToken.operation(outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence), outbox.createdAt,
          operationId(outbox.syncSpaceId, outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence))
        if (row.type === 'article') {
          this.blobs.removeOwnerReferences(
            context!.syncSpaceId,
            'ARTICLE_STATE',
            'article',
            mapping.syncId,
            mapping.generation
          )
        }
      }
      return result
    })
    try { return attempt() } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'library-outbox-witness-mismatch')
      return attempt()
    }
  }

  /**
   * CONFIG rules and Outbox share a SQLite transaction in the application runtime.
   * The compensating restore also supports legacy file-only repository callers.
   */
  captureFilterRulesMutation<T>(
    accountId: number,
    readRules: () => ArticleFilterRule[],
    replaceRules: (rules: ArticleFilterRule[]) => unknown,
    mutate: () => T
  ): T {
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): T => {
      const before = readRules().map((rule) => ({ ...rule }))
      try {
        return this.runtime.transaction(() => {
          const result = mutate()
          const after = readRules().map((rule) => ({ ...rule }))
          this.captureFilterRuleDiff(context!, before, after)
          return result
        })
      } catch (error) {
        if (JSON.stringify(readRules()) !== JSON.stringify(before)) replaceRules(before)
        throw error
      }
    }

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'config-outbox-witness-mismatch')
      return attempt()
    }
  }

  captureWebsiteRulesMutation<T>(
    accountId: number,
    readRules: () => WebsiteRule[],
    replaceRules: (rules: WebsiteRule[]) => unknown,
    mutate: () => T
  ): T {
    return this.captureAtomicConfigCollectionMutation(
      accountId,
      'website_rule',
      'rule',
      readRules,
      replaceRules,
      (rule) => rule.id,
      mutate
    )
  }

  captureJsonRulesMutation<T>(
    accountId: number,
    readRules: () => JsonRule[],
    replaceRules: (rules: JsonRule[]) => unknown,
    mutate: () => T
  ): T {
    return this.captureAtomicConfigCollectionMutation(
      accountId,
      'json_rule',
      'rule',
      readRules,
      replaceRules,
      (rule) => rule.id,
      mutate
    )
  }

  captureRssHubSettingsMutation<T>(
    accountId: number,
    readSettings: () => RssHubSettings,
    replaceSettings: (settings: RssHubSettings) => unknown,
    mutate: () => T
  ): T {
    return this.captureAtomicConfigCollectionMutation(
      accountId,
      'rsshub_settings',
      'settings',
      () => [readSettings()],
      (values) => {
        const settings = values[0]
        if (!settings) throw new Error('RSSHub settings capture produced no settings value')
        return replaceSettings(settings)
      },
      () => 'rsshub-settings',
      mutate
    )
  }

  captureWebsiteParsePreferenceMutation<T>(
    accountId: number,
    feedId: string,
    readState: () => WebsiteParsePreferenceUserSyncState | null,
    replaceState: (state: WebsiteParsePreferenceUserSyncState | null) => unknown,
    mutate: () => T
  ): T {
    return this.captureWebsiteParsePreferencesMutation(
      accountId,
      new Set([feedId]),
      () => new Map([[feedId, readState()]]),
      (states) => replaceState(states.get(feedId) ?? null),
      mutate
    )
  }

  captureWebsiteParsePreferencesMutation<T>(
    accountId: number,
    feedIds: Set<string>,
    readStates: () => Map<string, WebsiteParsePreferenceUserSyncState | null>,
    replaceStates: (states: Map<string, WebsiteParsePreferenceUserSyncState | null>) => unknown,
    mutate: () => T
  ): T {
    const orderedFeedIds = [...feedIds]
      .filter((feedId) => feedId.trim().length > 0)
      .filter((feedId, index, values) => values.indexOf(feedId) === index)
      .sort()
    if (orderedFeedIds.length === 0) return mutate()

    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): T => {
      const feedMappings = new Map(
        orderedFeedIds.map((localFeedId) => {
          const mapping = this.identities.findByLocalId(
            context!.syncSpaceId,
            'feed',
            localFeedId
          )
          if (!mapping) {
            throw new Error(
              'Website parse preference feed is not mapped: ' + localFeedId
            )
          }
          return [localFeedId, mapping] as const
        })
      )
      const normalized = (
        values: Map<string, WebsiteParsePreferenceUserSyncState | null>
      ): Map<string, WebsiteParsePreferenceUserSyncState | null> =>
        new Map(orderedFeedIds.map((feedId) => [feedId, values.get(feedId) ?? null]))
      const encoded = (
        states: Map<string, WebsiteParsePreferenceUserSyncState | null>
      ): Map<string, unknown> => {
        const result = new Map<string, unknown>()
        for (const localFeedId of orderedFeedIds) {
          const state = states.get(localFeedId)
          if (!state) continue
          const feedMapping = feedMappings.get(localFeedId)!
          const feedSyncId = feedMapping.syncId
          result.set(feedSyncId, {
            feedSyncId,
            feedGeneration: feedMapping.generation,
            dynamicRenderingEnabled: state.dynamicRenderingEnabled,
            preferredRuleId: state.preferredRuleId,
            preferredRuleName: state.preferredRuleName
          })
        }
        return result
      }
      const before = normalized(readStates())
      try {
        return this.runtime.transaction(() => {
          const result = mutate()
          const after = normalized(readStates())
          this.captureAtomicConfigEntityDiff(
            context!,
            'website_parse_preference',
            'preference',
            encoded(before),
            encoded(after)
          )
          return result
        })
      } catch (error) {
        replaceStates(before)
        throw error
      }
    }

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'config-outbox-witness-mismatch')
      return attempt()
    }
  }

  captureRssHubSubscriptionSourceMutation<T>(
    accountId: number,
    feedId: string,
    readState: () => string | null,
    replaceState: (state: string | null) => unknown,
    mutate: () => T
  ): T {
    return this.captureRssHubSubscriptionSourcesMutation(
      accountId,
      new Set([feedId]),
      () => new Map([[feedId, readState()]]),
      (states) => replaceState(states.get(feedId) ?? null),
      mutate
    )
  }

  captureRssHubSubscriptionSourcesMutation<T>(
    accountId: number,
    feedIds: Set<string>,
    readStates: () => Map<string, string | null>,
    replaceStates: (states: Map<string, string | null>) => unknown,
    mutate: () => T
  ): T {
    const orderedFeedIds = [...feedIds]
      .filter((feedId) => feedId.trim().length > 0)
      .filter((feedId, index, values) => values.indexOf(feedId) === index)
      .sort()
    if (orderedFeedIds.length === 0) return mutate()

    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): T => {
      const feedMappings = new Map(
        orderedFeedIds.map((localFeedId) => {
          const mapping = this.identities.findByLocalId(
            context!.syncSpaceId,
            'feed',
            localFeedId
          )
          if (!mapping) {
            throw new Error(
              'RSSHub subscription source feed is not mapped: ' + localFeedId
            )
          }
          return [localFeedId, mapping] as const
        })
      )
      const normalized = (values: Map<string, string | null>): Map<string, string | null> =>
        new Map(orderedFeedIds.map((feedId) => {
          const value = values.get(feedId)?.trim()
          return [feedId, value ? value : null]
        }))
      const encoded = (states: Map<string, string | null>): Map<string, unknown> => {
        const result = new Map<string, unknown>()
        for (const localFeedId of orderedFeedIds) {
          const sourceUrl = states.get(localFeedId)
          if (!sourceUrl) continue
          const feedMapping = feedMappings.get(localFeedId)!
          const feedSyncId = feedMapping.syncId
          result.set(feedSyncId, {
            feedSyncId,
            feedGeneration: feedMapping.generation,
            sourceUrl
          })
        }
        return result
      }
      const before = normalized(readStates())
      try {
        return this.runtime.transaction(() => {
          const result = mutate()
          const after = normalized(readStates())
          this.captureAtomicConfigEntityDiff(
            context!,
            'rsshub_subscription_source',
            'source',
            encoded(before),
            encoded(after)
          )
          return result
        })
      } catch (error) {
        replaceStates(before)
        throw error
      }
    }

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'config-outbox-witness-mismatch')
      return attempt()
    }
  }

  private captureAtomicConfigCollectionMutation<T, V>(
    accountId: number,
    entityType: 'website_rule' | 'json_rule' | 'rsshub_settings' | 'website_parse_preference' | 'rsshub_subscription_source',
    fieldId: 'rule' | 'settings' | 'preference' | 'source',
    readValues: () => V[],
    replaceValues: (values: V[]) => unknown,
    localIdOf: (value: V) => string,
    mutate: () => T
  ): T {
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): T => {
      const before = readValues()
      const beforeJson = JSON.stringify(before)
      try {
        return this.runtime.transaction(() => {
          const result = mutate()
          const after = readValues()
          this.captureAtomicConfigEntityDiff(
            context!,
            entityType,
            fieldId,
            new Map(before.map((value) => [localIdOf(value), value] as const)),
            new Map(after.map((value) => [localIdOf(value), value] as const))
          )
          return result
        })
      } catch (error) {
        if (JSON.stringify(readValues()) !== beforeJson) replaceValues(before)
        throw error
      }
    }

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'config-outbox-witness-mismatch')
      return attempt()
    }
  }

  private captureAtomicConfigEntityDiff<V>(
    context: SyncWritableActorContext,
    entityType: 'website_rule' | 'json_rule' | 'rsshub_settings' | 'website_parse_preference' | 'rsshub_subscription_source',
    fieldId: 'rule' | 'settings' | 'preference' | 'source',
    before: Map<string, V>,
    after: Map<string, V>
  ): void {
    const state = new SyncStateRepository(this.database)
    const ensureMapping = (
      localId: string,
      reviveIfDeleted = false
    ): SyncIdentityMappingRecord => {
      const existing = this.identities.findByLocalId(context.syncSpaceId, entityType, localId)
      if (existing) {
        if (reviveIfDeleted) {
          const tombstone = this.database.prepare(
            'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
          ).get(context.syncSpaceId, entityType, existing.syncId) as { generation: number } | undefined
          if (tombstone && tombstone.generation >= existing.generation) {
            const revived = {
              ...existing,
              generation: tombstone.generation + 1,
              updatedAt: Date.now()
            }
            this.identities.updateMappings([revived])
            return revived
          }
        }
        return existing
      }
      const syncId = configRuleSyncId(entityType, localId)
      const bySyncId = this.identities.findBySyncId(context.syncSpaceId, entityType, syncId)
      if (bySyncId) {
        if (bySyncId.localId !== localId) {
          throw new Error('CONFIG mapping collision for ' + entityType + '/' + localId)
        }
        if (reviveIfDeleted) {
          const tombstone = this.database.prepare(
            'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
          ).get(context.syncSpaceId, entityType, bySyncId.syncId) as { generation: number } | undefined
          if (tombstone && tombstone.generation >= bySyncId.generation) {
            const revived = {
              ...bySyncId,
              generation: tombstone.generation + 1,
              updatedAt: Date.now()
            }
            this.identities.updateMappings([revived])
            return revived
          }
        }
        return bySyncId
      }
      const now = Date.now()
      const mapping: SyncIdentityMappingRecord = {
        syncSpaceId: context.syncSpaceId,
        entityType,
        localId,
        syncId,
        canonicalKey: null,
        generation: 0,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
      return mapping
    }

    for (const [id, value] of after) {
      const previousValue = before.get(id)
      if (previousValue !== undefined && stableConfigJson(previousValue) === stableConfigJson(value)) continue
      const mapping = ensureMapping(id, !before.has(id))
      const previous = state.findFieldVersion(context.syncSpaceId, entityType, mapping.syncId, fieldId)
      const observed = previous?.entityGeneration === mapping.generation ? previous : null
      const outbox = this.allocator.allocate(context, 'CONFIG', {
        entityType,
        entitySyncId: mapping.syncId,
        entityGeneration: mapping.generation,
        mutationType: 'UPSERT',
        payloadJson: JSON.stringify({ fields: { [fieldId]: value } }),
        observedEntityVersionJson: JSON.stringify(observed ? { [fieldId]: observed.versionToken } : {})
      })
      state.upsertFieldVersion({
        syncSpaceId: context.syncSpaceId,
        entityType,
        entitySyncId: mapping.syncId,
        fieldId,
        entityGeneration: mapping.generation,
        versionToken: SyncVersionToken.operation(
          outbox.actorIncarnationId,
          outbox.replicationLaneId,
          outbox.sequence
        ),
        sourceOperationId: operationId(
          outbox.syncSpaceId,
          outbox.actorIncarnationId,
          outbox.replicationLaneId,
          outbox.sequence
        ),
        valueJson: JSON.stringify(value),
        causalContextJson: outbox.causalContextJson,
        logicalClock: outbox.sequence,
        updatedAt: outbox.createdAt
      })
    }

    for (const [id] of before) {
      if (after.has(id)) continue
      const mapping = ensureMapping(id)
      const outbox = this.allocator.allocate(context, 'CONFIG', {
        entityType,
        entitySyncId: mapping.syncId,
        entityGeneration: mapping.generation,
        mutationType: 'GLOBAL_DELETE',
        payloadJson: '{}'
      })
      state.recordTombstone(
        context.syncSpaceId,
        entityType,
        mapping.syncId,
        mapping.generation,
        SyncVersionToken.operation(
          outbox.actorIncarnationId,
          outbox.replicationLaneId,
          outbox.sequence
        ),
        outbox.createdAt,
        operationId(outbox.syncSpaceId, outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence)
      )
    }
  }

  /**
   * Repairs process-death drift for CONFIG repositories persisted outside SQLite.
   *
   * Call only after replaying durable pending Inbox operations. Current FieldVersion/Tombstone
   * state is the synchronized expectation; differences in actual become ordinary CONFIG Outbox
   * mutations through the same generation and causal path as live edits.
   */
  reconcileAtomicConfigState(
    accountId: number,
    entityType: 'website_rule' | 'json_rule' | 'rsshub_settings' | 'website_parse_preference' | 'rsshub_subscription_source',
    fieldId: 'rule' | 'settings' | 'preference' | 'source',
    actual: Map<string, unknown>
  ): number {
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return 0

    const attempt = (): number => this.runtime.transaction(() => {
      const state = new SyncStateRepository(this.database)
      const expected = new Map<string, unknown>()
      for (const mapping of this.identities.listByType(context!.syncSpaceId, entityType)) {
        const tombstone = this.database.prepare(
          'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
        ).get(context!.syncSpaceId, entityType, mapping.syncId) as { generation: number } | undefined
        if (tombstone && Number(tombstone.generation) >= mapping.generation) continue

        const version = state.findFieldVersion(
          context!.syncSpaceId,
          entityType,
          mapping.syncId,
          fieldId
        )
        if (!version || version.entityGeneration !== mapping.generation) continue
        try {
          expected.set(mapping.localId, JSON.parse(version.valueJson) as unknown)
        } catch (error) {
          throw new Error(
            'Malformed CONFIG field version for ' + entityType + '/' + mapping.syncId + ': ' +
              (error instanceof Error ? error.message : String(error))
          )
        }
      }

      const keys = new Set([...expected.keys(), ...actual.keys()])
      let changed = 0
      for (const key of keys) {
        const expectedHas = expected.has(key)
        const actualHas = actual.has(key)
        if (
          expectedHas !== actualHas ||
          (expectedHas && stableConfigJson(expected.get(key)) !== stableConfigJson(actual.get(key)))
        ) {
          changed++
        }
      }
      if (changed === 0) return 0

      this.captureAtomicConfigEntityDiff(context!, entityType, fieldId, expected, actual)
      return changed
    })

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'config-drift-outbox-witness-mismatch')
      return attempt()
    }
  }

  captureArticleField(
    accountId: number,
    articleIds: string[],
    field: 'isUnread' | 'isStarred' | 'isReadLater',
    value: boolean,
    mutate: () => void
  ): void {
    const distinctIds = [...new Set(articleIds)]
    if (distinctIds.length === 0) return mutate()

    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): void => {
      this.runtime.transaction(() => {
        const changedIds = this.filterActuallyChangingArticles(accountId, distinctIds, field, value)
        const mappings = changedIds.map((articleId) => this.ensureArticleMapping(context!, articleId))
        const state = new SyncStateRepository(this.database)
        for (const mapping of mappings) {
          const previous = state.findFieldVersion(context!.syncSpaceId, 'article', mapping.syncId, field)
          const outbox = this.allocator.allocate(context!, 'ARTICLE_STATE', {
            entityType: 'article',
            entitySyncId: mapping.syncId,
            entityGeneration: mapping.generation,
            mutationType: 'FIELD_SET',
            payloadJson: JSON.stringify({ field, value }),
            observedEntityVersionJson: JSON.stringify(previous ? { [field]: previous.versionToken } : {})
          })
          state.upsertFieldVersion({
            syncSpaceId: context!.syncSpaceId, entityType: 'article', entitySyncId: mapping.syncId,
            entityGeneration: mapping.generation, fieldId: field,
            versionToken: SyncVersionToken.operation(outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence),
            sourceOperationId: operationId(outbox.syncSpaceId, outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence),
            valueJson: JSON.stringify(value),
            causalContextJson: outbox.causalContextJson,
            logicalClock: outbox.sequence,
            updatedAt: outbox.createdAt
          })
        }
        mutate()
      })
    }

    try {
      attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'article-state-outbox-witness-mismatch')
      attempt()
    }
  }

  captureArticleFullContent(
    accountId: number,
    articleId: string,
    html: string,
    mutate: () => void
  ): void {
    if (!html.trim()) throw new Error('Article full content must not be blank')
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): void => {
      const reference = articleFullContentBlobRef(html)
      this.localBlobStore.putUtf8Text(reference, html)
      this.runtime.transaction(() => {
        const mapping = this.ensureArticleMapping(context!, articleId)
        this.blobs.registerManifest(reference.manifest, 'READY')
        this.blobs.replaceOwnerReference(
          context!.syncSpaceId,
          'ARTICLE_STATE',
          'article',
          mapping.syncId,
          mapping.generation,
          reference.referenceKind,
          reference.manifest.hash
        )
        this.localEviction.clearEvicted(
          context!.syncSpaceId,
          'article',
          mapping.syncId,
          mapping.generation,
          SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
        )

        const state = new SyncStateRepository(this.database)
        const previous = state.findFieldVersion(
          context!.syncSpaceId,
          'article',
          mapping.syncId,
          SYNC_ARTICLE_FULL_CONTENT_FIELD
        )
        const valueJson = JSON.stringify(reference.manifest.hash)
        if (previous?.valueJson !== valueJson) {
          const outbox = this.allocator.allocate(context!, 'ARTICLE_STATE', {
            entityType: 'article',
            entitySyncId: mapping.syncId,
            entityGeneration: mapping.generation,
            mutationType: 'FIELD_SET',
            payloadJson: JSON.stringify({
              field: SYNC_ARTICLE_FULL_CONTENT_FIELD,
              value: reference.manifest.hash,
              blobRefs: [reference]
            }),
            observedEntityVersionJson: JSON.stringify(
              previous ? { [SYNC_ARTICLE_FULL_CONTENT_FIELD]: previous.versionToken } : {}
            )
          })
          state.upsertFieldVersion({
            syncSpaceId: context!.syncSpaceId,
            entityType: 'article',
            entitySyncId: mapping.syncId,
            entityGeneration: mapping.generation,
            fieldId: SYNC_ARTICLE_FULL_CONTENT_FIELD,
            versionToken: SyncVersionToken.operation(
              outbox.actorIncarnationId,
              outbox.replicationLaneId,
              outbox.sequence
            ),
            sourceOperationId: operationId(
              outbox.syncSpaceId,
              outbox.actorIncarnationId,
              outbox.replicationLaneId,
              outbox.sequence
            ),
            valueJson,
            causalContextJson: outbox.causalContextJson,
            logicalClock: outbox.sequence,
            updatedAt: outbox.createdAt
          })
        }
        mutate()
      })
    }

    try {
      attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'article-full-content-outbox-witness-mismatch')
      attempt()
    }
  }

  markArticleFullContentEvicted(accountId: number, articleId: string): void {
    const binding = this.runtime.findBinding(accountId)
    if (!binding) return
    const mapping = this.identities.findByLocalId(binding.syncSpaceId, 'article', articleId)
    if (!mapping) return
    this.localEviction.markEvicted(
      binding.syncSpaceId,
      'article',
      mapping.syncId,
      mapping.generation,
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )
  }

  private captureFilterRuleDiff(
    context: SyncWritableActorContext,
    before: ArticleFilterRule[],
    after: ArticleFilterRule[]
  ): void {
    const beforeById = new Map(before.map((rule) => [rule.id, rule] as const))
    const afterById = new Map(after.map((rule) => [rule.id, rule] as const))
    const state = new SyncStateRepository(this.database)

    const ensureMapping = (
      rule: ArticleFilterRule,
      reviveIfDeleted = false
    ): SyncIdentityMappingRecord => {
      const existing = this.identities.findByLocalId(context.syncSpaceId, 'filter_rule', rule.id)
      if (existing) {
        if (reviveIfDeleted) {
          const tombstone = this.database.prepare(
            'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
          ).get(context.syncSpaceId, 'filter_rule', existing.syncId) as { generation: number } | undefined
          if (tombstone && tombstone.generation >= existing.generation) {
            const revived = {
              ...existing,
              generation: tombstone.generation + 1,
              updatedAt: Date.now()
            }
            this.identities.updateMappings([revived])
            return revived
          }
        }
        return existing
      }
      const now = Date.now()
      const mapping: SyncIdentityMappingRecord = {
        syncSpaceId: context.syncSpaceId,
        entityType: 'filter_rule',
        localId: rule.id,
        syncId: newSyncId(),
        canonicalKey: null,
        generation: 0,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(mapping)
      return mapping
    }

    const fieldsFor = (rule: ArticleFilterRule): Record<string, unknown> => {
      let feedSyncId: string | null = null
      let feedGeneration: number | null = null
      if (rule.feedId) {
        const feedMapping = this.identities.findByLocalId(context.syncSpaceId, 'feed', rule.feedId)
        if (!feedMapping) {
          throw new Error('Filter rule ' + rule.id + ' references a feed with no Sync mapping')
        }
        feedSyncId = feedMapping.syncId
        feedGeneration = feedMapping.generation
      }
      return {
        keyword: rule.keyword,
        feedSyncId,
        feedGeneration,
        feedName: rule.feedName,
        type: rule.type,
        enabled: rule.enabled
      }
    }

    for (const [id, rule] of afterById) {
      const previousRule = beforeById.get(id)
      if (previousRule && JSON.stringify(previousRule) === JSON.stringify(rule)) continue
      const mapping = ensureMapping(rule, !beforeById.has(id))
      const fields = fieldsFor(rule)
      const observed: Record<string, string> = {}
      for (const field of Object.keys(fields)) {
        const current = state.findFieldVersion(context.syncSpaceId, 'filter_rule', mapping.syncId, field)
        if (current?.entityGeneration === mapping.generation) observed[field] = current.versionToken
      }
      const outbox = this.allocator.allocate(context, 'CONFIG', {
        entityType: 'filter_rule',
        entitySyncId: mapping.syncId,
        entityGeneration: mapping.generation,
        mutationType: 'UPSERT',
        payloadJson: JSON.stringify({ fields }),
        observedEntityVersionJson: JSON.stringify(observed)
      })
      const versionToken = SyncVersionToken.operation(
        outbox.actorIncarnationId,
        outbox.replicationLaneId,
        outbox.sequence
      )
      const sourceOperationId = operationId(
        outbox.syncSpaceId,
        outbox.actorIncarnationId,
        outbox.replicationLaneId,
        outbox.sequence
      )
      for (const [fieldId, value] of Object.entries(fields)) {
        state.upsertFieldVersion({
          syncSpaceId: context.syncSpaceId,
          entityType: 'filter_rule',
          entitySyncId: mapping.syncId,
          fieldId,
          entityGeneration: mapping.generation,
          versionToken,
          sourceOperationId,
          valueJson: JSON.stringify(value),
          causalContextJson: outbox.causalContextJson,
          logicalClock: outbox.sequence,
          updatedAt: outbox.createdAt
        })
      }
    }

    for (const [id, rule] of beforeById) {
      if (afterById.has(id)) continue
      const mapping = ensureMapping(rule)
      const outbox = this.allocator.allocate(context, 'CONFIG', {
        entityType: 'filter_rule',
        entitySyncId: mapping.syncId,
        entityGeneration: mapping.generation,
        mutationType: 'GLOBAL_DELETE',
        payloadJson: '{}'
      })
      state.recordTombstone(
        context.syncSpaceId,
        'filter_rule',
        mapping.syncId,
        mapping.generation,
        SyncVersionToken.operation(
          outbox.actorIncarnationId,
          outbox.replicationLaneId,
          outbox.sequence
        ),
        outbox.createdAt,
        operationId(outbox.syncSpaceId, outbox.actorIncarnationId, outbox.replicationLaneId, outbox.sequence)
      )
    }
  }

  private filterActuallyChangingArticles(
    accountId: number,
    articleIds: string[],
    field: 'isUnread' | 'isStarred' | 'isReadLater',
    value: boolean
  ): string[] {
    const column = field === 'isUnread' ? 'is_unread' : field === 'isReadLater' ? 'is_read_later' : 'is_starred'
    const expected = value ? 1 : 0
    const result: string[] = []
    const chunkSize = 700
    for (let offset = 0; offset < articleIds.length; offset += chunkSize) {
      const chunk = articleIds.slice(offset, offset + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.database.prepare(`
        SELECT id FROM articles
        WHERE account_id=? AND id IN (${placeholders}) AND ${column} != ?
      `).all(accountId, ...chunk, expected) as unknown as Array<{ id: string }>
      result.push(...rows.map((row) => row.id))
    }
    return result
  }

  private ensureArticleMapping(context: SyncWritableActorContext, articleId: string): SyncIdentityMappingRecord {
    const existing = this.identities.findByLocalId(context.syncSpaceId, 'article', articleId)
    if (existing) return existing

    const article = this.database.prepare(`
      SELECT a.feed_id,a.url,f.source_type,f.url AS feed_url
      FROM articles a
      JOIN feeds f ON f.id=a.feed_id AND f.account_id=a.account_id
      WHERE a.account_id=? AND a.id=?
      LIMIT 1
    `).get(context.localAccountId, articleId) as {
      feed_id: string
      url: string | null
      source_type: 'rss' | 'website' | 'json'
      feed_url: string
    } | undefined
    if (!article) throw new Error(`Cannot create Sync mapping for missing article ${articleId}`)

    let feedMapping = this.identities.findByLocalId(context.syncSpaceId, 'feed', article.feed_id)
    if (!feedMapping) {
      const now = Date.now()
      feedMapping = {
        syncSpaceId: context.syncSpaceId,
        entityType: 'feed',
        localId: article.feed_id,
        syncId: newSyncId(),
        canonicalKey: feedCandidateKey(article.source_type, article.feed_url),
        generation: 0,
        createdAt: now,
        updatedAt: now
      }
      this.identities.insertMapping(feedMapping)
    }

    const now = Date.now()
    const mapping: SyncIdentityMappingRecord = {
      syncSpaceId: context.syncSpaceId,
      entityType: 'article',
      localId: articleId,
      syncId: newSyncId(),
      canonicalKey: articleCandidateKey(feedMapping.canonicalKey, article.url),
      generation: 0,
      createdAt: now,
      updatedAt: now
    }
    this.identities.insertMapping(mapping)
    return mapping
  }
}

function stableConfigJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(stableConfigJson).join(',') + ']'
  if (typeof value === 'object') {
    return '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ':' + stableConfigJson(item))
        .join(',') +
      '}'
  }
  return 'null'
}
