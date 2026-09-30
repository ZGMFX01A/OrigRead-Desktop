import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  SyncBlobManifest,
  SyncCoverage,
  SyncCoverageVector,
  SyncCursor,
  SyncOperationEnvelope,
  SyncReplicationPolicy,
  SyncPolicyByLane
} from '../../shared/sync-protocol'
import { emptySyncCoverageVector } from '../../shared/sync-protocol'
import { canonicalJson } from './sync-operation-canonicalizer'
import type { SyncOperationRecord, SyncReplicationLane } from '../../shared/sync-runtime'

export type SyncInboxState = 'PENDING' | 'APPLIED' | 'REJECTED'

export interface SyncCoverageUpdate {
  receivedPrefix?: number
  appliedPrefix?: number
  retainedPrefix?: number
  snapshotPrefix?: number
  stableGcPrefix?: number
}

export interface SyncInboxRecord {
  operationId: string
  syncSpaceId: string
  actorIncarnationId: string
  replicationLaneId: string
  sequence: number
  state: SyncInboxState
  operationJson: string
  rejectionReason: string | null
  rejectionDigest: string | null
  receivedAt: number
  appliedAt: number | null
  lastError: string | null
  authorizationState: 'PROVISIONAL_AUTHORIZED' | 'STABLE_AUTHORIZED' | 'REVOKED'
  stabilizedByAuthObjectId: string | null
}

export interface SyncPeerIdentityRecord {
  syncSpaceId: string
  deviceId: string
  publicKeySpkiBase64: string
  status: 'ACTIVE' | 'REVOKED'
  authEpoch: number
  updatedAt: number
}

export interface SyncTrustedDeviceRecord {
  id: string
  syncSpaceId: string
  deviceId: string
  staticPublicKey: string
  fingerprint: string
  displayName: string
  platform: string
  trustState: 'TRUSTED' | 'REVOKED' | 'PROVISIONAL'
  pairedAt: number
  lastSeenAt: number
  authEpoch: number
}

export interface SyncEndpointConfigRecord {
  endpointId: string
  syncSpaceId: string
  kind: 'LAN' | 'SERVER' | 'MANUAL'
  url: string
  displayName: string
  enabled: boolean
  localBindAddress?: string | null
  createdAt: number
  updatedAt: number
  lastError: string | null
}

export interface SyncFieldVersionRecord {
  syncSpaceId: string
  entityType: string
  entitySyncId: string
  fieldId: string
  entityGeneration: number
  versionToken: string
  sourceOperationId: string | null
  valueJson: string
  causalContextJson?: string | null
  logicalClock?: number | null
  updatedAt: number
}

export class SyncStateRepository {
  constructor(private readonly database: DatabaseSync) {}

  insertInbox(operation: SyncOperationRecord, operationJson: string, receivedAt = Date.now()): 'INSERTED' | 'DUPLICATE' | 'DOT_COLLISION' {
    const existingById = this.database.prepare(
      'SELECT operation_id,actor_incarnation_id,replication_lane_id,sequence,operation_json FROM sync_inbox_operation WHERE operation_id=?'
    ).get(operation.operationId) as Record<string, unknown> | undefined
    if (existingById) {
      return String(existingById.operation_json) === operationJson ? 'DUPLICATE' : 'DOT_COLLISION'
    }
    const existingByDot = this.database.prepare(
      'SELECT operation_id,operation_json FROM sync_inbox_operation WHERE actor_incarnation_id=? AND replication_lane_id=? AND sequence=?'
    ).get(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence) as Record<string, unknown> | undefined
    if (existingByDot) return String(existingByDot.operation_json) === operationJson ? 'DUPLICATE' : 'DOT_COLLISION'
    this.database.prepare(`
      INSERT INTO sync_inbox_operation(
        operation_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,state,
        operation_json,rejection_reason,rejection_digest,received_at,applied_at,last_error,
        authorization_state,stabilized_by_auth_object_id
      ) VALUES(?,?,?,?,?,'PENDING',?,?,NULL,?,NULL,NULL,'PROVISIONAL_AUTHORIZED',NULL)
    `).run(
      operation.operationId,
      operation.syncSpaceId,
      operation.actorIncarnationId,
      operation.replicationLaneId,
      operation.sequence,
      operationJson,
      null,
      receivedAt
    )
    this.advanceReceivedCoverage(operation.syncSpaceId, operation.replicationLaneId, operation.actorIncarnationId, receivedAt)
    return 'INSERTED'
  }

