import type { DatabaseSync } from 'node:sqlite'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import type { SourceType } from '../../shared/library'
import type { SyncEntityType, SyncIdentityMappingRecord } from '../../shared/sync-identity'
import {
  adoptUuidOrNull,
  articleCanonicalKey,
  configRuleSyncId,
  feedCanonicalKey,
  newSyncId,
  relationLocalId,
  relationSyncId
} from './sync-canonical-identity'
import { SyncIdentityRepository } from './sync-identity-repository'

interface IdentitySeed {
  localId: string
  canonicalKey?: string | null
  preferredSyncId?: string | null
}

export interface SyncCanonicalKeyConflict {
  entityType: SyncEntityType
  localId: string
  storedCanonicalKey: string
  candidateCanonicalKey: string
}

export interface SyncIdentityTypeBackfillResult {
  entityType: SyncEntityType
  scanned: number
  created: number
  canonicalKeysFilled: number
  conflicts: SyncCanonicalKeyConflict[]
}

export interface GenesisIdentityBackfillReport {
  syncSpaceId: string
  results: SyncIdentityTypeBackfillResult[]
  scanned: number
  created: number
  canonicalKeysFilled: number
  conflicts: SyncCanonicalKeyConflict[]
}

interface FeedIdentityRow { id: string; source_type: SourceType; url: string }
interface ArticleIdentityRow { id: string; feed_id: string; url: string | null }
interface RssHubSourceIdentityRow { feed_id: string; source_url: string }
interface IdRow { id: string }
interface ArticleRefRow { article_id: string | null }
interface ConversationArticleRow { conversation_id: string; article_id: string }
interface AnnotationRefRow { annotation_id: string; citation_ref_id: string }

/**
 * Desktop Genesis identity primitive. It creates no Operation and must not be used as the final
 * sync-enable cutover until Transactional Outbox / GENESIS_CAPTURING exists.
 */
export class GenesisIdentityBackfillService {
  private readonly identities: SyncIdentityRepository

  constructor(
    private readonly database: DatabaseSync,
    private readonly articleFilters: ArticleFilterRepository,
    private readonly websiteRules?: WebsiteRuleRepository,
    private readonly jsonRules?: JsonRuleRepository,
    private readonly rssHubSettings?: RssHubSettingsRepository,
    private readonly websiteParsePreferences?: WebsiteParsePreferenceRepository
  ) {
    this.identities = new SyncIdentityRepository(database)
  }

