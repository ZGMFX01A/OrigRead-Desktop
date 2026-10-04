import { frozenSnapshotDatabase } from './sync-frozen-database-context'
import type { DatabaseSync } from 'node:sqlite'
import type {
  SyncBlobAvailabilityState,
  SyncBlobManifest,
  SyncBlobPersistedAck
} from '../../shared/sync-protocol'
import { canonicalJson } from './sync-operation-canonicalizer'

export interface SyncBlobReferenceRecord {
  replicationLaneId: string
  ownerEntityType: string
  ownerEntitySyncId: string
  ownerEntityGeneration: number
  referenceKind: string
  hash: string
}

export interface SyncBlobSnapshotIndexes {
  manifestIndexJson: string
  referenceIndexJson: string
}

export interface SyncBlobRetryCandidate {
  manifest: SyncBlobManifest
  references: SyncBlobReferenceRecord[]
}

interface BlobManifestRow {
  hash: string
  total_bytes: number
  media_type: string | null
  compression: string | null
  encryption_info_json: string | null
  availability_policy: string
  durability: SyncBlobManifest['durability']
  availability_state: SyncBlobAvailabilityState
  failure_reason: string | null
  reference_count: number
  persisted_at: number | null
  last_accessed_at: number | null
}

/** R10 client-side Blob metadata, availability and durability state. */
export class DesktopSyncBlobStateService {
  /** 冻结转换只读取当前 cut 的副本，正常业务使用注入的数据库。 */
  private readonly liveDatabase: DatabaseSync
  private get database(): DatabaseSync { return frozenSnapshotDatabase(this.liveDatabase) }
  isCurrentReference(space: string, type: string, entity: string, generation: number, kind: string, hash: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM sync_blob_reference
      WHERE sync_space_id=? AND owner_entity_type=? AND owner_entity_sync_id=?
        AND owner_entity_generation=? AND reference_kind=? AND hash=?`)
      .get(space,type,entity,generation,kind,hash))
  }
  constructor(database: DatabaseSync) {
    this.liveDatabase = database
}

  registerManifest(
    manifest: SyncBlobManifest,
    initialState: SyncBlobAvailabilityState = 'METADATA_READY',
    now = Date.now()
  ): void {
    validateManifest(manifest)
    const existing = this.findManifest(manifest.hash)
    if (existing && Number(existing.total_bytes) !== manifest.totalBytes) {
      throw new Error('Blob total size cannot change for the same content hash')
    }
    const durability = strongestDurability(existing?.durability, manifest.durability)
    this.database.prepare(`
      INSERT INTO sync_blob_manifest(
        hash,total_bytes,media_type,durability,reference_count,persisted_at,last_accessed_at,
        compression,encryption_info_json,availability_policy,availability_state,failure_reason
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET
        media_type=COALESCE(excluded.media_type,sync_blob_manifest.media_type),
        durability=excluded.durability,
        last_accessed_at=excluded.last_accessed_at,
        compression=COALESCE(excluded.compression,sync_blob_manifest.compression),
        encryption_info_json=COALESCE(excluded.encryption_info_json,sync_blob_manifest.encryption_info_json),
        availability_policy=excluded.availability_policy
    `).run(
      manifest.hash,
      manifest.totalBytes,
      manifest.mediaType,
      durability,
      existing?.reference_count ?? manifest.referenceCount ?? 0,
      existing?.persisted_at ?? null,
      now,
      manifest.compression ?? null,
      manifest.encryptionInfoJson ?? null,
      manifest.availabilityPolicy?.trim() || 'LAZY',
      existing?.availability_state ?? initialState,
      existing?.failure_reason ?? null
    )
  }

  markMissing(hash: string, now = Date.now()): void {
    this.setAvailability(hash, 'BLOB_MISSING', null, null, now)
  }

  markFetching(hash: string, now = Date.now()): void {
    this.setAvailability(hash, 'BLOB_FETCHING', null, null, now)
  }

  markFailed(hash: string, reason: string, now = Date.now()): void {
    this.setAvailability(hash, 'BLOB_FAILED', reason.slice(0, 500), null, now)
  }

  /** Call only after byte length and SHA-256 have been verified against the manifest. */
  markReadyVerified(hash: string, totalBytes: number, now = Date.now()): void {
    const manifest = this.requireManifest(hash)
    if (Number(manifest.total_bytes) !== totalBytes) throw new Error('Blob size does not match manifest')
    this.setAvailability(hash, 'READY', null, now, now)
  }

  addReference(
    syncSpaceId: string,
    lane: string,
    ownerEntityType: string,
    ownerEntitySyncId: string,
    ownerEntityGeneration: number,
    referenceKind: string,
    hash: string,
    now = Date.now()
  ): void {
    this.requireManifest(hash)
    this.database.prepare(`
      INSERT OR IGNORE INTO sync_blob_reference(
        sync_space_id,replication_lane_id,owner_entity_type,owner_entity_sync_id,
        owner_entity_generation,reference_kind,hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration, referenceKind, hash, now)
    this.refreshReferenceCount(hash)
  }

  replaceOwnerReference(
    syncSpaceId: string,
    lane: string,
    ownerEntityType: string,
    ownerEntitySyncId: string,
    ownerEntityGeneration: number,
    referenceKind: string,
    hash: string,
    now = Date.now()
  ): void {
    const rows = this.database.prepare(
      'SELECT hash FROM sync_blob_reference WHERE sync_space_id=? AND replication_lane_id=? ' +
      'AND owner_entity_type=? AND owner_entity_sync_id=? AND owner_entity_generation=? AND reference_kind=?'
    ).all(syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration, referenceKind) as unknown as Array<{ hash: string }>
    for (const row of rows) {
      if (row.hash !== hash) {
        this.removeReference(
          syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration, referenceKind, row.hash
        )
      }
    }
    this.addReference(
      syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration, referenceKind, hash, now
    )
  }

  removeReference(
    syncSpaceId: string,
    lane: string,
    ownerEntityType: string,
    ownerEntitySyncId: string,
    ownerEntityGeneration: number,
    referenceKind: string,
    hash: string
  ): void {
    this.database.prepare(`
      DELETE FROM sync_blob_reference
      WHERE sync_space_id=? AND replication_lane_id=? AND owner_entity_type=? AND owner_entity_sync_id=?
        AND owner_entity_generation=? AND reference_kind=? AND hash=?
    `).run(syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration, referenceKind, hash)
    this.refreshReferenceCount(hash)
  }

  recordPersistedAck(ack: SyncBlobPersistedAck): void {
    if (ack.protocolVersion !== 1 || !ack.syncSpaceId.trim() || !ack.replicaId.trim()) {
      throw new Error('Invalid BlobPersistedAck')
    }
    const manifest = this.requireManifest(ack.hash)
    if (Number(manifest.total_bytes) !== ack.totalBytes) throw new Error('Persisted ACK size does not match Blob manifest')
    this.database.prepare(`
      INSERT INTO sync_blob_persisted_ack(sync_space_id,hash,replica_id,total_bytes,persisted_at,storage_generation,custody_state)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,hash,replica_id) DO UPDATE SET
        total_bytes=excluded.total_bytes,persisted_at=excluded.persisted_at,
        storage_generation=excluded.storage_generation,custody_state=excluded.custody_state
    `).run(ack.syncSpaceId, ack.hash, ack.replicaId, ack.totalBytes, ack.persistedAt, ack.storageGeneration ?? null, ack.custodyState ?? null)
  }

  canAutoGc(syncSpaceId: string, hash: string, localReplicaId: string): boolean {
    const manifest = this.findManifest(hash)
    if (!manifest) return true
    const references = this.database.prepare('SELECT COUNT(*) AS count FROM sync_blob_reference WHERE hash=?')
      .get(hash) as { count: number }
    if (Number(references.count) > 0) return false
    if (manifest.durability !== 'SYNC_DURABLE') return true
    // HOLDING 只证明某次持有，不是可验证的责任转交，不能据此释放最后保管责任。
    return false
  }

  transferAllowed(syncSpaceId: string, hash: string, policyByLane: Record<string, string>): boolean {
    const rows = this.database.prepare(
      'SELECT replication_lane_id FROM sync_blob_reference WHERE sync_space_id=? AND hash=?'
    ).all(syncSpaceId, hash) as unknown as Array<{ replication_lane_id: string }>
    if (!rows.length) return true
    return rows.some((row) =>
      !['PAUSED', 'UNSUPPORTED', 'LOCAL_PURGE'].includes(policyByLane[row.replication_lane_id] ?? 'ENABLED')
    )
  }

  listRetryableReferencedBlobs(syncSpaceId: string, limit = 100): SyncBlobRetryCandidate[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Blob retry limit must be positive')
    const manifests = this.database.prepare(`
      SELECT DISTINCT m.*
      FROM sync_blob_manifest m
      INNER JOIN sync_blob_reference r ON r.hash=m.hash
      WHERE r.sync_space_id=?
        AND m.availability_state IN ('BLOB_MISSING','BLOB_FAILED')
      ORDER BY COALESCE(m.last_accessed_at,0) ASC,m.hash ASC
      LIMIT ?
    `).all(syncSpaceId, limit) as unknown as BlobManifestRow[]
    return manifests.map((row) => {
      const references = this.database.prepare(`
        SELECT replication_lane_id,owner_entity_type,owner_entity_sync_id,
               owner_entity_generation,reference_kind,hash
        FROM sync_blob_reference
        WHERE sync_space_id=? AND hash=?
        ORDER BY replication_lane_id,owner_entity_type,owner_entity_sync_id,reference_kind
      `).all(syncSpaceId, row.hash) as unknown as Array<{
        replication_lane_id: string
        owner_entity_type: string
        owner_entity_sync_id: string
        owner_entity_generation: number
        reference_kind: string
        hash: string
      }>
      return {
        manifest: {
          hash: row.hash,
          totalBytes: Number(row.total_bytes),
          mediaType: row.media_type,
          compression: row.compression,
          encryptionInfoJson: row.encryption_info_json,
          availabilityPolicy: row.availability_policy,
          durability: row.durability,
          referenceCount: Number(row.reference_count)
        },
        references: references.map((reference) => ({
          replicationLaneId: reference.replication_lane_id,
          ownerEntityType: reference.owner_entity_type,
          ownerEntitySyncId: reference.owner_entity_sync_id,
          ownerEntityGeneration: Number(reference.owner_entity_generation),
          referenceKind: reference.reference_kind,
          hash: reference.hash
        }))
      }
    })
  }

  removeOwnerReferences(
    syncSpaceId: string,
    lane: string,
    ownerEntityType: string,
    ownerEntitySyncId: string,
    ownerEntityGeneration: number
  ): void {
    const rows = this.database.prepare(
      'SELECT reference_kind,hash FROM sync_blob_reference WHERE sync_space_id=? AND replication_lane_id=? ' +
      'AND owner_entity_type=? AND owner_entity_sync_id=? AND owner_entity_generation=? ORDER BY reference_kind,hash'
    ).all(syncSpaceId, lane, ownerEntityType, ownerEntitySyncId, ownerEntityGeneration) as unknown as Array<{
      reference_kind: string
      hash: string
    }>
    for (const row of rows) {
      this.removeReference(
        syncSpaceId,
        lane,
        ownerEntityType,
        ownerEntitySyncId,
        ownerEntityGeneration,
        row.reference_kind,
        row.hash
      )
    }
  }

  clearLaneReferences(syncSpaceId: string, lane: string): void {
    const rows = this.database.prepare(
      'SELECT owner_entity_type,owner_entity_sync_id,owner_entity_generation,reference_kind,hash ' +
      'FROM sync_blob_reference WHERE sync_space_id=? AND replication_lane_id=?'
    ).all(syncSpaceId, lane) as unknown as Array<{
      owner_entity_type: string
      owner_entity_sync_id: string
      owner_entity_generation: number
      reference_kind: string
      hash: string
    }>
    for (const row of rows) {
      this.removeReference(
        syncSpaceId,
        lane,
        row.owner_entity_type,
        row.owner_entity_sync_id,
        Number(row.owner_entity_generation),
        row.reference_kind,
        row.hash
      )
    }
  }

  clearMaterializedLaneReferences(syncSpaceId: string, lane: string): void {
    const rows = this.database.prepare(
      'SELECT owner_entity_type,owner_entity_sync_id,owner_entity_generation,reference_kind,hash ' +
      "FROM sync_blob_reference WHERE sync_space_id=? AND replication_lane_id=? AND owner_entity_type<>'__operation__'"
    ).all(syncSpaceId, lane) as unknown as Array<{
      owner_entity_type: string
      owner_entity_sync_id: string
      owner_entity_generation: number
      reference_kind: string
      hash: string
    }>
    for (const row of rows) {
      this.removeReference(
        syncSpaceId,
        lane,
        row.owner_entity_type,
        row.owner_entity_sync_id,
        Number(row.owner_entity_generation),
        row.reference_kind,
        row.hash
      )
    }
  }

  snapshotIndexes(syncSpaceId: string, lane: string): SyncBlobSnapshotIndexes {
    const rows = this.database.prepare(`
      SELECT replication_lane_id,owner_entity_type,owner_entity_sync_id,owner_entity_generation,reference_kind,hash
      FROM sync_blob_reference
      WHERE sync_space_id=? AND replication_lane_id=? AND owner_entity_type<>'__operation__'
      ORDER BY owner_entity_type,owner_entity_sync_id,owner_entity_generation,reference_kind,hash
    `).all(syncSpaceId, lane) as unknown as Array<{
      replication_lane_id: string
      owner_entity_type: string
      owner_entity_sync_id: string
      owner_entity_generation: number
      reference_kind: string
      hash: string
    }>
    const references: SyncBlobReferenceRecord[] = rows.map((row) => ({
      replicationLaneId: row.replication_lane_id,
      ownerEntityType: row.owner_entity_type,
      ownerEntitySyncId: row.owner_entity_sync_id,
      ownerEntityGeneration: Number(row.owner_entity_generation),
      referenceKind: row.reference_kind,
      hash: row.hash
    }))
    const manifests = [...new Set(references.map((reference) => reference.hash))].sort().map((hash) => {
      const row = this.requireManifest(hash)
      return {
        hash: row.hash,
        totalBytes: Number(row.total_bytes),
        mediaType: row.media_type,
        compression: row.compression,
        encryptionInfoJson: row.encryption_info_json,
        availabilityPolicy: row.availability_policy,
        durability: row.durability,
        referenceCount: Number(row.reference_count)
      } satisfies SyncBlobManifest
    })
    return {
      manifestIndexJson: canonicalJson(JSON.stringify(manifests)),
      referenceIndexJson: canonicalJson(JSON.stringify(references))
    }
  }

  private findManifest(hash: string): BlobManifestRow | null {
    return (this.database.prepare('SELECT * FROM sync_blob_manifest WHERE hash=? LIMIT 1').get(hash) as BlobManifestRow | undefined) ?? null
  }

  private requireManifest(hash: string): BlobManifestRow {
    const manifest = this.findManifest(hash)
    if (!manifest) throw new Error(`Unknown Blob manifest ${hash}`)
    return manifest
  }

  private setAvailability(
    hash: string,
    state: SyncBlobAvailabilityState,
    failureReason: string | null,
    persistedAt: number | null,
    now: number
  ): void {
    this.requireManifest(hash)
    const result = this.database.prepare(`
      UPDATE sync_blob_manifest
      SET availability_state=?,failure_reason=?,persisted_at=?,last_accessed_at=?
      WHERE hash=?
    `).run(state, failureReason, persistedAt, now, hash)
    if (Number(result.changes) !== 1) throw new Error('Blob availability update was lost')
  }

  private refreshReferenceCount(hash: string): void {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM sync_blob_reference WHERE hash=?').get(hash) as { count: number }
    this.database.prepare('UPDATE sync_blob_manifest SET reference_count=? WHERE hash=?').run(Number(row.count), hash)
  }
}

function validateManifest(manifest: SyncBlobManifest): void {
  if (!/^[a-f0-9]{64}$/.test(manifest.hash)) throw new Error('Blob hash must be lowercase SHA-256 hex')
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error('Blob size must be a non-negative safe integer')
  if (manifest.availabilityPolicy != null && !manifest.availabilityPolicy.trim()) throw new Error('Blob availability policy must not be blank')
}

function strongestDurability(
  existing: SyncBlobManifest['durability'] | undefined,
  incoming: SyncBlobManifest['durability']
): SyncBlobManifest['durability'] {
  if (!existing) return incoming
  const rank: Record<SyncBlobManifest['durability'], number> = { CACHE: 0, REHYDRATABLE: 1, SYNC_DURABLE: 2 }
  return rank[incoming] > rank[existing] ? incoming : existing
}
