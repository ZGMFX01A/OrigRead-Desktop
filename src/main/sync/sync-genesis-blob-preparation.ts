import type { DatabaseSync } from 'node:sqlite'
import type { DesktopSyncBlobStateService } from './sync-blob-state'
import type { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { articleFullContentBlobRef, SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND } from './sync-blob-payload'

interface Preparation {
  database: DatabaseSync
  state: DesktopSyncBlobStateService
  blobs?: DesktopSyncLocalBlobStore
  accountId: number
  space: string
  now: number
}

/** 在 cut 之前补齐没有引用的旧正文；正常新写入已经由 mutation 事务登记 Blob。 */
export async function prepareGenesisArticleBlobs(input: Preparation): Promise<void> {
  let after = ''
  for (;;) {
    const row = input.database.prepare(`SELECT a.id,a.full_content_html,m.sync_id,m.generation
      FROM articles a JOIN sync_identity_mapping m ON m.local_id=a.id AND m.entity_type='article' AND m.sync_space_id=?
      WHERE a.account_id=? AND a.id>? AND a.full_content_html IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM sync_blob_reference r WHERE r.sync_space_id=m.sync_space_id AND r.replication_lane_id='ARTICLE_STATE'
        AND r.owner_entity_type='article' AND r.owner_entity_sync_id=m.sync_id AND r.owner_entity_generation=m.generation AND r.reference_kind=?)
      ORDER BY a.id LIMIT 1`).get(input.space, input.accountId, after, SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND)
    if (!row) return
    after = String(row.id)
    const content = String(row.full_content_html)
    if (!content.trim()) continue
    if (!input.blobs) throw new Error('Genesis article content requires the local Blob store')
    const reference = articleFullContentBlobRef(content)
    input.blobs.putUtf8Text(reference, content)
    // 每次让出主线程；复查本行与身份，旧缓存准备不能覆盖并发 mutation 的新引用。
    await new Promise<void>(resolve => setImmediate(resolve))
    const current = input.database.prepare(`SELECT 1 FROM articles a JOIN sync_identity_mapping m
      ON m.local_id=a.id AND m.entity_type='article' AND m.sync_space_id=?
      WHERE a.id=? AND a.account_id=? AND a.full_content_html=? AND m.sync_id=? AND m.generation=?`).get(
      input.space, row.id!, input.accountId, content, row.sync_id!, row.generation!)
    if (!current || input.database.prepare(`SELECT 1 FROM sync_blob_reference WHERE sync_space_id=?
      AND replication_lane_id='ARTICLE_STATE' AND owner_entity_type='article' AND owner_entity_sync_id=?
      AND owner_entity_generation=? AND reference_kind=?`).get(input.space, row.sync_id!, row.generation!, reference.referenceKind)) continue
    input.state.registerManifest(reference.manifest, 'READY', input.now)
    input.state.markReadyVerified(reference.manifest.hash, reference.manifest.totalBytes, input.now)
    input.state.replaceOwnerReference(input.space, 'ARTICLE_STATE', 'article', String(row.sync_id), Number(row.generation),
      reference.referenceKind, reference.manifest.hash, input.now)
  }
}