  findInbox(operationId: string): SyncInboxRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_inbox_operation WHERE operation_id=? LIMIT 1')
      .get(operationId) as Record<string, unknown> | undefined
    return row ? toInbox(row) : null
  }

  listPendingInbox(syncSpaceId: string, limit = 100, pausedLanes: string[] = [], after?: SyncInboxRecord): SyncInboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_inbox_operation
      WHERE sync_space_id=? AND state='PENDING'
        AND (replication_lane_id,actor_incarnation_id,sequence)>(?,?,?)
        ${pausedLanes.length ? `AND replication_lane_id NOT IN (${pausedLanes.map(() => '?').join(',')})` : ''}
      ORDER BY replication_lane_id,actor_incarnation_id,sequence
      LIMIT ?
    `).all(syncSpaceId, after?.replicationLaneId ?? '', after?.actorIncarnationId ?? '', after?.sequence ?? 0,
      ...pausedLanes, limit) as unknown as Array<Record<string, unknown>>
    return rows.map(toInbox)
  }

  markApplied(operationId: string, completedAt = Date.now()): void {
    const inbox = this.findInbox(operationId)
    if (!inbox) throw new Error(`Inbox operation ${operationId} is missing`)
    this.database.prepare(`
      UPDATE sync_inbox_operation
      SET state='APPLIED',applied_at=?,last_error=NULL
      WHERE operation_id=? AND state='PENDING'
    `).run(completedAt, operationId)
    this.advanceAppliedCoverage(inbox.syncSpaceId, inbox.replicationLaneId, inbox.actorIncarnationId, completedAt)
  }

  markRejected(operationId: string, reason: string, rejectionDigest: string | null, receivedAt = Date.now()): void {
    const inbox = this.findInbox(operationId)
    if (!inbox) throw new Error(`Inbox operation ${operationId} is missing`)
    this.database.prepare(`
      UPDATE sync_inbox_operation
      SET state='REJECTED',rejection_reason=?,rejection_digest=?,applied_at=?,last_error=NULL
      WHERE operation_id=? AND state='PENDING'
    `).run(reason.slice(0, 1_000), rejectionDigest, receivedAt, operationId)
    // Recalculate from actual inbox state; a rejected dot is never business Applied.
    this.advanceAppliedCoverage(inbox.syncSpaceId, inbox.replicationLaneId, inbox.actorIncarnationId, receivedAt)
  }

  markRevoked(operationId: string, now = Date.now()): void {
    const result = this.database.prepare(`UPDATE sync_inbox_operation
      SET state='REJECTED',rejection_reason='AUTH_REVOKED',rejection_digest=?,applied_at=NULL,last_error=NULL,
          authorization_state='REVOKED',stabilized_by_auth_object_id=NULL
      WHERE operation_id=? AND state='APPLIED'`)
      .run(`rejected:${operationId}:revoked`, operationId)
    if (Number(result.changes) !== 1) throw new Error(`Applied operation ${operationId} changed during rollback at ${now}`)
  }

  markApplyFailure(operationId: string, message: string): void {
    this.database.prepare('UPDATE sync_inbox_operation SET last_error=? WHERE operation_id=? AND state=\'PENDING\'')
      .run(message.slice(0, 2_000), operationId)
  }

  getCoverage(syncSpaceId: string): SyncCoverageVector {
    const rows = this.database.prepare('SELECT * FROM sync_coverage WHERE sync_space_id=?')
      .all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    const result = emptySyncCoverageVector()
    for (const row of rows) {
      const lane = String(row.replication_lane_id)
      const actor = String(row.actor_incarnation_id)
      const values = [
        ['received', Number(row.received_prefix)],
        ['applied', Number(row.applied_prefix)],
        ['retained', Number(row.retained_prefix)],
        ['snapshot', Number(row.snapshot_prefix)],
        ['stableGc', Number(row.stable_gc_prefix)]
      ] as const
      for (const [kind, prefix] of values) {
        if (prefix <= 0) continue
        result[kind][lane] ??= {}
        result[kind][lane]![actor] = prefix
      }
    }
    return result
  }

  getCoverageByKind(syncSpaceId: string, kind: keyof SyncCoverageVector): SyncCoverage {
    return this.getCoverage(syncSpaceId)[kind]
  }

  upsertCoverage(syncSpaceId: string, lane: string, actor: string, update: SyncCoverageUpdate, now = Date.now()): void {
    const previous = this.database.prepare(`
      SELECT received_prefix,applied_prefix,retained_prefix,snapshot_prefix,stable_gc_prefix
      FROM sync_coverage WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
    `).get(syncSpaceId, lane, actor) as Record<string, unknown> | undefined
    const value = {
      receivedPrefix: Math.max(Number(previous?.received_prefix ?? 0), update.receivedPrefix ?? 0),
      appliedPrefix: Math.max(Number(previous?.applied_prefix ?? 0), update.appliedPrefix ?? 0),
      retainedPrefix: Math.max(Number(previous?.retained_prefix ?? 0), update.retainedPrefix ?? 0),
      snapshotPrefix: Math.max(Number(previous?.snapshot_prefix ?? 0), update.snapshotPrefix ?? 0),
      stableGcPrefix: Math.max(Number(previous?.stable_gc_prefix ?? 0), update.stableGcPrefix ?? 0)
    }
    this.database.prepare(`
      INSERT INTO sync_coverage(
        sync_space_id,replication_lane_id,actor_incarnation_id,received_prefix,applied_prefix,
        retained_prefix,snapshot_prefix,stable_gc_prefix,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,replication_lane_id,actor_incarnation_id) DO UPDATE SET
        received_prefix=excluded.received_prefix,
        applied_prefix=excluded.applied_prefix,
        retained_prefix=excluded.retained_prefix,
        snapshot_prefix=excluded.snapshot_prefix,
        stable_gc_prefix=excluded.stable_gc_prefix,
        updated_at=excluded.updated_at
    `).run(syncSpaceId, lane, actor, value.receivedPrefix, value.appliedPrefix, value.retainedPrefix, value.snapshotPrefix, value.stableGcPrefix, now)
  }

  /**
   * 将本地覆盖度对齐至 Snapshot 边界（用于 Snapshot 安装与 GC baseline 恢复）。
   * 遵循 R10/R12 规范：applied 与 snapshot 前缀对齐快照边界；严禁将 retainedPrefix 虚高覆盖为快照前缀。
   */
  rebaseSnapshotCoverage(syncSpaceId: string, snapshotCoverage: SyncCoverage, now = Date.now()): void {
    for (const [lane, actors] of Object.entries(snapshotCoverage)) {
      for (const [actor, prefix] of Object.entries(actors)) {
        const previous = this.database.prepare(`
          SELECT received_prefix,applied_prefix,retained_prefix,snapshot_prefix,stable_gc_prefix
          FROM sync_coverage WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
        `).get(syncSpaceId, lane, actor) as Record<string, unknown> | undefined

        const prevRetained = Number(previous?.retained_prefix ?? 0)
        const prevReceived = Number(previous?.received_prefix ?? 0)
        const prevGc = Number(previous?.stable_gc_prefix ?? 0)

        const value = {
          receivedPrefix: Math.max(prevReceived, prefix),
          appliedPrefix: prefix,
          retainedPrefix: prevRetained,
          snapshotPrefix: prefix,
          stableGcPrefix: prevGc
        }

        this.database.prepare(`
          INSERT INTO sync_coverage(
            sync_space_id,replication_lane_id,actor_incarnation_id,received_prefix,applied_prefix,
            retained_prefix,snapshot_prefix,stable_gc_prefix,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(sync_space_id,replication_lane_id,actor_incarnation_id) DO UPDATE SET
            received_prefix=excluded.received_prefix,
            applied_prefix=excluded.applied_prefix,
            retained_prefix=excluded.retained_prefix,
            snapshot_prefix=excluded.snapshot_prefix,
            stable_gc_prefix=excluded.stable_gc_prefix,
            updated_at=excluded.updated_at
        `).run(syncSpaceId, lane, actor, value.receivedPrefix, value.appliedPrefix, value.retainedPrefix, value.snapshotPrefix, value.stableGcPrefix, now)
      }
    }
  }

  registerPeer(value: SyncPeerIdentityRecord): void {
    this.database.prepare(`
      INSERT INTO sync_peer_identity(sync_space_id,device_id,public_key_spki_base64,status,auth_epoch,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,device_id) DO UPDATE SET
        public_key_spki_base64=excluded.public_key_spki_base64,
        status=excluded.status,auth_epoch=excluded.auth_epoch,updated_at=excluded.updated_at
    `).run(value.syncSpaceId, value.deviceId, value.publicKeySpkiBase64, value.status, value.authEpoch, value.updatedAt)
  }

  findPeer(syncSpaceId: string, deviceId: string): SyncPeerIdentityRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_peer_identity WHERE sync_space_id=? AND device_id=? LIMIT 1')
      .get(syncSpaceId, deviceId) as Record<string, unknown> | undefined
    return row ? {
      syncSpaceId: String(row.sync_space_id), deviceId: String(row.device_id),
      publicKeySpkiBase64: String(row.public_key_spki_base64),
      status: String(row.status) as SyncPeerIdentityRecord['status'], authEpoch: Number(row.auth_epoch),
      updatedAt: Number(row.updated_at)
    } : null
  }

  upsertTrustedDevice(record: SyncTrustedDeviceRecord): void {
    this.database.prepare(`
      INSERT INTO sync_trusted_device(id,sync_space_id,device_id,static_public_key,fingerprint,display_name,platform,trust_state,paired_at,last_seen_at,auth_epoch)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,device_id) DO UPDATE SET
        static_public_key=excluded.static_public_key,
        fingerprint=excluded.fingerprint,
        display_name=excluded.display_name,
        platform=excluded.platform,
        trust_state=excluded.trust_state,
        paired_at=excluded.paired_at,
        last_seen_at=excluded.last_seen_at,
        auth_epoch=excluded.auth_epoch
    `).run(
      record.id, record.syncSpaceId, record.deviceId, record.staticPublicKey, record.fingerprint,
      record.displayName, record.platform, record.trustState, record.pairedAt, record.lastSeenAt, record.authEpoch
    )
  }

  listTrustedDevices(syncSpaceId: string): SyncTrustedDeviceRecord[] {
    const rows = this.database.prepare('SELECT * FROM sync_trusted_device WHERE sync_space_id=? ORDER BY last_seen_at DESC')
      .all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      syncSpaceId: String(row.sync_space_id),
      deviceId: String(row.device_id),
      staticPublicKey: String(row.static_public_key),
      fingerprint: String(row.fingerprint),
      displayName: String(row.display_name),
      platform: String(row.platform),
      trustState: String(row.trust_state) as SyncTrustedDeviceRecord['trustState'],
      pairedAt: Number(row.paired_at),
      lastSeenAt: Number(row.last_seen_at),
      authEpoch: Number(row.auth_epoch)
    }))
  }

  findTrustedDevice(syncSpaceId: string, deviceId: string): SyncTrustedDeviceRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_trusted_device WHERE sync_space_id=? AND device_id=? LIMIT 1')
      .get(syncSpaceId, deviceId) as Record<string, unknown> | undefined
    return row ? {
      id: String(row.id),
      syncSpaceId: String(row.sync_space_id),
      deviceId: String(row.device_id),
      staticPublicKey: String(row.static_public_key),
      fingerprint: String(row.fingerprint),
      displayName: String(row.display_name),
      platform: String(row.platform),
      trustState: String(row.trust_state) as SyncTrustedDeviceRecord['trustState'],
      pairedAt: Number(row.paired_at),
      lastSeenAt: Number(row.last_seen_at),
      authEpoch: Number(row.auth_epoch)
    } : null
  }

  updateTrustedDeviceState(syncSpaceId: string, deviceId: string, state: 'TRUSTED' | 'REVOKED' | 'PROVISIONAL', authEpoch: number, lastSeenAt: number): void {
    this.database.prepare(`
      UPDATE sync_trusted_device
      SET trust_state=?, auth_epoch=?, last_seen_at=?
      WHERE sync_space_id=? AND device_id=?
    `).run(state, authEpoch, lastSeenAt, syncSpaceId, deviceId)
  }

  updateTrustedDeviceLastSeen(syncSpaceId: string, deviceId: string, lastSeenAt: number): void {
    this.database.prepare('UPDATE sync_trusted_device SET last_seen_at=? WHERE sync_space_id=? AND device_id=?')
      .run(lastSeenAt, syncSpaceId, deviceId)
  }

  deleteTrustedDevice(syncSpaceId: string, deviceId: string): void {
    this.database.prepare('DELETE FROM sync_trusted_device WHERE sync_space_id=? AND device_id=?')
      .run(syncSpaceId, deviceId)
  }

  recordPersistedAck(ack: { syncSpaceId: string; hash: string; replicaId: string; totalBytes: number; persistedAt: number }): void {
    this.database.prepare(`
      INSERT INTO sync_blob_persisted_ack(sync_space_id,hash,replica_id,total_bytes,persisted_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(sync_space_id,hash,replica_id) DO UPDATE SET
        total_bytes=excluded.total_bytes,persisted_at=MAX(sync_blob_persisted_ack.persisted_at,excluded.persisted_at)
    `).run(ack.syncSpaceId, ack.hash, ack.replicaId, ack.totalBytes, ack.persistedAt)
  }

  upsertEndpoint(value: SyncEndpointConfigRecord): void {
    this.database.prepare(`
      INSERT INTO sync_endpoint_config(endpoint_id,sync_space_id,kind,url,display_name,enabled,local_bind_address,created_at,updated_at,last_error)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(endpoint_id) DO UPDATE SET
        sync_space_id=excluded.sync_space_id,kind=excluded.kind,url=excluded.url,display_name=excluded.display_name,
        enabled=excluded.enabled,local_bind_address=excluded.local_bind_address,
        updated_at=excluded.updated_at,last_error=excluded.last_error
    `).run(
      value.endpointId, value.syncSpaceId, value.kind, value.url, value.displayName, value.enabled ? 1 : 0,
      value.localBindAddress ?? null, value.createdAt, value.updatedAt, value.lastError
    )
  }

  listEndpoints(syncSpaceId: string): SyncEndpointConfigRecord[] {
    const rows = this.database.prepare('SELECT * FROM sync_endpoint_config WHERE sync_space_id=? ORDER BY created_at,endpoint_id')
      .all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      endpointId: String(row.endpoint_id), syncSpaceId: String(row.sync_space_id),
      kind: String(row.kind) as SyncEndpointConfigRecord['kind'], url: String(row.url),
      displayName: String(row.display_name), enabled: Number(row.enabled) === 1,
      localBindAddress: row.local_bind_address == null ? null : String(row.local_bind_address),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      lastError: row.last_error == null ? null : String(row.last_error)
    }))
  }

  findEndpoint(endpointId: string): SyncEndpointConfigRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_endpoint_config WHERE endpoint_id=? LIMIT 1').get(endpointId) as Record<string, unknown> | undefined
    return row ? {
      endpointId: String(row.endpoint_id), syncSpaceId: String(row.sync_space_id),
      kind: String(row.kind) as SyncEndpointConfigRecord['kind'], url: String(row.url), displayName: String(row.display_name),
      enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      localBindAddress: row.local_bind_address == null ? null : String(row.local_bind_address),
      lastError: row.last_error == null ? null : String(row.last_error)
    } : null
  }

  deleteEndpoint(endpointId: string): void {
    this.database.prepare('DELETE FROM sync_endpoint_config WHERE endpoint_id=?').run(endpointId)
  }

  findFieldVersion(syncSpaceId: string, entityType: string, entitySyncId: string, fieldId: string): SyncFieldVersionRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_field_version
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND field_id=? LIMIT 1
    `).get(syncSpaceId, entityType, entitySyncId, fieldId) as Record<string, unknown> | undefined
    return row ? toFieldVersion(row) : null
  }

  upsertFieldVersion(value: SyncFieldVersionRecord): void {
    this.retainFieldCandidate(value)
    this.database.prepare(`
      INSERT INTO sync_field_version(
        sync_space_id,entity_type,entity_sync_id,field_id,entity_generation,version_token,source_operation_id,value_json,
        causal_context_json,logical_clock,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id,field_id) DO UPDATE SET
        entity_generation=excluded.entity_generation,version_token=excluded.version_token,
        source_operation_id=excluded.source_operation_id,value_json=excluded.value_json,
        causal_context_json=excluded.causal_context_json,logical_clock=excluded.logical_clock,
        updated_at=excluded.updated_at
    `).run(
      value.syncSpaceId,
      value.entityType,
      value.entitySyncId,
      value.fieldId,
      value.entityGeneration,
      value.versionToken,
      value.sourceOperationId,
      value.valueJson,
      value.causalContextJson ?? null,
      value.logicalClock ?? null,
      value.updatedAt
    )
  }

  retainFieldCandidate(value: SyncFieldVersionRecord): void {
    this.database.prepare(`INSERT INTO sync_field_candidate
      (sync_space_id,entity_type,entity_sync_id,field_id,entity_generation,version_token,
       source_operation_id,value_json,updated_at,causal_context_json,logical_clock)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id,entity_generation,field_id,version_token)
      DO UPDATE SET source_operation_id=excluded.source_operation_id,
        causal_context_json=COALESCE(excluded.causal_context_json,sync_field_candidate.causal_context_json),
        logical_clock=COALESCE(excluded.logical_clock,sync_field_candidate.logical_clock)`)
      .run(value.syncSpaceId,value.entityType,value.entitySyncId,value.fieldId,value.entityGeneration,
        value.versionToken,value.sourceOperationId,value.valueJson,value.updatedAt,
        value.causalContextJson ?? null,value.logicalClock ?? null)
  }

  listFieldCandidates(syncSpaceId: string): SyncFieldVersionRecord[] {
    return (this.database.prepare(`SELECT c.* FROM sync_field_candidate c
      LEFT JOIN sync_inbox_operation i ON i.operation_id=c.source_operation_id
      WHERE c.sync_space_id=? AND (i.operation_id IS NULL OR i.state='APPLIED')
      ORDER BY c.entity_type,c.entity_sync_id,c.entity_generation,c.field_id,c.version_token`)
      .all(syncSpaceId) as Array<Record<string, unknown>>).map(toFieldVersion)
  }

  findFieldVersionsBySourceOperation(syncSpaceId: string, sourceOperationId: string): SyncFieldVersionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_field_version
      WHERE sync_space_id=? AND source_operation_id=?
    `).all(syncSpaceId, sourceOperationId) as unknown as Array<Record<string, unknown>>
    return rows.map(toFieldVersion)
  }

  deleteFieldVersion(syncSpaceId: string, entityType: string, entitySyncId: string, fieldId: string): void {
    this.database.prepare(`
      DELETE FROM sync_field_version
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND field_id=?
    `).run(syncSpaceId, entityType, entitySyncId, fieldId)
  }

  listAppliedInbox(syncSpaceId: string): SyncInboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_inbox_operation
      WHERE sync_space_id=? AND state='APPLIED'
      ORDER BY received_at ASC
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toInbox)
  }

  listAppliedProvisionalInbox(syncSpaceId: string): SyncInboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_inbox_operation
      WHERE sync_space_id=? AND state='APPLIED' AND authorization_state='PROVISIONAL_AUTHORIZED'
      ORDER BY received_at ASC
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toInbox)
  }

  listRevokedRejectedInbox(syncSpaceId: string): SyncInboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_inbox_operation
      WHERE sync_space_id=? AND state='REJECTED' AND authorization_state='REVOKED'
      ORDER BY replication_lane_id,actor_incarnation_id,sequence
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toInbox)
  }

  markAuthorizationStable(operationId: string, checkpointId: string): void {
    this.database.prepare(`
      UPDATE sync_inbox_operation
      SET authorization_state='STABLE_AUTHORIZED',stabilized_by_auth_object_id=?
      WHERE operation_id=? AND state IN ('PENDING','APPLIED') AND authorization_state='PROVISIONAL_AUTHORIZED'
    `).run(checkpointId, operationId)
  }

  promoteStableAuthorization(syncSpaceId: string, stableCoverage: SyncCoverage, checkpointId: string): void {
    for (const [lane, actors] of Object.entries(stableCoverage)) {
      for (const [actor, prefix] of Object.entries(actors)) {
        this.database.prepare(`
          UPDATE sync_inbox_operation
          SET authorization_state='STABLE_AUTHORIZED',stabilized_by_auth_object_id=?
          WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
            AND sequence<=? AND state='APPLIED' AND authorization_state='PROVISIONAL_AUTHORIZED'
        `).run(checkpointId, syncSpaceId, lane, actor, prefix)
      }
    }
  }

  recalculateAppliedCoverage(syncSpaceId: string, lane: string, actor: string, now = Date.now()): void {
    this.advanceAppliedCoverage(syncSpaceId, lane, actor, now)
  }

  upsertAlias(syncSpaceId: string, entityType: string, aliasSyncId: string, canonicalSyncId: string, generation: number, now = Date.now()): void {
    this.database.prepare(`
      INSERT INTO sync_entity_alias(sync_space_id,entity_type,alias_sync_id,canonical_sync_id,generation,created_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,alias_sync_id,generation)
      DO UPDATE SET canonical_sync_id=excluded.canonical_sync_id,created_at=excluded.created_at
    `).run(syncSpaceId, entityType, aliasSyncId, canonicalSyncId, generation, now)
  }

  recordTombstone(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    generation: number,
    versionToken: string,
    now = Date.now(),
    sourceOperationId: string | null = null
  ): void {
    this.database.prepare(`
      INSERT INTO sync_entity_tombstone(
        sync_space_id,entity_type,entity_sync_id,generation,version_token,deleted_at,source_operation_id
      )
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id) DO UPDATE SET
        generation=excluded.generation,version_token=excluded.version_token,
        deleted_at=excluded.deleted_at,source_operation_id=excluded.source_operation_id
      WHERE excluded.generation > sync_entity_tombstone.generation
         OR (excluded.generation = sync_entity_tombstone.generation
             AND excluded.version_token > sync_entity_tombstone.version_token)
    `).run(syncSpaceId, entityType, entitySyncId, generation, versionToken, now, sourceOperationId)
  }

  saveCursor(endpointId: string, syncSpaceId: string, cursor: SyncCursor | null, updatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO sync_peer_cursor(endpoint_id,sync_space_id,cursor_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(endpoint_id) DO UPDATE SET sync_space_id=excluded.sync_space_id,cursor_json=excluded.cursor_json,updated_at=excluded.updated_at
    `).run(endpointId, syncSpaceId, cursor ? canonicalJson(JSON.stringify(cursor)) : null, updatedAt)
  }

  readCursor(endpointId: string, syncSpaceId?: string): SyncCursor | null {
    const row = this.database.prepare('SELECT cursor_json,sync_space_id FROM sync_peer_cursor WHERE endpoint_id=? LIMIT 1').get(endpointId) as { cursor_json: string | null; sync_space_id: string } | undefined
    if (syncSpaceId && row?.sync_space_id !== syncSpaceId) return null
    return row?.cursor_json ? JSON.parse(row.cursor_json) as SyncCursor : null
  }

  deleteCursor(endpointId: string): void {
    this.database.prepare('DELETE FROM sync_peer_cursor WHERE endpoint_id=?').run(endpointId)
  }

  upsertBlobManifest(value: SyncBlobManifest, now = Date.now()): void {
    this.database.prepare(`
      INSERT INTO sync_blob_manifest(hash,total_bytes,media_type,durability,reference_count,persisted_at,last_accessed_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET
        total_bytes=excluded.total_bytes,media_type=COALESCE(excluded.media_type,sync_blob_manifest.media_type),
        durability=excluded.durability,reference_count=excluded.reference_count,
        persisted_at=excluded.persisted_at,last_accessed_at=excluded.last_accessed_at
    `).run(value.hash, value.totalBytes, value.mediaType, value.durability, value.referenceCount, now, now)
  }

  private advanceReceivedCoverage(syncSpaceId: string, lane: string, actor: string, now: number): void {
    const prefix = this.contiguousPrefix(syncSpaceId, lane, actor, '1=1')
    const retained = this.contiguousPrefix(syncSpaceId, lane, actor, "state != 'REJECTED'")
    this.upsertCoverage(syncSpaceId, lane, actor, { receivedPrefix: prefix }, now)
    this.database.prepare('UPDATE sync_coverage SET retained_prefix=? WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?')
      .run(retained, syncSpaceId, lane, actor)
  }

  private advanceAppliedCoverage(syncSpaceId: string, lane: string, actor: string, now: number): void {
    // appliedCoverage 必须严格代表业务数据库真实成功应用的连续前缀，严禁将 REJECTED 伪装成业务 Applied
    const prefix = this.contiguousPrefix(syncSpaceId, lane, actor, "state = 'APPLIED'")
    this.upsertCoverage(syncSpaceId, lane, actor, { appliedPrefix: prefix }, now)
    this.database.prepare('UPDATE sync_coverage SET applied_prefix=? WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?')
      .run(prefix, syncSpaceId, lane, actor)
    this.advanceReceivedCoverage(syncSpaceId, lane, actor, now)
  }

  processedPrefix(syncSpaceId: string, lane: string, actor: string): number {
    return this.contiguousPrefix(syncSpaceId, lane, actor, "state IN ('APPLIED','REJECTED')")
  }

  private contiguousPrefix(syncSpaceId: string, lane: string, actor: string, predicate: string): number {
    const row = this.database.prepare(`
      SELECT snapshot_prefix,stable_gc_prefix FROM sync_coverage
      WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=? LIMIT 1
    `).get(syncSpaceId, lane, actor) as Record<string, unknown> | undefined
    // Snapshot/StableGC is retained state after raw-operation compaction. Never restart a
    // contiguous coverage calculation at zero just because the compacted inbox rows are gone.
    const existing = Math.max(
      Number(row?.snapshot_prefix ?? 0),
      Number(row?.stable_gc_prefix ?? 0)
    )
    const rows = this.database.prepare(`
      SELECT sequence FROM sync_inbox_operation
      WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?
        AND sequence>? AND ${predicate}
      ORDER BY sequence ASC
    `).all(syncSpaceId, lane, actor, existing) as unknown as Array<{ sequence: number | bigint }>
    let prefix = existing
    for (const candidate of rows) {
      const sequence = Number(candidate.sequence)
      if (sequence !== prefix + 1) break
      prefix = sequence
    }
    return prefix
  }
}

