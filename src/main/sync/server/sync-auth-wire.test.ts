import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../../security/secret-store'
import { DesktopSyncDeviceSigningKeyStore } from '../sync-device-signing-key-store'
import { authObjectId, authSigningDigest, authSigningMaterial, ownerRecoverySigningMaterial, validateSyncAuthProtocolObject, verifySyncAuthSignature } from '../sync-auth-wire'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../database/migrations'
import { SyncRuntimeRepository } from '../sync-runtime-repository'
import { SyncApplyCoordinator } from '../sync-apply-coordinator'
import { operationRecordFromWire, operationEnvelopeFromRecord } from '../sync-operation-wire'
import { SyncStateRepository } from '../sync-state-repository'
import { DesktopAuthLedgerService } from '../sync-auth-ledger'
import { canonicalJson, operationId, operationSigningDigest, operationSigningMaterial, sha256Hex } from '../sync-operation-canonicalizer'
import { SyncServerStore } from './sync-server-store'
import type { SyncAuthProtocolObject, SyncOperationEnvelope } from '../../../shared/sync-protocol'
import type { SyncOperationRecord } from '../../../shared/sync-runtime'

describe('signed single-owner AUTH history', () => {
  it('matches the Android sequence-bound canonical fixture', () => {
    const payloadJson = '{"ownerDeviceId":"device-owner","spaceName":"demo"}'
    const payloadHash = sha256Hex(payloadJson)
    const object: SyncAuthProtocolObject = {
      protocolVersion: 1, authObjectId: authObjectId('space-1', 0, 'SPACE_ROOT', 'device-owner', payloadHash),
      syncSpaceId: 'space-1', authEpoch: 0, authSequence: 0, objectType: 'SPACE_ROOT',
      authorDeviceId: 'device-owner', ownerDeviceId: 'device-owner', targetDeviceId: null,
      previousEpochFinalAcceptedPrefixByActorLane: {}, revokeCutoffByActorLane: null,
      payloadJson, payloadHash, signingDigest: '', authorSignature: 'fixture-signature',
    }
    expect(object.authObjectId).toBe('auth1:44872226230272f9f37bb07f362946b65d1f0980c95b30cfc5007a006a946126')
    expect(authSigningDigest(object)).toBe('35f3791c574855068f96321bb7831513f30516096911492dc2df2dce9abc927c')
  })

  it('client verifies ordered AUTH atomically and rejects sequence tampering', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const auth = new DesktopAuthLedgerService(runtime, state)
    const owner = 'owner'
    state.registerPeer({ syncSpaceId: 'space', deviceId: owner, publicKeySpkiBase64: keys.publicKeySpkiBase64(owner), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    const root = makeAuth(keys, { syncSpaceId: 'space', authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: owner, ownerDeviceId: owner, payload: {} })
    const grant = makeAuth(keys, { syncSpaceId: 'space', authEpoch: 0, objectType: 'MEMBER_GRANT', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: 'member', payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64('member') } })
    const revoke = makeAuth(keys, { syncSpaceId: 'space', authEpoch: 0, objectType: 'MEMBER_REVOKE', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: 'member', payload: {}, revokeCutoffByActorLane: {} })
    try {
      expect(() => validateSyncAuthProtocolObject({ ...grant, authSequence: 3 })).toThrow()
      expect(verifySyncAuthSignature({ ...grant, authSequence: 3 }, keys.publicKeySpkiBase64(owner))).toBe(false)
      expect(() => auth.append('space', [root, { ...grant, authSequence: 3 }])).toThrow()
      expect(runtime.listAuthObjects('space')).toEqual([])
      auth.append('space', [revoke, grant, root])
      expect(runtime.listAuthObjects('space')).toEqual([root, grant, revoke])
      expect(state.findPeer('space', 'member')?.status).toBe('REVOKED')
      expect(() => auth.append('other-space', [root])).toThrow('AUTH_SPACE_MISMATCH')
    } finally { db.close() }
  })
  it('commits revoke and applied rollback atomically, preserving both on failure', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    let fail = true
    const apply = new SyncApplyCoordinator(runtime, state, { apply: () => {}, rollbackField: () => {
      state.deleteFieldVersion('space-auth', 'article', 'article-1', 'isStarred')
      if (fail) throw new Error('baseline missing')
    } })
    const auth = new DesktopAuthLedgerService(runtime, state, apply)
    state.registerPeer({ syncSpaceId: 'space-auth', deviceId: 'owner', publicKeySpkiBase64: keys.publicKeySpkiBase64('owner'), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    const root = makeAuth(keys, { syncSpaceId: 'space-auth', authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: 'owner', ownerDeviceId: 'owner', payload: {} })
    const grant = makeAuth(keys, { syncSpaceId: 'space-auth', authEpoch: 0, objectType: 'MEMBER_GRANT', authorDeviceId: 'owner', ownerDeviceId: 'owner', targetDeviceId: 'member', payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64('member') } })
    const revoke = makeAuth(keys, { syncSpaceId: 'space-auth', authEpoch: 0, objectType: 'MEMBER_REVOKE', authorDeviceId: 'owner', ownerDeviceId: 'owner', targetDeviceId: 'member', payload: {}, revokeCutoffByActorLane: {} })
    try {
      auth.append('space-auth', [root, grant])
      const op = operationRecordFromWire(makeOperation(keys, { deviceId: 'member', actor: 'member-actor', sequence: 1, authEpoch: 0, authGrantId: grant.authObjectId }), 1)
      runtime.insertOperationIgnore(op)
      state.insertInbox(op, JSON.stringify(op), 1)
      state.markApplied(op.operationId, 2)
      state.upsertFieldVersion({ syncSpaceId: 'space-auth', entityType: 'article', entitySyncId: 'article-1', fieldId: 'isStarred', entityGeneration: 0, versionToken: 'test-version', sourceOperationId: op.operationId, valueJson: 'true', updatedAt: 2 })
      expect(() => auth.append('space-auth', [revoke])).toThrow('baseline missing')
      expect(runtime.listAuthObjects('space-auth')).toHaveLength(2)
      expect(state.findInbox(op.operationId)?.state).toBe('APPLIED')
      expect(state.findFieldVersion('space-auth', 'article', 'article-1', 'isStarred')).not.toBeNull()
      fail = false
      auth.append('space-auth', [revoke])
      expect(runtime.listAuthObjects('space-auth')).toHaveLength(3)
      expect(state.findInbox(op.operationId)?.state).toBe('REJECTED')
      expect(state.getCoverage('space-auth').applied.ARTICLE_STATE?.['member-actor'] ?? 0).toBe(0)
      expect(state.findPeer('space-auth', 'member')?.status).toBe('REVOKED')
    } finally { db.close() }
  })

  it('promotes checkpoint-covered effects to stable and forbids later revoke from crossing them', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const apply = new SyncApplyCoordinator(runtime, state, { apply: () => {}, rollbackField: () => {} })
    const auth = new DesktopAuthLedgerService(runtime, state, apply)
    state.registerPeer({ syncSpaceId: 'space-stable', deviceId: 'owner', publicKeySpkiBase64: keys.publicKeySpkiBase64('owner'), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    const root = makeAuth(keys, { syncSpaceId: 'space-stable', authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: 'owner', ownerDeviceId: 'owner', payload: {} })
    const grant = makeAuth(keys, { syncSpaceId: 'space-stable', authEpoch: 0, objectType: 'MEMBER_GRANT', authorDeviceId: 'owner', ownerDeviceId: 'owner', targetDeviceId: 'member', payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64('member') } })
    try {
      auth.append('space-stable', [root, grant])
      const wire = makeOperation(keys, { deviceId: 'member', actor: 'member-actor', sequence: 1, authEpoch: 0, authGrantId: grant.authObjectId, syncSpaceId: 'space-stable' })
      const op = operationRecordFromWire(wire, 1)
      runtime.insertOperationIgnore(op)
      state.insertInbox(op, JSON.stringify(op), 1)
      state.markApplied(op.operationId, 2)
      const checkpoint = makeAuth(keys, {
        syncSpaceId: 'space-stable', authEpoch: 0, authSequence: 2,
        objectType: 'AUTH_STABILITY_CHECKPOINT', authorDeviceId: 'owner', ownerDeviceId: 'owner',
        payload: { acceptedPrefixByActorLane: { ARTICLE_STATE: { 'member-actor': 1 } } }
      })
      auth.append('space-stable', [checkpoint])
      expect(state.findInbox(op.operationId)).toMatchObject({
        authorizationState: 'STABLE_AUTHORIZED',
        stabilizedByAuthObjectId: checkpoint.authObjectId
      })
      const revoke = makeAuth(keys, {
        syncSpaceId: 'space-stable', authEpoch: 0, authSequence: 3,
        objectType: 'MEMBER_REVOKE', authorDeviceId: 'owner', ownerDeviceId: 'owner', targetDeviceId: 'member',
        revokeCutoffByActorLane: { ARTICLE_STATE: { 'member-actor': 0 } }, payload: {}
      })
      expect(() => auth.append('space-stable', [revoke])).toThrow(/AuthStabilityCheckpoint/)
      expect(state.findInbox(op.operationId)?.state).toBe('APPLIED')
    } finally { db.close() }
  })

  it('accepts an owner transfer only with target acceptance and starts a new ordered epoch', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const auth = new DesktopAuthLedgerService(runtime, state)
    const owner = 'owner-transfer-client'
    const next = 'next-owner-client'
    state.registerPeer({ syncSpaceId: 'space-transfer-client', deviceId: owner, publicKeySpkiBase64: keys.publicKeySpkiBase64(owner), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    state.registerPeer({ syncSpaceId: 'space-transfer-client', deviceId: next, publicKeySpkiBase64: keys.publicKeySpkiBase64(next), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    const root = makeAuth(keys, { syncSpaceId: 'space-transfer-client', authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: owner, ownerDeviceId: owner, payload: {} })
    auth.append('space-transfer-client', [root])
    const cut = {}
    const acceptance = keys.signBase64(next, ownerRecoverySigningMaterial('space-transfer-client', 1, next, cut)
      .replace('ORIGREAD_OWNER_RECOVERY_PROOF_V1', 'ORIGREAD_OWNER_TRANSFER_ACCEPTANCE_V1'))
    const transfer = makeAuth(keys, {
      syncSpaceId: 'space-transfer-client', authEpoch: 1, authSequence: 0,
      objectType: 'OWNER_TRANSFER', authorDeviceId: owner, ownerDeviceId: next, targetDeviceId: next,
      previousEpochFinalAcceptedPrefixByActorLane: cut,
      payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64(next), ownerAcceptanceSignature: acceptance }
    })
    try {
      auth.append('space-transfer-client', [transfer])
      expect(runtime.listAuthObjects('space-transfer-client').map((it) => [it.authEpoch, it.authSequence]))
        .toEqual([[0, 0], [1, 0]])
      expect(runtime.findActiveGrant('space-transfer-client', next)).toMatchObject({ authEpoch: 1, isOwner: true })
    } finally { db.close() }
  })

  it('accepts OWNER_RECOVERY only with a SpaceRoot recovery proof', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const auth = new DesktopAuthLedgerService(runtime, state)
    const owner = 'owner-recovery-client'
    const recoveryOwner = 'recovery-owner-client'
    state.registerPeer({ syncSpaceId: 'space-recovery-client', deviceId: owner, publicKeySpkiBase64: keys.publicKeySpkiBase64(owner), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    state.registerPeer({ syncSpaceId: 'space-recovery-client', deviceId: recoveryOwner, publicKeySpkiBase64: keys.publicKeySpkiBase64(recoveryOwner), status: 'ACTIVE', authEpoch: 0, updatedAt: 0 })
    const root = makeAuth(keys, { syncSpaceId: 'space-recovery-client', authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: owner, ownerDeviceId: owner, payload: {} })
    const grant = makeAuth(keys, {
      syncSpaceId: 'space-recovery-client', authEpoch: 0, authSequence: 1,
      objectType: 'MEMBER_GRANT', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: recoveryOwner,
      payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64(recoveryOwner) }
    })
    auth.append('space-recovery-client', [root, grant])
    const cut = {}
    const proof = keys.signBase64(owner, ownerRecoverySigningMaterial('space-recovery-client', 1, recoveryOwner, cut))
    const recovery = makeAuth(keys, {
      syncSpaceId: 'space-recovery-client', authEpoch: 1, authSequence: 0,
      objectType: 'OWNER_RECOVERY', authorDeviceId: recoveryOwner, ownerDeviceId: recoveryOwner, targetDeviceId: recoveryOwner,
      previousEpochFinalAcceptedPrefixByActorLane: cut,
      payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64(recoveryOwner), recoveryProof: proof }
    })
    try {
      auth.append('space-recovery-client', [recovery])
      expect(runtime.findActiveGrant('space-recovery-client', recoveryOwner)).toMatchObject({ authEpoch: 1, isOwner: true })
      const forged = { ...recovery, authObjectId: recovery.authObjectId + '-forged' }
      expect(() => auth.append('space-recovery-client', [forged])).toThrow()
    } finally { db.close() }
  })

  it('persists AUTH objects, applies a forward revoke cutoff, and never relays rejected tail operations', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    try {
      const owner = 'device-owner'
      const member = 'device-member'
      server.registerMember({
        syncSpaceId: 'space-auth', deviceId: owner, publicKeySpkiBase64: keys.publicKeySpkiBase64(owner), status: 'ACTIVE', authEpoch: 0
      })
      server.registerMember({
        syncSpaceId: 'space-auth', deviceId: member, publicKeySpkiBase64: keys.publicKeySpkiBase64(member), status: 'ACTIVE', authEpoch: 0
      })

      server.appendAuthObjects('space-auth', [makeAuth(keys, {
        syncSpaceId: 'space-auth',
        authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: owner, ownerDeviceId: owner,
        payload: { kind: 'space-root' }
      })])
      const grant = makeAuth(keys, {
        syncSpaceId: 'space-auth',
        authEpoch: 0, objectType: 'MEMBER_GRANT', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: member,
        payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64(member) }
      })
      server.appendAuthObjects('space-auth', [grant])

      const beforeRevoke = makeOperation(keys, { deviceId: member, actor: 'member-actor', sequence: 1, authEpoch: 0, authGrantId: grant.authObjectId })
      expect(server.putOperations('space-auth', [beforeRevoke]).acceptedOperationIds).toEqual([beforeRevoke.operationId])

      const revoke = makeAuth(keys, {
        syncSpaceId: 'space-auth',
        authEpoch: 0, objectType: 'MEMBER_REVOKE', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: member,
        revokeCutoffByActorLane: { ARTICLE_STATE: { 'member-actor': 1 } }, payload: { reason: 'device lost' }
      })
      server.appendAuthObjects('space-auth', [revoke])
      const rejectedTail = makeOperation(keys, { deviceId: member, actor: 'member-actor', sequence: 2, authEpoch: 0, authGrantId: grant.authObjectId })
      const result = server.putOperations('space-auth', [rejectedTail])
      expect(result.acceptedOperationIds).toEqual([])
      expect(result.rejected[0]).toMatchObject({ code: 'AUTH_REVOKED', operationId: rejectedTail.operationId })
      expect(result.rejected[0]?.rejectionDigest).toBeTruthy()
      const pulledOps = server.requestOperations('space-auth', [{ actorIncarnationId: 'member-actor', replicationLaneId: 'ARTICLE_STATE', fromSequence: 1, toSequence: 2 }]).operations
      expect(pulledOps).toHaveLength(1)
      expect(pulledOps[0]?.operationId).toBe(beforeRevoke.operationId)
      expect(server.authLedger('space-auth').objects.map((object) => object.objectType)).toEqual([
        'SPACE_ROOT', 'MEMBER_GRANT', 'MEMBER_REVOKE'
      ])
      const regrant = makeAuth(keys, { syncSpaceId: 'space-auth', authEpoch: 0, authSequence: 3, objectType: 'MEMBER_GRANT', authorDeviceId: owner, ownerDeviceId: owner, targetDeviceId: member, payload: { publicKeySpkiBase64: keys.publicKeySpkiBase64(member) } })
      server.appendAuthObjects('space-auth', [regrant])
      const renewed = makeOperation(keys, { deviceId: member, actor: 'new-actor', sequence: 1, authEpoch: 0, authGrantId: regrant.authObjectId })
      expect(server.putOperations('space-auth', [renewed]).acceptedOperationIds).toEqual([renewed.operationId])
      const oldGrant = makeOperation(keys, { deviceId: member, actor: 'old-grant-actor', sequence: 1, authEpoch: 0, authGrantId: grant.authObjectId })
      expect(server.putOperations('space-auth', [oldGrant]).rejected[0]?.code).toBe('AUTH_REVOKED')
    } finally {
      server.close()
    }
  })

  it('requires the previous accepted cut for an OWNER_TRANSFER epoch', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    try {
      const owner = 'device-owner'
      const nextOwner = 'device-next-owner'
      server.registerMember({ syncSpaceId: 'space-transfer', deviceId: owner, publicKeySpkiBase64: keys.publicKeySpkiBase64(owner), status: 'ACTIVE', authEpoch: 0 })
      server.registerMember({ syncSpaceId: 'space-transfer', deviceId: nextOwner, publicKeySpkiBase64: keys.publicKeySpkiBase64(nextOwner), status: 'ACTIVE', authEpoch: 0 })
      server.appendAuthObjects('space-transfer', [makeAuth(keys, {
        syncSpaceId: 'space-transfer',
        authEpoch: 0, objectType: 'SPACE_ROOT', authorDeviceId: owner, ownerDeviceId: owner, payload: { kind: 'space-root' }
      })])
      const invalid = makeAuth(keys, {
        syncSpaceId: 'space-transfer',
        authEpoch: 1, objectType: 'OWNER_TRANSFER', authorDeviceId: owner, ownerDeviceId: nextOwner, targetDeviceId: nextOwner,
        previousEpochFinalAcceptedPrefixByActorLane: { ARTICLE_STATE: { actor: 1 } }, payload: { reason: 'transfer' }
      })
      expect(() => server.appendAuthObjects('space-transfer', [invalid])).toThrow(/accepted coverage cut/i)
    } finally {
      server.close()
    }
  })
})

