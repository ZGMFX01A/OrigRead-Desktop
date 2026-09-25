import type { DatabaseSync } from 'node:sqlite'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { DesktopLibrarySyncMutationCapture } from './library-sync-mutation-capture'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'

/**
 * Repairs the process-death window for CONFIG persisted in JSON files outside SQLite.
 *
 * Durable Inbox replay runs before this reconciler. Therefore any remaining difference between
 * file state and CONFIG FieldVersion/Tombstone metadata represents a local write that survived
 * while its SQLite Outbox transaction did not, and can safely be re-emitted as a local mutation.
 */
export class DesktopExternalConfigReconciler {
  private readonly identities: SyncIdentityRepository

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly syncMutations: DesktopLibrarySyncMutationCapture,
    private readonly websiteRules: WebsiteRuleRepository,
    private readonly jsonRules: JsonRuleRepository,
    private readonly websitePreferences: WebsiteParsePreferenceRepository
  ) {
    this.identities = new SyncIdentityRepository(database)
  }

  reconcile(syncSpaceId: string): number {
    const binding = this.runtime.findBindingBySpace(syncSpaceId)
    if (!binding || binding.lifecycleState !== 'ACTIVE') return 0
    if (!this.runtime.findActiveActor(syncSpaceId)) return 0

    let changed = 0
    changed += this.syncMutations.reconcileAtomicConfigState(
      binding.localAccountId,
      'website_rule',
      'rule',
      new Map(this.websiteRules.listSyncRules().map((rule) => [rule.id, rule] as const))
    )
    changed += this.syncMutations.reconcileAtomicConfigState(
      binding.localAccountId,
      'json_rule',
      'rule',
      new Map(this.jsonRules.listSyncRules().map((rule) => [rule.id, rule] as const))
    )

    const preferenceState = new Map<string, unknown>()
    const liveFeeds = this.database.prepare(
      'SELECT id FROM feeds WHERE account_id=? ORDER BY id'
    ).all(binding.localAccountId) as unknown as Array<{ id: string }>
    for (const feed of liveFeeds) {
      const feedMapping = this.identities.findByLocalId(syncSpaceId, 'feed', feed.id)
      if (!feedMapping) {
        throw new Error('Active Feed has no Sync mapping during CONFIG reconciliation: ' + feed.id)
      }
      const state = this.websitePreferences.getUserSyncState(feed.id)
      if (!state) continue
      preferenceState.set(feedMapping.syncId, {
        feedSyncId: feedMapping.syncId,
        feedGeneration: feedMapping.generation,
        dynamicRenderingEnabled: state.dynamicRenderingEnabled,
        preferredRuleId: state.preferredRuleId,
        preferredRuleName: state.preferredRuleName
      })
    }
    changed += this.syncMutations.reconcileAtomicConfigState(
      binding.localAccountId,
      'website_parse_preference',
      'preference',
      preferenceState
    )
    return changed
  }
}
