import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncEntityType, SyncIdentityMappingRecord } from '../../shared/sync-identity'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { canonicalJson } from './sync-operation-canonicalizer'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncStateRepository } from './sync-state-repository'
import { SyncVersionToken } from './sync-version-token'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { SyncApplyDeferredError } from './sync-apply-coordinator'
import { DesktopSyncRuntimeCoordinator, SyncActorRollbackDetectedError } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { DesktopSyncBlobStateService } from './sync-blob-state'

export interface SyncAliasEdgePayloadV1 {
  targetEntityType: SyncEntityType
  leftSyncId: string
  leftGeneration: number
  rightSyncId: string
  rightGeneration: number
}

interface AliasEdgeRow {
  left_sync_id: string
  left_generation: number
  right_sync_id: string
  right_generation: number
}

/** R10 source-of-truth for generation-scoped, undirected Alias equivalence. */
export class DesktopSyncAliasResolver {
  private readonly identities: SyncIdentityRepository
  private readonly blobs: DesktopSyncBlobStateService

  constructor(
    private readonly database: DatabaseSync,
    private readonly state = new SyncStateRepository(database),
    private readonly onFeedDeleted: (localFeedId: string) => void = () => {}
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.blobs = new DesktopSyncBlobStateService(database)
  }