function makeAuth(
  keys: DesktopSyncDeviceSigningKeyStore,
  input: {
    syncSpaceId: string
    authEpoch: number
    authSequence?: number
    objectType: SyncAuthProtocolObject['objectType']
    authorDeviceId: string
    ownerDeviceId: string
    targetDeviceId?: string
    previousEpochFinalAcceptedPrefixByActorLane?: Record<string, Record<string, number>>
    revokeCutoffByActorLane?: Record<string, Record<string, number>>
    payload: Record<string, unknown>
  },
): SyncAuthProtocolObject {
  const payloadJson = canonicalJson(JSON.stringify(input.objectType === 'SPACE_ROOT'
    ? {
        ...input.payload,
        ownerPublicKeySpkiBase64: keys.publicKeySpkiBase64(input.authorDeviceId),
        spaceRootPublicKey: keys.publicKeySpkiBase64(input.authorDeviceId)
      }
    : input.payload))
  const base: SyncAuthProtocolObject = {
    protocolVersion: 1,
    authObjectId: authObjectId(input.syncSpaceId, input.authEpoch, input.objectType, input.authorDeviceId, sha256Hex(payloadJson), input.authSequence ?? (input.objectType === 'MEMBER_GRANT' ? 1 : input.objectType === 'MEMBER_REVOKE' ? 2 : 0)),
    syncSpaceId: input.syncSpaceId,
    authEpoch: input.authEpoch,
    authSequence: input.authSequence ?? (input.objectType === 'MEMBER_GRANT' ? 1 : input.objectType === 'MEMBER_REVOKE' ? 2 : 0),
    objectType: input.objectType,
    authorDeviceId: input.authorDeviceId,
    ownerDeviceId: input.ownerDeviceId,
    targetDeviceId: input.targetDeviceId ?? null,
    previousEpochFinalAcceptedPrefixByActorLane: input.previousEpochFinalAcceptedPrefixByActorLane ?? {},
    revokeCutoffByActorLane: input.revokeCutoffByActorLane ?? null,
    payloadJson,
    payloadHash: sha256Hex(payloadJson),
    signingDigest: '',
    authorSignature: '',
  }
  const signingDigest = authSigningDigest(base)
  return {
    ...base,
    signingDigest,
    authorSignature: keys.signBase64(input.authorDeviceId, authSigningMaterial({ ...base, signingDigest })),
    syncSpaceId: input.syncSpaceId,
  }
}

