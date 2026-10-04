import type { DatabaseSync } from 'node:sqlite'
import type { SyncCoverage } from '../../shared/sync-protocol'
import type { SyncSnapshotBundleRecord } from '../../shared/sync-runtime'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncStateRepository } from './sync-state-repository'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import { verifyPagedSnapshotManifest } from './sync-paged-snapshot-wire'

/** GC 只消费已验证清单的六个逻辑 lane 前缀，不读取正文，也不将 page ID 当成 lane。 */
export function pagedGcCoverage(input: { database: DatabaseSync; runtime: SyncRuntimeRepository;
  state: SyncStateRepository; bundle: SyncSnapshotBundleRecord }): SyncCoverage | null {
  const row = input.database.prepare('SELECT state,manifest_json FROM sync_paged_snapshot WHERE snapshot_bundle_id=?')
    .get(input.bundle.snapshotBundleId)
  if (!row) return null
  const manifest = JSON.parse(String(row.manifest_json)) as SyncPagedSnapshotManifest
  if (row.state !== 'VERIFIED' || manifest.rootHash !== input.bundle.rootHash || manifest.snapshotClass !== 'GC_BASELINE' ||
    manifest.authStabilityCheckpoint !== input.bundle.authStabilityCheckpointId || manifest.syncSpaceId !== input.bundle.syncSpaceId) {
    throw new Error('SNAPSHOT_CORRUPTED: paged GC baseline differs from published bundle')
  }
  const author = input.state.findPeer(manifest.syncSpaceId, manifest.authorDeviceId)
  if (!author || author.status !== 'ACTIVE' || !input.runtime.findActiveGrant(manifest.syncSpaceId, manifest.authorDeviceId)) {
    throw new Error('AUTH_REVOKED: paged GC author is not authorized')
  }
  verifyPagedSnapshotManifest(manifest, author.publicKeySpkiBase64)
  return manifest.coverage
}
