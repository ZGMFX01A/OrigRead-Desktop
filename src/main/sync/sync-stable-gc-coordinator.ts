import type { DatabaseSync } from 'node:sqlite'
import { coverageDominates, type SyncCoverage } from '../../shared/sync-protocol'
import { decodeGenesisFrontiers } from './sync-genesis-codec'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { pagedGcCoverage } from './sync-paged-gc-coverage'
import type { SyncReplicationLane } from '../../shared/sync-runtime'

export interface DesktopStableGcResult {
  snapshotBundleId: string
  checkpointId: string
  compactedOperations: number
  stableCoverage: SyncCoverage
}

/**
 * R10 irreversible local history compaction.
 *
 * Raw history is removed only below a persisted GC_BASELINE that is dominated by the current
 * AuthStabilityCheckpoint. Current materialized winners/tombstones/aliases survive; provenance
 * pointers to compacted operations are detached before the operation rows are deleted.
 */
export class DesktopSyncStableGcCoordinator {
  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime = new SyncRuntimeRepository(database),
    private readonly state = new SyncStateRepository(database),
    private readonly localBlobStore?: DesktopSyncLocalBlobStore
  ) {
    this.blobState = new DesktopSyncBlobStateService(database)
  }

  private readonly blobState: DesktopSyncBlobStateService

  compact(snapshotBundleId: string, now = Date.now()): DesktopStableGcResult {
    const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
    if (!bundle) throw new Error('GC baseline Snapshot was not found: ' + snapshotBundleId)
    if (bundle.snapshotClass !== 'GC_BASELINE') throw new Error('Stable GC requires a GC_BASELINE Snapshot')
    const checkpointId = bundle.authStabilityCheckpointId
    if (!checkpointId) throw new Error('GC baseline has no AuthStabilityCheckpoint')

    const authHistory = this.runtime.listAuthObjects(bundle.syncSpaceId)
    const checkpoint = [...authHistory].reverse()
      .find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')
    if (!checkpoint || checkpoint.authObjectId !== checkpointId) {
      throw new Error('GC baseline does not reference the current AuthStabilityCheckpoint')
    }
    const payload = JSON.parse(checkpoint.payloadJson) as Record<string, unknown>
    const acceptedRaw = payload.acceptedPrefixByActorLane
    if (!acceptedRaw || typeof acceptedRaw !== 'object' || Array.isArray(acceptedRaw)) {
      throw new Error('AuthStabilityCheckpoint acceptedPrefixByActorLane is missing')
    }
    const acceptedCoverage = acceptedRaw as SyncCoverage

    const paged = pagedGcCoverage({ database: this.database, runtime: this.runtime, state: this.state, bundle })
    const stableCoverage: SyncCoverage = paged ?? {}
    // 旧非 LAN 契约只读取轻量 frontier，分页清单存在时严禁转回旧 shard 读取。
    for (const shard of paged ? [] : this.database.prepare(`SELECT replication_lane_id,frontier_json FROM sync_snapshot_shard
      WHERE snapshot_bundle_id=? ORDER BY replication_lane_id`).iterate(snapshotBundleId)) {
      const lane = String(shard.replication_lane_id) as SyncReplicationLane
      const laneCoverage = decodeGenesisFrontiers(String(shard.frontier_json))[lane] ?? {}
      const normalized = Object.fromEntries(
        Object.entries(laneCoverage).filter(([, prefix]) => Number.isSafeInteger(prefix) && prefix > 0)
      )
      if (Object.keys(normalized).length > 0) stableCoverage[lane] = normalized
    }
    if (!coverageDominates(acceptedCoverage, stableCoverage)) {
      throw new Error('GC baseline exceeds stable authorized coverage')
    }

    let compactedOperations = 0
    this.runtime.transaction(() => {
      for (const [lane, actors] of Object.entries(stableCoverage)) {
        for (const [actor, prefix] of Object.entries(actors)) {
          const provisional = this.database.prepare(`
            SELECT 1 FROM sync_inbox_operation
            WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
              AND sequence<=? AND state='APPLIED'
              AND authorization_state='PROVISIONAL_AUTHORIZED'
            LIMIT 1
          `).get(bundle.syncSpaceId, lane, actor, prefix)
          if (provisional) throw new Error(`Stable GC cannot cross provisional effect ${lane}/${actor}<=${prefix}`)

          const operations = this.database.prepare(`
            SELECT operation_id,build_status FROM sync_operation_log
            WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=? AND sequence<=?
            ORDER BY sequence
          `).iterate(bundle.syncSpaceId, lane, actor, prefix) as unknown as Iterable<{
            operation_id: string
            build_status: string
          }>
          for (const operation of operations) {
            if (operation.build_status !== 'SIGNED') {
              throw new Error(
                'Stable GC cannot remove non-signed canonical operation ' +
                operation.operation_id + ' (' + operation.build_status + ')'
              )
            }
            const inbox = this.database.prepare(`
              SELECT state,authorization_state FROM sync_inbox_operation WHERE operation_id=? LIMIT 1
            `).get(operation.operation_id) as { state: string; authorization_state: string } | undefined
            if (inbox) {
              if (inbox.state !== 'APPLIED') {
                throw new Error('Stable GC cannot remove ' + inbox.state + ' operation ' + operation.operation_id)
              }
              if (inbox.authorization_state !== 'STABLE_AUTHORIZED') {
                throw new Error('Stable GC cannot remove non-stable operation ' + operation.operation_id)
              }
            }

            this.database.prepare(`
              UPDATE sync_field_version SET source_operation_id=NULL
              WHERE sync_space_id=? AND source_operation_id=?
            `).run(bundle.syncSpaceId, operation.operation_id)
            this.database.prepare(`
              UPDATE sync_entity_tombstone SET source_operation_id=NULL
              WHERE sync_space_id=? AND source_operation_id=?
            `).run(bundle.syncSpaceId, operation.operation_id)
            this.database.prepare(`
              UPDATE sync_alias_edge SET source_operation_id=NULL
              WHERE sync_space_id=? AND source_operation_id=?
            `).run(bundle.syncSpaceId, operation.operation_id)
            this.blobState.removeOwnerReferences(
              bundle.syncSpaceId,
              lane,
              '__operation__',
              operation.operation_id,
              0
            )
            this.database.prepare('DELETE FROM sync_apply_journal WHERE operation_id=?').run(operation.operation_id)
            this.database.prepare('DELETE FROM sync_inbox_operation WHERE operation_id=?').run(operation.operation_id)
            this.database.prepare('DELETE FROM sync_genesis_operation_coverage WHERE operation_id=?').run(operation.operation_id)
          }

          const deleted = this.database.prepare(`
            DELETE FROM sync_operation_log
            WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=? AND sequence<=?
          `).run(bundle.syncSpaceId, lane, actor, prefix)
          compactedOperations += Number(deleted.changes)
          this.database.prepare(`
            DELETE FROM sync_outbox
            WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
              AND sequence<=? AND status='BUILT'
          `).run(bundle.syncSpaceId, lane, actor, prefix)

          this.state.upsertCoverage(bundle.syncSpaceId, lane, actor, {
            receivedPrefix: prefix,
            appliedPrefix: prefix,
            retainedPrefix: prefix,
            snapshotPrefix: prefix,
            stableGcPrefix: prefix
          }, now)
        }
      }
    })

    return {
      snapshotBundleId,
      checkpointId,
      compactedOperations,
      stableCoverage
    }
  }

  sweepUnreferencedBlobs(
    syncSpaceId: string,
    localReplicaId: string,
    limit = 500,
    now = Date.now()
  ): number {
    if (!this.localBlobStore) throw new Error('Local Blob store is not configured for Stable GC')
    if (!syncSpaceId.trim() || !localReplicaId.trim() || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Invalid Blob GC request')
    }
    const rows = this.database.prepare(`
      SELECT hash FROM sync_blob_manifest
      WHERE reference_count=0
      ORDER BY last_accessed_at ASC,hash ASC
      LIMIT ?
    `).all(limit) as unknown as Array<{ hash: string }>
    let removed = 0
    for (const row of rows) {
      if (!this.blobState.canAutoGc(syncSpaceId, row.hash, localReplicaId)) continue
      this.localBlobStore.remove(row.hash)
      this.blobState.markMissing(row.hash, now)
      removed++
    }
    return removed
  }
}
