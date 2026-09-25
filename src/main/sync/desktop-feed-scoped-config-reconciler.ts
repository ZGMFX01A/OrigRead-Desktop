import type { DatabaseSync } from 'node:sqlite'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import { DesktopLibrarySyncMutationCapture } from './library-sync-mutation-capture'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'

/**
 * Repairs the crash window between a durable Feed GLOBAL_DELETE and follow-up CONFIG cleanup.
 *
 * A Feed Tombstone is the durable fact. If that same-or-newer generation is deleted but
 * feed-scoped CONFIG projection state survived locally, remove it and emit the missing CONFIG
 * Tombstone before the next anti-entropy session.
 */
export class DesktopFeedScopedConfigReconciler {
  private readonly identities: SyncIdentityRepository

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly syncMutations: DesktopLibrarySyncMutationCapture,
    private readonly articleFilters: ArticleFilterRepository,
    private readonly websitePreferences: WebsiteParsePreferenceRepository
  ) {
    this.identities = new SyncIdentityRepository(database)
  }

  reconcile(syncSpaceId: string): number {
    const binding = this.runtime.findBindingBySpace(syncSpaceId)
    if (!binding || binding.lifecycleState !== 'ACTIVE') return 0
    if (!this.runtime.findActiveActor(syncSpaceId)) return 0

    const orphanFeedIds = new Set(
      this.identities.listByType(syncSpaceId, 'feed')
        .filter((mapping) => {
          const feed = this.database.prepare('SELECT 1 FROM feeds WHERE id=? LIMIT 1').get(mapping.localId)
          if (feed) return false
          const tombstone = this.database.prepare(
            "SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type='feed' AND entity_sync_id=? LIMIT 1"
          ).get(syncSpaceId, mapping.syncId) as { generation: number } | undefined
          return Boolean(tombstone && tombstone.generation >= mapping.generation)
        })
        .map((mapping) => mapping.localId)
    )
    if (!orphanFeedIds.size) return 0

    this.syncMutations.captureFilterRulesMutation(
      binding.localAccountId,
      () => this.articleFilters.getAll(),
      (rules) => this.articleFilters.replaceRules(rules),
      () => {
        for (const feedId of orphanFeedIds) this.articleFilters.deleteByFeed(feedId)
      }
    )

    this.syncMutations.captureWebsiteParsePreferencesMutation(
      binding.localAccountId,
      orphanFeedIds,
      () => new Map(
        [...orphanFeedIds].map((feedId) => [
          feedId,
          this.websitePreferences.getUserSyncState(feedId)
        ])
      ),
      (states) => {
        for (const [feedId, state] of states) {
          this.websitePreferences.applyUserSyncState(feedId, state)
        }
      },
      () => {
        for (const feedId of orphanFeedIds) {
          this.websitePreferences.applyUserSyncState(feedId, null)
        }
      }
    )

    // User-synchronized fields are cleared above. Automatic detector/cache state is device-local.
    for (const feedId of orphanFeedIds) this.websitePreferences.delete(feedId)
    return orphanFeedIds.size
  }
}
