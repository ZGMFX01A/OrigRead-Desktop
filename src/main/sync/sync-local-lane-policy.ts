import type { DatabaseSync } from 'node:sqlite'
import type { SyncPolicyByLane, SyncReplicationPolicy } from '../../shared/sync-protocol'
import { SYNC_REPLICATION_LANES, type SyncReplicationLane } from '../../shared/sync-runtime'

/** Device-local preferences survive restarts and never overwrite another Space's policy. */
export class SyncLocalLanePolicy {
  constructor(private readonly database: DatabaseSync) {}

  read(syncSpaceId: string): SyncPolicyByLane {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?')
      .get(this.key(syncSpaceId)) as { value: string } | undefined
    if (!row) return {}
    // 损坏的持久政策必须显式失败，不能按空政策重新启用 AI 数据。
    const parsed: unknown = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SYNC_LANE_POLICY_CORRUPTED')
    const result: SyncPolicyByLane = {}
    for (const [lane, policy] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SYNC_REPLICATION_LANES.includes(lane as SyncReplicationLane)) continue
      if (!['ENABLED', 'PAUSED', 'UNSUPPORTED', 'LOCAL_PURGE'].includes(String(policy))) continue
      if ((lane === 'AUTH' || lane === 'CORE_META') && policy !== 'ENABLED') continue
      result[lane] = policy as SyncReplicationPolicy
    }
    return result
  }

  set(syncSpaceId: string, lane: SyncReplicationLane, policy: SyncReplicationPolicy): void {
    if (!SYNC_REPLICATION_LANES.includes(lane) || !['ENABLED', 'PAUSED', 'UNSUPPORTED', 'LOCAL_PURGE'].includes(policy)) {
      throw new Error('Unsupported lane policy')
    }
    if ((lane === 'AUTH' || lane === 'CORE_META') && policy !== 'ENABLED') {
      throw new Error(lane + ' is a required Sync core lane and cannot be disabled by local policy')
    }
    this.database.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(this.key(syncSpaceId), JSON.stringify({ ...this.read(syncSpaceId), [lane]: policy }), Date.now())
  }

  private key(space: string): string {
    if (!space.trim()) throw new Error('Sync Space ID must not be blank')
    return `sync.lane-policy:${space}`
  }
}