export class SyncBlobStore {
  constructor(private readonly root: string, private readonly state: SyncStateRepository) {
    mkdirSync(root, { recursive: true })
  }

  putChunk(chunk: { hash: string; offset: number; totalBytes: number; bytes: Uint8Array; isFinal: boolean }, now = Date.now()): void {
    if (!/^[a-f0-9]{64}$/.test(chunk.hash)) throw new Error('Blob hash must be a SHA-256 hex digest')
    if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0) throw new Error('Invalid Blob range')
    const path = join(this.root, chunk.hash)
    const currentLength = existsSync(path) ? statSync(path).size : 0
    if (chunk.offset !== currentLength) throw new Error(`Blob offset mismatch: expected ${currentLength}, got ${chunk.offset}`)
    const nextLength = chunk.offset + chunk.bytes.byteLength
    if (nextLength > chunk.totalBytes) throw new Error('Blob exceeds declared size')
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w+')
    try {
      if (chunk.bytes.byteLength > 0) {
        const bytes = Buffer.from(chunk.bytes)
        const written = writeSync(fd, bytes, 0, bytes.byteLength, chunk.offset)
        if (written !== bytes.byteLength) throw new Error('Blob chunk write was incomplete')
      }
    } finally {
      closeSync(fd)
    }
    if (chunk.isFinal) {
      if (nextLength !== chunk.totalBytes) throw new Error('Final Blob chunk has an incomplete size')
      if (sha256FileHex(path) !== chunk.hash) throw new Error('Blob hash mismatch')
      this.state.upsertBlobManifest({ hash: chunk.hash, totalBytes: nextLength, mediaType: null, durability: 'SYNC_DURABLE', referenceCount: 0 }, now)
    }
  }

  getChunk(hash: string, offset = 0, length?: number): { hash: string; offset: number; totalBytes: number; bytes: Uint8Array; isFinal: boolean } {
    const path = join(this.root, hash)
    if (!existsSync(path)) throw new Error(`BLOB_MISSING ${hash}`)
    const totalBytes = statSync(path).size
    const end = length == null ? totalBytes : Math.min(totalBytes, offset + Math.max(0, length))
    if (offset > totalBytes) throw new Error(`Blob offset ${offset} is beyond durable bytes ${totalBytes}`)
    const selected = Buffer.allocUnsafe(Math.max(0, end - offset))
    if (selected.byteLength > 0) {
      const fd = openSync(path, 'r')
      try {
        const read = readSync(fd, selected, 0, selected.byteLength, offset)
        if (read !== selected.byteLength) throw new Error('Blob range read was incomplete')
      } finally {
        closeSync(fd)
      }
    }
    return { hash, offset, totalBytes, bytes: selected, isFinal: end >= totalBytes }
  }
}