function makeOperation(
  keys: DesktopSyncDeviceSigningKeyStore,
  input: { deviceId: string; actor: string; sequence: number; authEpoch: number; authGrantId?: string | null; syncSpaceId?: string },
): SyncOperationEnvelope {
  const syncSpaceId = input.syncSpaceId ?? 'space-auth'
  const payloadJson = canonicalJson(JSON.stringify({ field: 'isStarred', value: true, sequence: input.sequence }))
  const unsigned: SyncOperationRecord = {
    operationId: operationId(syncSpaceId, input.actor, 'ARTICLE_STATE', input.sequence),
    syncSpaceId, authorDeviceId: input.deviceId, actorIncarnationId: input.actor,
    replicationLaneId: 'ARTICLE_STATE', sequence: input.sequence, logicalClock: input.sequence,
    causalContextJson: '{"lanes":[],"schemaVersion":1}', dependencyDotsJson: '[]',
    entityType: 'article', entitySyncId: 'article-1', entityGeneration: 0, operationType: 'FIELD_SET',
    payloadSchemaVersion: 1, payloadJson, schemaVersion: 1, authGrantId: input.authGrantId ?? null, authEpoch: input.authEpoch,
    createdWallClock: input.sequence, payloadHash: sha256Hex(payloadJson), signingDigest: '', authorSignature: null,
    buildStatus: 'AWAITING_SIGNATURE', createdAt: input.sequence, updatedAt: input.sequence,
  }
  const withDigest = { ...unsigned, signingDigest: operationSigningDigest(unsigned) }
  return {
    // 正式 wire 不携带本地数据库时间与构建状态，严格字段校验不能靠夹带元数据绕过。
    ...operationEnvelopeFromRecord({ ...withDigest, buildStatus: 'SIGNED',
      authorSignature: keys.signBase64(input.deviceId, operationSigningMaterial(withDigest)) }),
    authorPublicKeySpkiBase64: keys.publicKeySpkiBase64(input.deviceId),
  }
}