  backfill(syncSpaceId: string, accountId: number, now = Date.now()): GenesisIdentityBackfillReport {
    if (!syncSpaceId.trim()) throw new Error('syncSpaceId must not be blank')
    const account = this.database.prepare('SELECT type FROM accounts WHERE id=?').get(accountId) as { type: string } | undefined
    if (!account) throw new Error(`Account ${accountId} does not exist`)
    if (account.type !== 'local') {
      throw new Error(`R10 Genesis Library backfill only supports Local Account; account=${accountId} type=${account.type}`)
    }

    const groups = this.database.prepare('SELECT id FROM groups WHERE account_id=? ORDER BY id').all(accountId) as unknown as IdRow[]
    const feeds = this.database.prepare('SELECT id,source_type,url FROM feeds WHERE account_id=? ORDER BY id').all(accountId) as unknown as FeedIdentityRow[]
    const articles = this.database.prepare('SELECT id,feed_id,url FROM articles WHERE account_id=? ORDER BY id').all(accountId) as unknown as ArticleIdentityRow[]
    const filterRules = this.articleFilters.getAll()
    const websiteRules = this.websiteRules?.listSyncRules() ?? []
    const jsonRules = this.jsonRules?.listSyncRules() ?? []
    const websiteParsePreferences =
      this.websiteParsePreferences?.listUserSyncStates(new Set(feeds.map((row) => row.id))) ?? new Map()
    const rssHubSubscriptionSources = this.database.prepare(
      'SELECT r.feed_id,r.source_url FROM rsshub_source_urls r JOIN feeds f ON f.id=r.feed_id WHERE f.account_id=? ORDER BY r.feed_id'
    ).all(accountId) as unknown as RssHubSourceIdentityRow[]

    const conversationArticleRows = this.database.prepare(
      'SELECT conversation_id,article_id FROM llm_conversation_articles ORDER BY conversation_id,article_id'
    ).all() as unknown as ConversationArticleRow[]
    const referencedArticleIds = new Set<string>()
    const articleRefQueries = [
      'SELECT article_id FROM llm_conversations WHERE article_id IS NOT NULL',
      'SELECT article_id FROM llm_context_refs WHERE article_id IS NOT NULL'
    ]
    for (const query of articleRefQueries) {
      const rows = this.database.prepare(query).all() as unknown as ArticleRefRow[]
      for (const row of rows) if (row.article_id) referencedArticleIds.add(row.article_id)
    }
    for (const row of conversationArticleRows) referencedArticleIds.add(row.article_id)

    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.identities.insertSpaceIgnore({ syncSpaceId, createdAt: now, updatedAt: now })
      const results: SyncIdentityTypeBackfillResult[] = []

      results.push(this.backfillType(syncSpaceId, 'group', groups.map((row) => ({ localId: row.id })), now))
      results.push(this.backfillType(syncSpaceId, 'feed', feeds.map((row) => ({
        localId: row.id,
        canonicalKey: feedCanonicalKey(row.source_type, row.url)
      })), now))

      const effectiveFeedKeys = new Map(
        this.identities.listByType(syncSpaceId, 'feed').map((mapping) => [mapping.localId, mapping.canonicalKey] as const)
      )
      const effectiveFeedSyncIds = new Map(
        this.identities.listByType(syncSpaceId, 'feed').map((mapping) => [mapping.localId, mapping.syncId] as const)
      )
      const articleSeeds: IdentitySeed[] = articles.map((row) => ({
        localId: row.id,
        canonicalKey: articleCanonicalKey(effectiveFeedKeys.get(row.feed_id), row.url)
      }))
      const persistedArticleIds = new Set(articles.map((row) => row.id))
      for (const articleId of referencedArticleIds) {
        if (!persistedArticleIds.has(articleId)) articleSeeds.push({ localId: articleId, canonicalKey: null })
      }
      results.push(this.backfillType(syncSpaceId, 'article', articleSeeds, now))

      results.push(this.backfillType(syncSpaceId, 'filter_rule', filterRules.map((rule) => ({
        localId: rule.id,
        preferredSyncId: adoptUuidOrNull(rule.id)
      })), now))

      if (this.websiteRules) {
        results.push(this.backfillType(syncSpaceId, 'website_rule', websiteRules.map((rule) => ({
          localId: rule.id,
          preferredSyncId: configRuleSyncId('website_rule', rule.id)
        })), now))
      }
      if (this.jsonRules) {
        results.push(this.backfillType(syncSpaceId, 'json_rule', jsonRules.map((rule) => ({
          localId: rule.id,
          preferredSyncId: configRuleSyncId('json_rule', rule.id)
        })), now))
      }
      if (this.rssHubSettings) {
        results.push(this.backfillType(
          syncSpaceId,
          'rsshub_settings',
          [{
            localId: 'rsshub-settings',
            preferredSyncId: configRuleSyncId('rsshub_settings', 'rsshub-settings')
          }],
          now
        ))
      }
      if (websiteParsePreferences.size > 0) {
        results.push(this.backfillType(
          syncSpaceId,
          'website_parse_preference',
          [...websiteParsePreferences.keys()].map((localFeedId) => {
            const feedSyncId = effectiveFeedSyncIds.get(localFeedId)
            if (!feedSyncId) {
              throw new Error('Website parse preference references an unmapped feed ' + localFeedId)
            }
            return {
              localId: feedSyncId,
              preferredSyncId: configRuleSyncId('website_parse_preference', feedSyncId)
            }
          }),
          now
        ))
      }

      if (rssHubSubscriptionSources.length > 0) {
        results.push(this.backfillType(
          syncSpaceId,
          'rsshub_subscription_source',
          rssHubSubscriptionSources.map((row) => {
            const feedSyncId = effectiveFeedSyncIds.get(row.feed_id)
            if (!feedSyncId) {
              throw new Error('RSSHub subscription source references an unmapped feed ' + row.feed_id)
            }
            return {
              localId: feedSyncId,
              preferredSyncId: configRuleSyncId('rsshub_subscription_source', feedSyncId)
            }
          }),
          now
        ))
      }

      results.push(this.backfillUuidTable(syncSpaceId, 'conversation', 'llm_conversations', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'message', 'llm_messages', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'tool_call', 'llm_tool_calls', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'context_ref', 'llm_context_refs', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'evidence_block', 'llm_evidence_blocks', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'citation_ref', 'llm_citation_refs', now))
      results.push(this.backfillUuidTable(syncSpaceId, 'citation_annotation', 'llm_citation_annotations', now))

      const conversationMappings = new Map(
        this.identities.listByType(syncSpaceId, 'conversation').map((mapping) => [mapping.localId, mapping.syncId] as const)
      )
      const articleMappings = new Map(
        this.identities.listByType(syncSpaceId, 'article').map((mapping) => [mapping.localId, mapping.syncId] as const)
      )
      results.push(this.backfillType(
        syncSpaceId,
        'conversation_article',
        conversationArticleRows.map((row) => {
          const conversationSyncId = requiredMapping(conversationMappings, row.conversation_id, 'conversation')
          const articleSyncId = requiredMapping(articleMappings, row.article_id, 'article')
          return {
            localId: relationLocalId('conversation_article', row.conversation_id, row.article_id),
            preferredSyncId: relationSyncId('conversation_article', conversationSyncId, articleSyncId)
          }
        }),
        now
      ))

      const annotationMappings = new Map(
        this.identities.listByType(syncSpaceId, 'citation_annotation').map((mapping) => [mapping.localId, mapping.syncId] as const)
      )
      const citationMappings = new Map(
        this.identities.listByType(syncSpaceId, 'citation_ref').map((mapping) => [mapping.localId, mapping.syncId] as const)
      )
      const annotationRefRows = this.database.prepare(
        'SELECT annotation_id,citation_ref_id FROM llm_citation_annotation_refs ORDER BY annotation_id,citation_ref_id'
      ).all() as unknown as AnnotationRefRow[]
      results.push(this.backfillType(
        syncSpaceId,
        'citation_annotation_ref',
        annotationRefRows.map((row) => ({
          localId: relationLocalId('citation_annotation_ref', row.annotation_id, row.citation_ref_id),
          preferredSyncId: relationSyncId(
            'citation_annotation_ref',
            requiredMapping(annotationMappings, row.annotation_id, 'citation_annotation'),
            requiredMapping(citationMappings, row.citation_ref_id, 'citation_ref')
          )
        })),
        now
      ))

      this.database.exec('COMMIT')
      const conflicts = results.flatMap((result) => result.conflicts)
      return {
        syncSpaceId,
        results,
        scanned: results.reduce((sum, result) => sum + result.scanned, 0),
        created: results.reduce((sum, result) => sum + result.created, 0),
        canonicalKeysFilled: results.reduce((sum, result) => sum + result.canonicalKeysFilled, 0),
        conflicts
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private backfillUuidTable(
    syncSpaceId: string,
    entityType: SyncEntityType,
    table: string,
    now: number
  ): SyncIdentityTypeBackfillResult {
    // table values are internal constants from the call sites above, not user input.
    const rows = this.database.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as unknown as IdRow[]
    return this.backfillType(syncSpaceId, entityType, rows.map((row) => ({
      localId: row.id,
      preferredSyncId: adoptUuidOrNull(row.id)
    })), now)
  }

  private backfillType(
    syncSpaceId: string,
    entityType: SyncEntityType,
    seeds: IdentitySeed[],
    now: number
  ): SyncIdentityTypeBackfillResult {
    const distinct = new Map<string, IdentitySeed>()
    for (const seed of seeds) if (!distinct.has(seed.localId)) distinct.set(seed.localId, seed)
    const normalizedSeeds = [...distinct.values()]
    for (const seed of normalizedSeeds) if (!seed.localId.trim()) throw new Error(`${entityType} localId must not be blank`)

    const existing = new Map(
      this.identities.listByType(syncSpaceId, entityType).map((mapping) => [mapping.localId, mapping] as const)
    )
    const inserts: SyncIdentityMappingRecord[] = []
    const updates: SyncIdentityMappingRecord[] = []
    const conflicts: SyncCanonicalKeyConflict[] = []

    for (const seed of normalizedSeeds) {
      const stored = existing.get(seed.localId)
      if (!stored) {
        inserts.push({
          syncSpaceId,
          entityType,
          localId: seed.localId,
          syncId: seed.preferredSyncId ?? newSyncId(),
          canonicalKey: seed.canonicalKey ?? null,
          generation: 0,
          createdAt: now,
          updatedAt: now
        })
        continue
      }
      const candidate = seed.canonicalKey ?? null
      if (stored.canonicalKey === null && candidate !== null) {
        updates.push({ ...stored, canonicalKey: candidate, updatedAt: now })
      } else if (stored.canonicalKey !== null && candidate !== null && stored.canonicalKey !== candidate) {
        conflicts.push({
          entityType,
          localId: seed.localId,
          storedCanonicalKey: stored.canonicalKey,
          candidateCanonicalKey: candidate
        })
      }
    }

    this.identities.insertMappingsIgnore(inserts)
    this.identities.updateMappings(updates)
    const finalLocalIds = new Set(this.identities.listByType(syncSpaceId, entityType).map((mapping) => mapping.localId))
    const missing = normalizedSeeds.map((seed) => seed.localId).filter((localId) => !finalLocalIds.has(localId))
    if (missing.length > 0) {
      throw new Error(`Identity backfill left unmapped ${entityType} rows: ${missing.slice(0, 3).join(', ')}`)
    }
    return {
      entityType,
      scanned: normalizedSeeds.length,
      created: inserts.length,
      canonicalKeysFilled: updates.length,
      conflicts
    }
  }
}

function requiredMapping(map: Map<string, string>, localId: string, entityType: string): string {
  const value = map.get(localId)
  if (!value) throw new Error(`Missing ${entityType} Sync ID for localId=${localId}`)
  return value
}
