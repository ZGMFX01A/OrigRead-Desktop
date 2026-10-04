import type { SyncCoverage } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { snapshotCoverageCommitment } from './sync-snapshot-wire'
import { pagedSnapshotRoot, pagedSnapshotSigningMaterial, reusePublishedPagedManifest } from './sync-paged-snapshot-wire'

interface Dependencies {
  runtime: SyncRuntimeRepository
  store: SyncPagedSnapshotStore
  sign(deviceId: string, material: string): string
}
interface Promotion {
  source: SyncPagedSnapshotManifest
  snapshotClass: 'GC_BASELINE' | 'BOOTSTRAP_RECOVERY'
  checkpointId: string
  now: number
}

/** 固定恢复身份可在 OWNER acceptance 之前确定，不依赖后来生成的 checkpoint ID。 */
export function pagedPromotionId(source: SyncPagedSnapshotManifest, snapshotClass: Promotion['snapshotClass']): string {
  return 'snapshot:variant:' + sha256Hex(canonicalJson(JSON.stringify({ sourceSnapshotBundleId: source.snapshotBundleId,
    policyHash: source.policyHash, snapshotClass })))
}

/** 原页复制到新不可变身份，类别、checkpoint 和 coverage commitment 一并重新签署。 */
export function promotePagedSnapshot(deps: Dependencies, input: Promotion): SyncPagedSnapshotManifest {
  if (input.source.snapshotClass !== 'WORKING') throw new Error('REBASE_UNSAFE: promotion requires an immutable WORKING source')
  const bundleId = pagedPromotionId(input.source, input.snapshotClass)
  verifyCheckpoint(deps, { ...input, bundleId })
  const unsigned = { ...input.source, snapshotBundleId: bundleId, snapshotClass: input.snapshotClass,
    authStabilityCheckpoint: input.checkpointId,
    coverageCommitment: input.snapshotClass === 'BOOTSTRAP_RECOVERY' ? snapshotCoverageCommitment(input.source.coverage) : null,
    rootHash: '', authorSignature: '' }
  const rooted = { ...unsigned, rootHash: pagedSnapshotRoot(unsigned) }
  const existing = deps.store.find(bundleId)
  const published = reusePublishedPagedManifest({ rooted, existingJson: existing?.state === 'VERIFIED' ? existing.manifestJson : undefined })
  if (published) return published
  const manifest = { ...rooted, authorSignature: deps.sign(rooted.authorDeviceId, pagedSnapshotSigningMaterial(rooted)) }
  const origin = deps.runtime.findSnapshotBundle(input.source.sourceSnapshotBundleId)
  if (!origin) throw new Error('SNAPSHOT_INCOMPATIBLE: promotion source has no published bundle')
  deps.runtime.transaction(() => {
    deps.store.copyScope({ sourceBundleId: input.source.snapshotBundleId, manifest, now: input.now })
    deps.runtime.upsertSnapshotBundle({ ...origin, snapshotBundleId: bundleId, snapshotClass: input.snapshotClass,
      authStabilityCheckpointId: input.checkpointId, rootHash: manifest.rootHash, policyHash: manifest.policyHash, createdAt: input.now })
  })
  return manifest
}

/** 只有当前 verified checkpoint 支配的稳定 effect 才能成为 GC 或恢复基线。 */
function verifyCheckpoint(deps: Dependencies, input: Promotion & { bundleId: string }): void {
  const latest = deps.runtime.listAuthObjects(input.source.syncSpaceId).filter(value => value.objectType === 'AUTH_STABILITY_CHECKPOINT').at(-1)
  if (!latest || latest.authObjectId !== input.checkpointId) throw new Error('REBASE_UNSAFE: promotion requires the current verified checkpoint')
  const payload = JSON.parse(latest.payloadJson) as { acceptedPrefixByActorLane?: SyncCoverage; acceptedSnapshotBundleId?: string }
  if (!payload.acceptedPrefixByActorLane || Object.entries(input.source.coverage).some(([lane, actors]) =>
    Object.entries(actors).some(([actor, prefix]) => (payload.acceptedPrefixByActorLane?.[lane]?.[actor] ?? 0) < prefix))) {
    throw new Error('REBASE_UNSAFE: paged Snapshot exceeds accepted coverage')
  }
  if (input.snapshotClass === 'BOOTSTRAP_RECOVERY' && payload.acceptedSnapshotBundleId !== input.bundleId) {
    throw new Error('REBASE_UNSAFE: OWNER acceptance does not name the final recovery identity')
  }
  for (const [lane, actors] of Object.entries(input.source.coverage)) for (const [actor, prefix] of Object.entries(actors)) {
    if (deps.runtime.databaseHandle().prepare(`SELECT 1 FROM sync_inbox_operation WHERE sync_space_id=?
      AND replication_lane_id=? AND actor_incarnation_id=? AND sequence<=? AND state='APPLIED'
      AND authorization_state='PROVISIONAL_AUTHORIZED' LIMIT 1`).get(input.source.syncSpaceId, lane, actor, prefix)) {
      throw new Error('REBASE_UNSAFE: paged Snapshot contains provisional effects')
    }
  }
}
