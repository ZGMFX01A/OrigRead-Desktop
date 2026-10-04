import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { SqliteConfigDocument } from '../sources/config-document'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { DesktopAiHistoryApplier } from './desktop-ai-history-applier'
import { DesktopSyncBusinessApplier } from './desktop-sync-business-applier'
import { SyncApplyCoordinator } from './sync-apply-coordinator'
import { DesktopSnapshotInstallService } from './desktop-snapshot-install-service'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'

/** Worker 组装与主进程相同的正式仓库及投影，无替代授权、模拟业务或额外协议。 */
export function snapshotInstallRuntime(input: { database: DatabaseSync; userData: string; blobRoot: string }): DesktopSnapshotInstallService {
  const db = input.database
  const document = (file: string) => new SqliteConfigDocument({ database: db, legacyFile: join(input.userData, file) })
  const filters = new ArticleFilterRepository(join(input.userData, 'article-filter-rules.json'), db)
  const website = new WebsiteRuleRepository(document('website-rules.json'))
  const json = new JsonRuleRepository(document('json-source-rules.json'))
  const rsshub = new RssHubSettingsRepository(db)
  const preferences = new WebsiteParsePreferenceRepository(document('website-parse-preferences.json'))
  const runtime = new SyncRuntimeRepository(db)
  const state = new SyncStateRepository(db)
  const blobs = new DesktopSyncLocalBlobStore(input.blobRoot)
  const ai = new DesktopAiHistoryApplier(db, state, blobs)
  const business = new DesktopSyncBusinessApplier(db, state, ai, blobs, filters, website, json, rsshub, preferences)
  const apply = new SyncApplyCoordinator(runtime, state, business)
  return new DesktopSnapshotInstallService(db, runtime, state, filters, ai, business, website, json, rsshub, preferences, { apply })
}
