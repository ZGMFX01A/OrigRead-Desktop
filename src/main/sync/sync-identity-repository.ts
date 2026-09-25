import type { DatabaseSync } from 'node:sqlite'
import type { SyncEntityType, SyncIdentityMappingRecord, SyncSpaceRecord } from '../../shared/sync-identity'

interface SyncSpaceRow {
  sync_space_id: string
  created_at: number
  updated_at: number
}

interface SyncIdentityMappingRow {
  sync_space_id: string
  entity_type: SyncEntityType
  local_id: string
  sync_id: string
  canonical_key: string | null
  generation: number
  created_at: number
  updated_at: number
}

/**
 * Local persistence adapter for R10 identity metadata.
 *
 * It deliberately does not generate IDs, calculate canonical keys, or merge aliases. Those are Sync Core
 * responsibilities added in later R10 steps.
 */
export class SyncIdentityRepository {
  constructor(private readonly database: DatabaseSync) {}

  insertSpace(space: SyncSpaceRecord): void {
    this.database.prepare(`
      INSERT INTO sync_spaces(sync_space_id,created_at,updated_at)
      VALUES(?,?,?)
    `).run(space.syncSpaceId, space.createdAt, space.updatedAt)
  }

  insertSpaceIgnore(space: SyncSpaceRecord): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO sync_spaces(sync_space_id,created_at,updated_at)
      VALUES(?,?,?)
    `).run(space.syncSpaceId, space.createdAt, space.updatedAt)
  }

  findSpace(syncSpaceId: string): SyncSpaceRecord | null {
    const row = this.database.prepare(`
      SELECT sync_space_id,created_at,updated_at
      FROM sync_spaces WHERE sync_space_id=?
    `).get(syncSpaceId) as SyncSpaceRow | undefined
    return row ? toSpaceRecord(row) : null
  }

  insertMapping(mapping: SyncIdentityMappingRecord): void {
    this.database.prepare(`
      INSERT INTO sync_identity_mapping(
        sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      mapping.syncSpaceId,
      mapping.entityType,
      mapping.localId,
      mapping.syncId,
      mapping.canonicalKey,
      mapping.generation,
      mapping.createdAt,
      mapping.updatedAt
    )
  }

  insertMappingsIgnore(mappings: SyncIdentityMappingRecord[]): void {
    if (mappings.length === 0) return
    const statement = this.database.prepare(`
      INSERT OR IGNORE INTO sync_identity_mapping(
        sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `)
    for (const mapping of mappings) {
      statement.run(
        mapping.syncSpaceId,
        mapping.entityType,
        mapping.localId,
        mapping.syncId,
        mapping.canonicalKey,
        mapping.generation,
        mapping.createdAt,
        mapping.updatedAt
      )
    }
  }

  updateMappings(mappings: SyncIdentityMappingRecord[]): void {
    if (mappings.length === 0) return
    const statement = this.database.prepare(`
      UPDATE sync_identity_mapping
      SET sync_id=?,canonical_key=?,generation=?,created_at=?,updated_at=?
      WHERE sync_space_id=? AND entity_type=? AND local_id=?
    `)
    for (const mapping of mappings) {
      statement.run(
        mapping.syncId,
        mapping.canonicalKey,
        mapping.generation,
        mapping.createdAt,
        mapping.updatedAt,
        mapping.syncSpaceId,
        mapping.entityType,
        mapping.localId
      )
    }
  }

  listByType(syncSpaceId: string, entityType: SyncEntityType): SyncIdentityMappingRecord[] {
    const rows = this.database.prepare(`
      SELECT sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type=?
      ORDER BY local_id ASC
    `).all(syncSpaceId, entityType) as unknown as SyncIdentityMappingRow[]
    return rows.map(toMappingRecord)
  }

  findByLocalId(syncSpaceId: string, entityType: SyncEntityType, localId: string): SyncIdentityMappingRecord | null {
    const row = this.database.prepare(`
      SELECT sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type=? AND local_id=?
    `).get(syncSpaceId, entityType, localId) as SyncIdentityMappingRow | undefined
    return row ? toMappingRecord(row) : null
  }

  findBySyncId(syncSpaceId: string, entityType: SyncEntityType, syncId: string): SyncIdentityMappingRecord | null {
    const row = this.database.prepare(`
      SELECT sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type=? AND sync_id=?
    `).get(syncSpaceId, entityType, syncId) as SyncIdentityMappingRow | undefined
    return row ? toMappingRecord(row) : null
  }

  findCanonicalCandidates(
    syncSpaceId: string,
    entityType: SyncEntityType,
    canonicalKey: string
  ): SyncIdentityMappingRecord[] {
    const rows = this.database.prepare(`
      SELECT sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type=? AND canonical_key=?
      ORDER BY sync_id ASC
    `).all(syncSpaceId, entityType, canonicalKey) as unknown as SyncIdentityMappingRow[]
    return rows.map(toMappingRecord)
  }
}

function toSpaceRecord(row: SyncSpaceRow): SyncSpaceRecord {
  return { syncSpaceId: row.sync_space_id, createdAt: row.created_at, updatedAt: row.updated_at }
}

function toMappingRecord(row: SyncIdentityMappingRow): SyncIdentityMappingRecord {
  return {
    syncSpaceId: row.sync_space_id,
    entityType: row.entity_type,
    localId: row.local_id,
    syncId: row.sync_id,
    canonicalKey: row.canonical_key,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