  applyEdge(syncSpaceId: string, payload: SyncAliasEdgePayloadV1, sourceOperationId: string | null = null, now = Date.now()): void {
    this.validate(payload)
    const [left, right] = normalizedEndpoints(payload)
    this.database.prepare(`
      INSERT OR IGNORE INTO sync_alias_edge(
        sync_space_id,entity_type,left_sync_id,left_generation,right_sync_id,right_generation,source_operation_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(syncSpaceId, payload.targetEntityType, left.syncId, left.generation, right.syncId, right.generation, sourceOperationId, now)
    this.rebuild(syncSpaceId, payload.targetEntityType, now)
    this.reconcileDeleteWins(syncSpaceId, payload.targetEntityType, left.syncId, left.generation, now)
  }

  rebuild(syncSpaceId: string, entityType: SyncEntityType, now = Date.now()): void {
    const rows = this.database.prepare(`
      SELECT left_sync_id,left_generation,right_sync_id,right_generation
      FROM sync_alias_edge
      WHERE sync_space_id=? AND entity_type=?
      ORDER BY left_generation,left_sync_id,right_sync_id
    `).all(syncSpaceId, entityType) as unknown as AliasEdgeRow[]
    const insert = this.database.prepare(`
      INSERT INTO sync_entity_alias(sync_space_id,entity_type,alias_sync_id,canonical_sync_id,generation,created_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,alias_sync_id,generation)
      DO UPDATE SET canonical_sync_id=excluded.canonical_sync_id,created_at=excluded.created_at
    `)
    this.database.prepare('DELETE FROM sync_entity_alias WHERE sync_space_id=? AND entity_type=?').run(syncSpaceId, entityType)
    const byGeneration = new Map<number, AliasEdgeRow[]>()
    for (const row of rows) {
      const list = byGeneration.get(row.left_generation) ?? []
      list.push(row)
      byGeneration.set(row.left_generation, list)
    }
    for (const [generation, edges] of byGeneration) {
      const graph = new Map<string, Set<string>>()
      for (const edge of edges) {
        getSet(graph, edge.left_sync_id).add(edge.right_sync_id)
        getSet(graph, edge.right_sync_id).add(edge.left_sync_id)
      }
      const visited = new Set<string>()
      for (const seed of [...graph.keys()].sort()) {
        if (visited.has(seed)) continue
        const members: string[] = []
        const queue = [seed]
        visited.add(seed)
        while (queue.length) {
          const current = queue.shift()!
          members.push(current)
          for (const next of [...(graph.get(current) ?? [])].sort()) {
            if (!visited.has(next)) {
              visited.add(next)
              queue.push(next)
            }
          }
        }
        const representative = [...members].sort()[0]!
        for (const member of members) insert.run(syncSpaceId, entityType, member, representative, generation, now)
      }
    }
  }

  componentMembers(syncSpaceId: string, entityType: SyncEntityType, syncId: string, generation: number): Set<string> {
    const rows = this.database.prepare(`
      SELECT left_sync_id,left_generation,right_sync_id,right_generation
      FROM sync_alias_edge
      WHERE sync_space_id=? AND entity_type=? AND left_generation=? AND right_generation=?
    `).all(syncSpaceId, entityType, generation, generation) as unknown as AliasEdgeRow[]
    const graph = new Map<string, Set<string>>()
    for (const edge of rows) {
      getSet(graph, edge.left_sync_id).add(edge.right_sync_id)
      getSet(graph, edge.right_sync_id).add(edge.left_sync_id)
    }
    const result = new Set([syncId])
    const queue = [syncId]
    while (queue.length) {
      const current = queue.shift()!
      for (const next of [...(graph.get(current) ?? [])].sort()) {
        if (!result.has(next)) {
          result.add(next)
          queue.push(next)
        }
      }
    }
    return result
  }

  resolveMapping(
    syncSpaceId: string,
    entityType: SyncEntityType,
    syncId: string,
    generation: number
  ): SyncIdentityMappingRecord | null {
    const direct = this.identities.findBySyncId(syncSpaceId, entityType, syncId)
    if (direct?.generation === generation) return direct
    for (const member of [...this.componentMembers(syncSpaceId, entityType, syncId, generation)].sort()) {
      const mapping = this.identities.findBySyncId(syncSpaceId, entityType, member)
      if (mapping?.generation === generation) return mapping
    }
    return null
  }

  payloadJson(payload: SyncAliasEdgePayloadV1): string {
    this.validate(payload)
    return canonicalJson(JSON.stringify(payload))
  }

  edgeSyncId(payload: SyncAliasEdgePayloadV1): string {
    this.validate(payload)
    const [left, right] = normalizedEndpoints(payload)
    const material = [payload.targetEntityType, left.syncId, left.generation, right.syncId, right.generation].join('\0')
    return `alias:v1:${createHash('sha256').update(material, 'utf8').digest('hex')}`
  }

  applyGlobalDelete(operation: SyncOperationRecord, now = Date.now()): void {
    const entityType = operation.entityType as SyncEntityType
    const members = this.componentMembers(
      operation.syncSpaceId,
      entityType,
      operation.entitySyncId,
      operation.entityGeneration
    )
    const token = SyncVersionToken.operation(
      operation.actorIncarnationId,
      operation.replicationLaneId,
      operation.sequence
    )
    const binding = this.database.prepare(
      'SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1'
    ).get(operation.syncSpaceId) as { local_account_id: number } | undefined
    for (const member of members) {
      this.state.recordTombstone(
        operation.syncSpaceId,
        entityType,
        member,
        operation.entityGeneration,
        token,
        now,
        operation.operationId
      )
      if (entityType === 'article') {
        this.blobs.removeOwnerReferences(
          operation.syncSpaceId,
          'ARTICLE_STATE',
          'article',
          member,
          operation.entityGeneration
        )
      }
      const mapping = this.identities.findBySyncId(operation.syncSpaceId, entityType, member)
      if (!mapping || mapping.generation !== operation.entityGeneration || !binding) continue
      this.ensureDeleteDependenciesCleared(binding.local_account_id, entityType, mapping.localId)
      if (entityType === 'article') {
        this.database.prepare('DELETE FROM articles WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
      } else if (entityType === 'feed') {
        const result = this.database.prepare('DELETE FROM feeds WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
        const remaining = this.database.prepare('SELECT 1 FROM feeds WHERE id=? LIMIT 1').get(mapping.localId)
        if (Number(result.changes) > 0 || !remaining) this.onFeedDeleted(mapping.localId)
      } else if (entityType === 'group') {
        this.database.prepare('DELETE FROM groups WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
      }
    }
  }

  private validate(payload: SyncAliasEdgePayloadV1): void {
    if (payload.targetEntityType === 'alias_edge') throw new Error('Alias Edge cannot alias Alias Edge')
    if (!payload.leftSyncId.trim() || !payload.rightSyncId.trim() || payload.leftSyncId === payload.rightSyncId) {
      throw new Error('Alias endpoints must be distinct and non-empty')
    }
    if (!Number.isSafeInteger(payload.leftGeneration) || payload.leftGeneration < 0 || payload.leftGeneration !== payload.rightGeneration) {
      throw new Error('Alias Edge must stay within one entity generation')
    }
  }

  reconcileDeleteWins(syncSpaceId: string, entityType: SyncEntityType, syncId: string, generation: number, now = Date.now()): void {
    const members = this.componentMembers(syncSpaceId, entityType, syncId, generation)
    const tombstones = [...members].map((member) => this.database.prepare(`
      SELECT entity_sync_id,generation,version_token,deleted_at,source_operation_id
      FROM sync_entity_tombstone
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND generation=?
    `).get(syncSpaceId, entityType, member, generation) as
      { entity_sync_id: string; generation: number; version_token: string; deleted_at: number; source_operation_id: string | null } | undefined)
      .filter((row): row is { entity_sync_id: string; generation: number; version_token: string; deleted_at: number; source_operation_id: string | null } => Boolean(row))
      .sort((a, b) => a.version_token.localeCompare(b.version_token))
    const witness = tombstones.at(-1)
    if (!witness) return
    const binding = this.database.prepare('SELECT local_account_id FROM sync_local_space_binding WHERE sync_space_id=? LIMIT 1')
      .get(syncSpaceId) as { local_account_id: number } | undefined
    for (const member of members) {
      this.state.recordTombstone(
        syncSpaceId,
        entityType,
        member,
        generation,
        witness.version_token,
        now,
        witness.source_operation_id
      )
      if (entityType === 'article') {
        this.blobs.removeOwnerReferences(
          syncSpaceId,
          'ARTICLE_STATE',
          'article',
          member,
          generation
        )
      }
      const mapping = this.identities.findBySyncId(syncSpaceId, entityType, member)
      if (!mapping || mapping.generation !== generation || !binding) continue
      this.ensureDeleteDependenciesCleared(binding.local_account_id, entityType, mapping.localId)
      if (entityType === 'article') this.database.prepare('DELETE FROM articles WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
      else if (entityType === 'feed') {
        const result = this.database.prepare('DELETE FROM feeds WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
        const remaining = this.database.prepare('SELECT 1 FROM feeds WHERE id=? LIMIT 1').get(mapping.localId)
        if (Number(result.changes) > 0 || !remaining) this.onFeedDeleted(mapping.localId)
      }
      else if (entityType === 'group') this.database.prepare('DELETE FROM groups WHERE id=? AND account_id=?').run(mapping.localId, binding.local_account_id)
    }
  }

  private ensureDeleteDependenciesCleared(localAccountId: number, entityType: SyncEntityType, localId: string): void {
    if (entityType === 'feed') {
      const dependent = this.database.prepare(
        'SELECT 1 FROM articles WHERE account_id=? AND feed_id=? LIMIT 1'
      ).get(localAccountId, localId)
      if (dependent) {
        throw new SyncApplyDeferredError('Alias Feed delete is waiting for dependent Article deletes')
      }
    } else if (entityType === 'group') {
      const dependent = this.database.prepare(
        'SELECT 1 FROM feeds WHERE account_id=? AND group_id=? LIMIT 1'
      ).get(localAccountId, localId)
      if (dependent) {
        throw new SyncApplyDeferredError('Alias Group delete is waiting for dependent Feed deletes')
      }
    }
  }
}

export class DesktopSyncLocalEvictionService {
  constructor(private readonly database: DatabaseSync) {}

  markEvicted(syncSpaceId: string, entityType: SyncEntityType, entitySyncId: string, generation: number, resourceKind: string, now = Date.now()): void {
    if (!resourceKind.trim()) throw new Error('resourceKind must not be blank')
    this.database.prepare(`
      INSERT INTO sync_local_eviction(sync_space_id,entity_type,entity_sync_id,entity_generation,resource_kind,evicted_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id,entity_generation,resource_kind)
      DO UPDATE SET evicted_at=excluded.evicted_at
    `).run(syncSpaceId, entityType, entitySyncId, generation, resourceKind, now)
  }

  clearEvicted(syncSpaceId: string, entityType: SyncEntityType, entitySyncId: string, generation: number, resourceKind: string): void {
    this.database.prepare(`
      DELETE FROM sync_local_eviction WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND resource_kind=?
    `).run(syncSpaceId, entityType, entitySyncId, generation, resourceKind)
  }

  isEvicted(syncSpaceId: string, entityType: SyncEntityType, entitySyncId: string, generation: number, resourceKind: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS present FROM sync_local_eviction WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND resource_kind=? LIMIT 1
    `).get(syncSpaceId, entityType, entitySyncId, generation, resourceKind))
  }
}