function sha256FileHex(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function toInbox(row: Record<string, unknown>): SyncInboxRecord {
  return {
    operationId: String(row.operation_id), syncSpaceId: String(row.sync_space_id),
    actorIncarnationId: String(row.actor_incarnation_id), replicationLaneId: String(row.replication_lane_id),
    sequence: Number(row.sequence), state: String(row.state) as SyncInboxState,
    operationJson: String(row.operation_json), rejectionReason: row.rejection_reason == null ? null : String(row.rejection_reason),
    rejectionDigest: row.rejection_digest == null ? null : String(row.rejection_digest), receivedAt: Number(row.received_at),
    appliedAt: row.applied_at == null ? null : Number(row.applied_at), lastError: row.last_error == null ? null : String(row.last_error),
    authorizationState: String(row.authorization_state ?? 'PROVISIONAL_AUTHORIZED') as SyncInboxRecord['authorizationState'],
    stabilizedByAuthObjectId: row.stabilized_by_auth_object_id == null ? null : String(row.stabilized_by_auth_object_id)
  }
}

function toFieldVersion(row: Record<string, unknown>): SyncFieldVersionRecord {
  return {
    syncSpaceId: String(row.sync_space_id), entityType: String(row.entity_type), entitySyncId: String(row.entity_sync_id),
    fieldId: String(row.field_id), entityGeneration: Number(row.entity_generation), versionToken: String(row.version_token),
    sourceOperationId: row.source_operation_id == null ? null : String(row.source_operation_id),
    valueJson: String(row.value_json),
    causalContextJson: row.causal_context_json == null ? null : String(row.causal_context_json),
    logicalClock: row.logical_clock == null ? null : Number(row.logical_clock),
    updatedAt: Number(row.updated_at)
  }
}
