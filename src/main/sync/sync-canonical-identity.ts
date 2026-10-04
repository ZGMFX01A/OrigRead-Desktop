import { createHash, randomUUID } from 'node:crypto'
import type { SourceType } from '../../shared/library'
import type { SyncEntityType } from '../../shared/sync-identity'
import { sourceUrlComparisonKey, legacySourceUrlComparisonKey } from '../../shared/source-url-normalizer'

/** 历史 v1 算法及签名 fixture 保持固定。 */
export const SYNC_CANONICAL_KEY_VERSION = 1
/** 新候选保留百分号、尾斜杠及业务 query，不授权自动 Alias。 */
export const SYNC_CANDIDATE_KEY_VERSION = 2
export const SYNC_RELATION_ID_VERSION = 1
export const SYNC_CONFIG_RULE_ID_VERSION = 1

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** R10 canonicalSourceKey v1. Mirrors Android SyncCanonicalIdentity exactly. */
export function feedCanonicalKey(sourceType: SourceType, sourceUrl: string): string {
  const normalizedType = sourceType.trim().toLowerCase()
  const normalizedUrl = legacySourceUrlComparisonKey(sourceUrl)
  return `feed:v${SYNC_CANONICAL_KEY_VERSION}:${sha256Framed(normalizedType, normalizedUrl)}`
}

/**
 * Genesis v1 only uses the high-confidence article link already persisted on both platforms.
 * Missing links deliberately produce no canonical key instead of guessing from title/time.
 */
export function articleCanonicalKey(feedKey: string | null | undefined, articleLink: string | null | undefined): string | null {
  if (!feedKey?.trim()) return null
  const link = articleLink?.trim()
  if (!link) return null
  const normalizedLink = legacySourceUrlComparisonKey(link)
  return `article:v${SYNC_CANONICAL_KEY_VERSION}:${sha256Framed(feedKey, 'link', normalizedLink)}`
}

/** 新 Feed 身份的 v2 候选；旧映射不重算。 */
export function feedCandidateKey(sourceType: SourceType, sourceUrl: string): string {
  return `feed:v${SYNC_CANDIDATE_KEY_VERSION}:${sha256Framed(sourceType.trim().toLowerCase(), sourceUrlComparisonKey(sourceUrl))}`
}

/** 新 Article 的 link-only 候选不能独自证明实体等价。 */
export function articleCandidateKey(feedKey: string | null | undefined, link: string | null | undefined): string | null {
  if (!feedKey?.trim() || !link?.trim()) return null
  return `article:v${SYNC_CANDIDATE_KEY_VERSION}:${sha256Framed(feedKey, 'link', sourceUrlComparisonKey(link))}`
}

export function newSyncId(): string {
  return randomUUID()
}

/** UUID-backed local records may adopt the UUID value as Sync ID, but still go through Mapping. */
export function adoptUuidOrNull(localId: string): string | null {
  const trimmed = localId.trim()
  return CANONICAL_UUID.test(trimmed) ? trimmed.toLowerCase() : null
}

export function relationSyncId(entityType: SyncEntityType, ...endpointSyncIds: string[]): string {
  return `rel:v${SYNC_RELATION_ID_VERSION}:${sha256Framed(entityType, ...endpointSyncIds)}`
}

export function relationLocalId(entityType: SyncEntityType, ...endpointLocalIds: string[]): string {
  return `local-rel:v${SYNC_RELATION_ID_VERSION}:${sha256Framed(entityType, ...endpointLocalIds)}`
}

export function configRuleSyncId(entityType: SyncEntityType, ruleId: string): string {
  return `cfg:v${SYNC_CONFIG_RULE_ID_VERSION}:${sha256Framed(entityType, ruleId.trim())}`
}

function sha256Framed(...parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length, 0)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest('hex')
}