export class DesktopSyncAliasMutationCapture {
  private readonly resolver: DesktopSyncAliasResolver

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly coordinator: DesktopSyncRuntimeCoordinator,
    private readonly allocator: DesktopSyncOutboxAllocator,
    onFeedDeleted: (localFeedId: string) => void = () => {}
  ) {
    this.resolver = new DesktopSyncAliasResolver(database, new SyncStateRepository(database), onFeedDeleted)
  }

  capture(accountId: number, payload: SyncAliasEdgePayloadV1, now = Date.now()) {
    const edgeSyncId = this.resolver.edgeSyncId(payload)
    let context = this.coordinator.currentWritableContext(accountId, now)
    if (!context) return null

    const attempt = () => this.runtime.transaction(() => {
      this.resolver.applyEdge(context!.syncSpaceId, payload, null, now)
      return this.allocator.allocate(context!, 'CORE_META', {
        entityType: 'alias_edge',
        entitySyncId: edgeSyncId,
        entityGeneration: payload.leftGeneration,
        mutationType: 'UPSERT',
        payloadJson: this.resolver.payloadJson(payload)
      }, [], now)
    })

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'alias-edge-outbox-witness-mismatch', now)
      return attempt()
    }
  }
}

function normalizedEndpoints(payload: SyncAliasEdgePayloadV1): [
  { syncId: string; generation: number },
  { syncId: string; generation: number }
] {
  const left = { syncId: payload.leftSyncId, generation: payload.leftGeneration }
  const right = { syncId: payload.rightSyncId, generation: payload.rightGeneration }
  return left.syncId < right.syncId ? [left, right] : [right, left]
}

function getSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let result = map.get(key)
  if (!result) {
    result = new Set<string>()
    map.set(key, result)
  }
  return result
}
