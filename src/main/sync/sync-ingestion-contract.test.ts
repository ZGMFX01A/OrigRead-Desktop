import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { MemorySecretStore } from '../security/secret-store'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { toSyncOperationEnvelope } from '../../shared/sync-protocol'
import { SyncApplyCoordinator } from './sync-apply-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { operationId, operationSigningDigest, operationSigningMaterial, sha256Hex } from './sync-operation-canonicalizer'

function fixture(allowUnanchoredTestOperations = true) {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  const runtime = new SyncRuntimeRepository(db)
  const state = new SyncStateRepository(db)
  const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
  const applied: string[] = []
  const coordinator = new SyncApplyCoordinator(runtime, state, {
    apply: (op) => { applied.push(op.operationId) }
  }, { allowUnanchoredTestOperations })
  const operation = (overrides: Partial<SyncOperationRecord> = {}) => {
    const row: SyncOperationRecord = {
      operationId: '', syncSpaceId: 'space', authorDeviceId: 'author', actorIncarnationId: 'actor',
      replicationLaneId: 'ARTICLE_STATE', sequence: 1, logicalClock: 1,
      causalContextJson: '{}', dependencyDotsJson: '[]', entityType: 'article', entitySyncId: 'article',
      entityGeneration: 0, operationType: 'FIELD_SET', payloadSchemaVersion: 1,
      payloadJson: '{"field":"isStarred","value":true}', schemaVersion: 1,
      authGrantId: null, authEpoch: null, createdWallClock: 1, payloadHash: '', signingDigest: '',
      authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1, ...overrides
    }
    row.operationId = operationId(row.syncSpaceId, row.actorIncarnationId, row.replicationLaneId, row.sequence)
    row.payloadHash = sha256Hex(row.payloadJson)
    row.signingDigest = operationSigningDigest(row)
    row.authorSignature = keys.signBase64(row.authorDeviceId, operationSigningMaterial(row))
    return toSyncOperationEnvelope(row)
  }
  const options = { resolvePeerKey: (_space: string, device: string) => ({
    publicKeySpkiBase64: keys.publicKeySpkiBase64(device), status: 'ACTIVE' as const, authEpoch: 0
  }) }
  return { db, state, coordinator, applied, operation, options }
}

describe('R10 durable receive boundary', () => {
  it('reaches dependencies beyond a full deferred page', () => {
    const f = fixture()
    try {
      const z = f.operation({ actorIncarnationId: 'z' })
      const a1 = f.operation({ actorIncarnationId: 'a', dependencyDotsJson: JSON.stringify([
        { actorIncarnationId: 'z', replicationLaneId: 'ARTICLE_STATE', sequence: 1 }
      ]) })
      const a2 = f.operation({ actorIncarnationId: 'a', sequence: 2 })
      f.coordinator.ingest([a1, a2, z], f.options)
      for (let attempt = 0; attempt < 4; attempt++) f.coordinator.applyPending('space', 2)
      expect(f.applied).toEqual([z.operationId, a1.operationId, a2.operationId])
    } finally { f.db.close() }
  })

  it('drains a contiguous actor batch without hash-order rescans', () => {
    const f = fixture()
    try {
      const operations = Array.from({ length: 100 }, (_, index) => f.operation({ sequence: index + 1 }))
      f.coordinator.ingest(operations, f.options)
      expect(f.coordinator.applyPending('space', 100).appliedOperationIds).toEqual(operations.map(op => op.operationId))
    } finally { f.db.close() }
  })

  it('retains a future schema without business apply or swallowing its lane gap', () => {
    const f = fixture()
    try {
      const first = f.operation({ payloadSchemaVersion: 2 })
      const second = f.operation({ sequence: 2 })
      expect(f.coordinator.ingest([second, first], f.options).acceptedOperationIds).toHaveLength(2)
      expect(f.coordinator.applyPending('space').appliedOperationIds).toEqual([])
      expect(f.applied).toEqual([])
      expect(f.state.getCoverage('space').received.ARTICLE_STATE?.actor).toBe(2)
      expect(f.state.getCoverage('space').applied).toEqual({})
    } finally { f.db.close() }
  })

  it('does not allow a second author to continue an existing actor sequence', () => {
    const f = fixture()
    try {
      f.coordinator.ingest([f.operation()], f.options)
      const report = f.coordinator.ingest([f.operation({ authorDeviceId: 'other', sequence: 2 })], f.options)
      expect(report.rejected[0]?.code).toBe('AUTH_FAILED')
      expect(f.state.getCoverage('space').received.ARTICLE_STATE?.actor).toBe(1)
    } finally { f.db.close() }
  })

  it('never treats a peer key registration as a Space membership grant', () => {
    const f = fixture(false)
    try {
      expect(f.coordinator.ingest([f.operation()], f.options).rejected[0]?.code).toBe('AUTH_FAILED')
      expect(f.state.getCoverage('space').received).toEqual({})
    } finally { f.db.close() }
  })

  it('retains actor ownership after its operation history has been compacted', () => {
    const f = fixture()
    try {
      f.coordinator.ingest([f.operation()], f.options)
      f.db.prepare('DELETE FROM sync_inbox_operation').run()
      f.db.prepare('DELETE FROM sync_operation_log').run()
      const report = f.coordinator.ingest([f.operation({ authorDeviceId: 'other', sequence: 2 })], f.options)
      expect(report.rejected[0]?.code).toBe('AUTH_FAILED')
      expect(f.db.prepare('SELECT author_device_id FROM sync_actor_author').get()).toMatchObject({ author_device_id: 'author' })
    } finally { f.db.close() }
  })
})
