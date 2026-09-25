import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { MemorySecretStore } from '../security/secret-store'
import { DesktopOperationBuilder } from './sync-operation-builder'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopSyncOperationSigner } from './sync-operation-signer'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { SyncApplyCoordinator } from './sync-apply-coordinator'
import { SyncMemoryHub } from './sync-memory-session'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncSessionCoordinator } from './sync-session-coordinator'
import { SyncStateRepository } from './sync-state-repository'
import { SyncIdentityRepository } from './sync-identity-repository'
import { toSyncOperationEnvelope } from '../../shared/sync-protocol'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import { SyncLocalLanePolicy } from './sync-local-lane-policy'

function localOperation() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database)
  return database
}

function bootstrapOwnerAuth(
  runtime: SyncRuntimeRepository,
  state: SyncStateRepository,
  keys: DesktopSyncDeviceSigningKeyStore,
  syncSpaceId: string,
  now = 1
) {
  const deviceId = runtime.findDeviceIdentity()?.deviceId
  if (!deviceId) throw new Error('Test device identity is missing')
  const publicKey = keys.publicKeySpkiBase64(deviceId)
  state.registerPeer({
    syncSpaceId,
    deviceId,
    publicKeySpkiBase64: publicKey,
    status: 'ACTIVE',
    authEpoch: 0,
    updatedAt: now
  })
  const root = new DesktopSyncOperationSigner(runtime, keys).signAuth({
    protocolVersion: 1,
    authObjectId: 'pending',
    syncSpaceId,
    authEpoch: 0,
    authSequence: 0,
    objectType: 'SPACE_ROOT',
    authorDeviceId: deviceId,
    ownerDeviceId: deviceId,
    targetDeviceId: null,
    previousEpochFinalAcceptedPrefixByActorLane: {},
    revokeCutoffByActorLane: null,
    payloadJson: JSON.stringify({
      ownerPublicKeySpkiBase64: publicKey,
      publicKeySpkiBase64: publicKey,
      spaceRootPublicKey: publicKey
    }),
    payloadHash: 'pending',
    signingDigest: 'pending',
    authorSignature: 'pending'
  })
  new DesktopAuthLedgerService(runtime, state).append(syncSpaceId, [root], now)
  return root
}

function trustAuthHistory(
  targetRuntime: SyncRuntimeRepository,
  targetState: SyncStateRepository,
  sourceRuntime: SyncRuntimeRepository,
  sourceKeys: DesktopSyncDeviceSigningKeyStore,
  syncSpaceId: string,
  now = 1
): void {
  const history = sourceRuntime.listAuthObjects(syncSpaceId)
  const root = history.find((object) => object.objectType === 'SPACE_ROOT')
  if (!root) throw new Error('Test source AUTH ledger has no SPACE_ROOT')
  targetState.registerPeer({
    syncSpaceId,
    deviceId: root.authorDeviceId,
    publicKeySpkiBase64: sourceKeys.publicKeySpkiBase64(root.authorDeviceId),
    status: 'ACTIVE',
    authEpoch: root.authEpoch,
    updatedAt: now
  })
  new DesktopAuthLedgerService(targetRuntime, targetState).append(syncSpaceId, history, now)
}

function grantMemberAuth(
  ownerRuntime: SyncRuntimeRepository,
  ownerState: SyncStateRepository,
  ownerKeys: DesktopSyncDeviceSigningKeyStore,
  syncSpaceId: string,
  memberDeviceId: string,
  memberPublicKeySpkiBase64: string,
  now = 1
): void {
  const ownerDeviceId = ownerRuntime.findDeviceIdentity()?.deviceId
  if (!ownerDeviceId) throw new Error('Test owner device identity is missing')
  const head = ownerRuntime.listAuthObjects(syncSpaceId).at(-1)
  if (!head) throw new Error('Test owner AUTH ledger is empty')
  const grant = new DesktopSyncOperationSigner(ownerRuntime, ownerKeys).signAuth({
    protocolVersion: 1,
    authObjectId: 'pending',
    syncSpaceId,
    authEpoch: head.authEpoch,
    authSequence: (head.authSequence ?? 0) + 1,
    objectType: 'MEMBER_GRANT',
    authorDeviceId: ownerDeviceId,
    ownerDeviceId,
    targetDeviceId: memberDeviceId,
    previousEpochFinalAcceptedPrefixByActorLane: {},
    revokeCutoffByActorLane: null,
    payloadJson: JSON.stringify({ publicKeySpkiBase64: memberPublicKeySpkiBase64 }),
    payloadHash: 'pending',
    signingDigest: 'pending',
    authorSignature: 'pending'
  })
  new DesktopAuthLedgerService(ownerRuntime, ownerState).append(syncSpaceId, [grant], now)
}

describe('R10/R11/R12 anti-entropy session', () => {
  it('activates a durable staged baseline in a new session after disconnect', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const state = new SyncStateRepository(db)
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const runtimeCoordinator = new DesktopSyncRuntimeCoordinator(runtime, new SyncIdentityRepository(db),
        new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'resume'))
      runtimeCoordinator.prepareSpace(1, 'space', 1)
      runtime.upsertBinding({ ...runtime.findBinding(1)!, lifecycleState: 'STAGING' })
      db.prepare(`INSERT INTO sync_recovery_capsule(capsule_id,sync_space_id,target_snapshot_bundle_id,
        coverage_json,operation_ids_json,pending_outbox_ids_json,recovery_state_json,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run('snapshot-install:space', 'space', 'bundle', '{}', '[]', '[]',
          JSON.stringify({ rootHash: 'root', installedLanes: ['CORE_META', 'AUTH'] }), 'SNAPSHOT_INSTALL_READY', 1)
      const activateAfterTail = vi.fn()
      const coordinator = new SyncSessionCoordinator(runtime, state, new DesktopOperationBuilder(runtime),
        new DesktopSyncOperationSigner(runtime, keys), new SyncApplyCoordinator(runtime, state),
        { activateAfterTail } as any)
      await coordinator.run('space', new SyncMemoryHub().session('space', 'device'), { localAccountId: 1, resolvePeerKey: () => null })
      expect(activateAfterTail).toHaveBeenCalledWith(1, 'bundle', expect.any(Number), [])
    } finally { db.close() }
  })

  it('requests a baseline when only snapshot coverage is available', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const state = new SyncStateRepository(db)
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const endpoint = new SyncMemoryHub().session('space', 'device')
      vi.spyOn(endpoint, 'getRemoteStateVector').mockResolvedValue({
        coverage: { received: {}, applied: {}, retained: {}, snapshot: { ARTICLE_STATE: { remote: 10 } }, stableGc: {} },
        policyByLane: {}, serverCursor: null
      })
      const lookup = vi.spyOn(endpoint, 'getLatestSnapshot').mockRejectedValue(new Error('snapshot lookup reached'))
      const request = vi.spyOn(endpoint, 'requestOperations')
      const coordinator = new SyncSessionCoordinator(runtime, state, new DesktopOperationBuilder(runtime),
        new DesktopSyncOperationSigner(runtime, keys), new SyncApplyCoordinator(runtime, state))
      await expect(coordinator.run('space', endpoint, { localAccountId: 1, resolvePeerKey: () => null })).rejects.toThrow('snapshot lookup reached')
      expect(lookup).toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('exchanges AUTH before building or transmitting any business operation', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const state = new SyncStateRepository(db)
      const builder = new DesktopOperationBuilder(runtime)
      const signer = new DesktopSyncOperationSigner(runtime, new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore()))
      const build = vi.spyOn(builder, 'buildPending')
      const endpoint = new SyncMemoryHub().session('auth-first', 'device')
      const push = vi.spyOn(endpoint, 'pushOperations')
      const session = new Proxy(endpoint, { get(target, prop, receiver) {
        if (prop === 'getAuthLedger') return async () => { throw new Error('AUTH proof unavailable') }
        if (prop === 'pushAuthObjects') return async () => { throw new Error('unexpected push') }
        return Reflect.get(target, prop, receiver)
      } })
      const coordinator = new SyncSessionCoordinator(runtime, state, builder, signer, new SyncApplyCoordinator(runtime, state))
      await expect(coordinator.run('auth-first', session, { resolvePeerKey: () => null })).rejects.toThrow('AUTH proof unavailable')
      expect(build).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('prepares past paused lanes and never transmits their records', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'paused')
      const control = new DesktopSyncRuntimeCoordinator(runtime, new SyncIdentityRepository(db), witness)
      control.prepareSpace(1, 'paused-space', 1)
      const context = control.beginGenesisCapture(1, 'paused-genesis', 2)
      const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
      for (const lane of ['AI_HISTORY', 'ARTICLE_STATE'] as const) {
        runtime.transaction(() => allocator.allocate(context, lane, { entityType: 'article', entitySyncId: 'article', mutationType: 'FIELD_SET', payloadJson: '{"field":"isStarred","value":true}' }, [], 3))
      }
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const device = runtime.findDeviceIdentity()!.deviceId
      const hub = new SyncMemoryHub()
      hub.registerMember('paused-space', device, keys.publicKeySpkiBase64(device))
      const state = new SyncStateRepository(db)
      bootstrapOwnerAuth(runtime, state, keys, 'paused-space', 3)
      new SyncLocalLanePolicy(db).set('paused-space', 'AI_HISTORY', 'PAUSED')
      state.upsertEndpoint({ endpointId: 'shared-endpoint', syncSpaceId: 'other-space', kind: 'SERVER', url: 'http://localhost', displayName: 'Test', enabled: true, createdAt: 1, updatedAt: 1, lastError: null })
      state.saveCursor('shared-endpoint', 'other-space', { serverEpoch: 'old', logOffset: 1, checkpointHash: 'old' })
      expect(state.readCursor('shared-endpoint', 'paused-space')).toBeNull()
      const coordinator = new SyncSessionCoordinator(runtime, state, new DesktopOperationBuilder(runtime), new DesktopSyncOperationSigner(runtime, keys), new SyncApplyCoordinator(runtime, state))
      const result = await coordinator.run('paused-space', hub.session('paused-space', device), { resolvePeerKey: () => null, maxOperations: 1 })
      expect(result.pushedOperationIds).toHaveLength(1)
      expect(runtime.findOperation(result.pushedOperationIds[0]!)?.replicationLaneId).toBe('ARTICLE_STATE')
      expect(runtime.listPendingOutbox('paused-space')).toHaveLength(0)
    } finally { db.close() }
  })

  it('relays one signed operation through the shared endpoint session and applies it once', async () => {
    const sourceDb = localOperation()
    const targetDb = localOperation()
    try {
      const sourceRuntime = new SyncRuntimeRepository(sourceDb)
      const sourceIdentity = new SyncIdentityRepository(sourceDb)
      const sourceWitness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'source')
      const sourceCoordinator = new DesktopSyncRuntimeCoordinator(sourceRuntime, sourceIdentity, sourceWitness)
      const sourceAllocator = new DesktopSyncOutboxAllocator(sourceRuntime, sourceWitness)
      sourceCoordinator.prepareSpace(1, 'space-relay', 1)
      const sourceContext = sourceCoordinator.beginGenesisCapture(1, 'genesis-relay', 2)
      sourceRuntime.transaction(() => sourceAllocator.allocate(sourceContext, 'ARTICLE_STATE', {
        entityType: 'article', entitySyncId: 'article-1', mutationType: 'FIELD_SET',
        payloadJson: JSON.stringify({ field: 'isStarred', value: true })
      }, [], 3))
      const sourceKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const sourceState = new SyncStateRepository(sourceDb)
      bootstrapOwnerAuth(sourceRuntime, sourceState, sourceKeys, 'space-relay', 3)
      const sourceBuilder = new DesktopOperationBuilder(sourceRuntime)
      sourceBuilder.buildPending('space-relay', 10, 4)
      const sourceSigner = new DesktopSyncOperationSigner(sourceRuntime, sourceKeys)
      sourceSigner.signPending('space-relay', 10, 5)
      const sourceOperation = sourceRuntime.listSignedOperations('space-relay')[0]!

      const hub = new SyncMemoryHub()
      hub.registerMember('space-relay', sourceOperation.authorDeviceId, sourceKeys.publicKeySpkiBase64(sourceOperation.authorDeviceId))
      const sourceApply = new SyncApplyCoordinator(sourceRuntime, sourceState)
      const sourceSession = new SyncSessionCoordinator(sourceRuntime, sourceState, sourceBuilder, sourceSigner, sourceApply)
      const sourceResult = await sourceSession.run('space-relay', hub.session('space-relay', sourceOperation.authorDeviceId), {
        resolvePeerKey: () => null, now: 6
      })
      expect(sourceResult.pushedOperationIds).toEqual([sourceOperation.operationId])

      const targetRuntime = new SyncRuntimeRepository(targetDb)
      targetRuntime.replaceDeviceIdentity({ deviceId: 'target-device', witnessId: 'target-witness', createdAt: 1, updatedAt: 1 })
      const targetState = new SyncStateRepository(targetDb)
      trustAuthHistory(targetRuntime, targetState, sourceRuntime, sourceKeys, 'space-relay', 7)
      const applied: string[] = []
      const targetApply = new SyncApplyCoordinator(targetRuntime, targetState, { apply: (operation) => applied.push(operation.operationId) })
      const targetKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const targetSigner = new DesktopSyncOperationSigner(targetRuntime, targetKeys)
      const targetBuilder = new DesktopOperationBuilder(targetRuntime)
      const targetSession = new SyncSessionCoordinator(targetRuntime, targetState, targetBuilder, targetSigner, targetApply)
      const targetResult = await targetSession.run('space-relay', hub.session('space-relay', 'target-device'), {
        resolvePeerKey: (space, device) => space === 'space-relay' && device === sourceOperation.authorDeviceId
          ? { publicKeySpkiBase64: sourceKeys.publicKeySpkiBase64(device), status: 'ACTIVE', authEpoch: 0 }
          : null,
        now: 7
      })
      expect(targetResult.pulledOperationIds).toEqual([sourceOperation.operationId])
      expect(targetResult.appliedOperationIds).toEqual([sourceOperation.operationId])
      expect(applied).toEqual([sourceOperation.operationId])
      expect(targetState.getCoverage('space-relay').received.ARTICLE_STATE).toMatchObject({ [sourceOperation.actorIncarnationId]: 1 })

      const replay = await targetSession.run('space-relay', hub.session('space-relay', 'target-device'), {
        resolvePeerKey: () => null, now: 8
      })
      expect(replay.pulledOperationIds).toEqual([])
      expect(applied).toHaveLength(1)
    } finally {
      sourceDb.close()
      targetDb.close()
    }
  })

  it('supports pagination loop for large operation logs exceeding single batch limit', async () => {
    const sourceDb = localOperation()
    const targetDb = localOperation()
    try {
      const sourceRuntime = new SyncRuntimeRepository(sourceDb)
      const sourceIdentity = new SyncIdentityRepository(sourceDb)
      const sourceWitness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'source-large')
      const sourceCoordinator = new DesktopSyncRuntimeCoordinator(sourceRuntime, sourceIdentity, sourceWitness)
      const sourceAllocator = new DesktopSyncOutboxAllocator(sourceRuntime, sourceWitness)
      sourceCoordinator.prepareSpace(1, 'space-large', 1)
      const sourceContext = sourceCoordinator.beginGenesisCapture(1, 'genesis-large', 2)

      // 连续生成 25 条操作
      const totalOps = 25
      for (let i = 1; i <= totalOps; i++) {
        sourceRuntime.transaction(() => sourceAllocator.allocate(sourceContext, 'ARTICLE_STATE', {
          entityType: 'article', entitySyncId: `article-${i}`, mutationType: 'FIELD_SET',
          payloadJson: JSON.stringify({ field: 'isStarred', value: i % 2 === 0 })
        }, [], 10 + i))
      }

      const sourceKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const sourceState = new SyncStateRepository(sourceDb)
      bootstrapOwnerAuth(sourceRuntime, sourceState, sourceKeys, 'space-large', 40)
      const sourceBuilder = new DesktopOperationBuilder(sourceRuntime)
      sourceBuilder.buildPending('space-large', 100, 50)
      const sourceSigner = new DesktopSyncOperationSigner(sourceRuntime, sourceKeys)
      sourceSigner.signPending('space-large', 100, 60)

      const signedOps = sourceRuntime.listSignedOperations('space-large', 100)
      expect(signedOps).toHaveLength(totalOps)

      const hub = new SyncMemoryHub()
      const authorDeviceId = signedOps[0]!.authorDeviceId
      hub.registerMember('space-large', authorDeviceId, sourceKeys.publicKeySpkiBase64(authorDeviceId))

      const sourceApply = new SyncApplyCoordinator(sourceRuntime, sourceState)
      const sourceSession = new SyncSessionCoordinator(sourceRuntime, sourceState, sourceBuilder, sourceSigner, sourceApply)

      // 使用 maxOperations = 8 运行，要求在单次 run 中自动循环 4 个批次完成全部 25 条推送
      const sourceResult = await sourceSession.run('space-large', hub.session('space-large', authorDeviceId), {
        resolvePeerKey: () => null,
        maxOperations: 8,
        now: 70
      })
      expect(sourceResult.pushedOperationIds).toHaveLength(totalOps)

      // Target 节点使用 maxOperations = 8 接收，要求在单次 run 中自动循环拉取并应用全部 25 条操作
      const targetRuntime = new SyncRuntimeRepository(targetDb)
      targetRuntime.replaceDeviceIdentity({ deviceId: 'target-large-device', witnessId: 'target-witness', createdAt: 1, updatedAt: 1 })
      const targetState = new SyncStateRepository(targetDb)
      trustAuthHistory(targetRuntime, targetState, sourceRuntime, sourceKeys, 'space-large', 80)
      const appliedOps: string[] = []
      const targetApply = new SyncApplyCoordinator(targetRuntime, targetState, { apply: (op) => appliedOps.push(op.operationId) })
      const targetKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const targetSigner = new DesktopSyncOperationSigner(targetRuntime, targetKeys)
      const targetBuilder = new DesktopOperationBuilder(targetRuntime)
      const targetSession = new SyncSessionCoordinator(targetRuntime, targetState, targetBuilder, targetSigner, targetApply)

      const targetResult = await targetSession.run('space-large', hub.session('space-large', 'target-large-device'), {
        resolvePeerKey: (space, device) => space === 'space-large' && device === authorDeviceId
          ? { publicKeySpkiBase64: sourceKeys.publicKeySpkiBase64(device), status: 'ACTIVE', authEpoch: 0 }
          : null,
        maxOperations: 8,
        now: 80
      })

      expect(targetResult.pulledOperationIds).toHaveLength(totalOps)
      expect(targetResult.appliedOperationIds).toHaveLength(totalOps)
      expect(appliedOps).toHaveLength(totalOps)
      expect(targetState.getCoverage('space-large').received.ARTICLE_STATE).toMatchObject({
        [signedOps[0]!.actorIncarnationId]: totalOps
      })

      // 验证断点续传与防假截断：再次运行不会拉取任何重复操作
      const replay = await targetSession.run('space-large', hub.session('space-large', 'target-large-device'), {
        resolvePeerKey: () => null,
        maxOperations: 8,
        now: 90
      })
      expect(replay.pulledOperationIds).toHaveLength(0)
    } finally {
      sourceDb.close()
      targetDb.close()
    }
  })

  it('recovers from SERVER_HISTORY_REWIND by resetting cursor and re-pushing local operations', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const identity = new SyncIdentityRepository(db)
      const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'rewind-witness')
      const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
      const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
      coordinator.prepareSpace(1, 'space-rewind', 1)
      const context = coordinator.beginGenesisCapture(1, 'genesis-rewind', 2)

      // Seven operations require four batches at the negotiated test limit.
      for (let i = 1; i <= 7; i++) {
        runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', {
          entityType: 'article', entitySyncId: `article-${i}`, mutationType: 'FIELD_SET',
          payloadJson: JSON.stringify({ field: 'isStarred', value: true })
        }, [], 10 + i))
      }

      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const state = new SyncStateRepository(db)
      bootstrapOwnerAuth(runtime, state, keys, 'space-rewind', 20)
      const builder = new DesktopOperationBuilder(runtime)
      builder.buildPending('space-rewind', 10, 30)
      const signer = new DesktopSyncOperationSigner(runtime, keys)
      signer.signPending('space-rewind', 10, 40)
      coordinator.markActive(1, 41)

      const appliedOps: string[] = []
      const apply = new SyncApplyCoordinator(runtime, state, {
        apply: (op) => appliedOps.push(op.operationId),
        canApplyProvisionally: () => true
      })
      const sessionCoordinator = new SyncSessionCoordinator(runtime, state, builder, signer, apply)

      const signedOps = runtime.listSignedOperations('space-rewind', 10)
      const authorDeviceId = signedOps[0]!.authorDeviceId

      const hub = new SyncMemoryHub()
      hub.registerMember('space-rewind', authorDeviceId, keys.publicKeySpkiBase64(authorDeviceId))

      // 使用真实的 peer 数据库生成合法签名的远端操作
      const peerDb = localOperation()
      const peerKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      let peerAuthorDeviceId = ''
      try {
        const peerRuntime = new SyncRuntimeRepository(peerDb)
        const peerIdentity = new SyncIdentityRepository(peerDb)
        const peerWitness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'peer-witness')
        const peerCoordinator = new DesktopSyncRuntimeCoordinator(peerRuntime, peerIdentity, peerWitness)
        const peerAllocator = new DesktopSyncOutboxAllocator(peerRuntime, peerWitness)
        peerCoordinator.prepareSpace(1, 'space-rewind', 1)
        const peerState = new SyncStateRepository(peerDb)
        const peerDeviceId = peerRuntime.findDeviceIdentity()!.deviceId
        grantMemberAuth(
          runtime,
          state,
          keys,
          'space-rewind',
          peerDeviceId,
          peerKeys.publicKeySpkiBase64(peerDeviceId),
          21
        )
        trustAuthHistory(peerRuntime, peerState, runtime, keys, 'space-rewind', 2)
        const peerContext = peerCoordinator.beginGenesisCapture(1, 'genesis-peer', 2)
        peerRuntime.transaction(() => peerAllocator.allocate(peerContext, 'ARTICLE_STATE', {
          entityType: 'article', entitySyncId: 'article-peer-1', mutationType: 'FIELD_SET',
          payloadJson: JSON.stringify({ field: 'isStarred', value: true })
        }, [], 11))
        const peerBuilder = new DesktopOperationBuilder(peerRuntime)
        peerBuilder.buildPending('space-rewind', 10, 12)
        const peerSigner = new DesktopSyncOperationSigner(peerRuntime, peerKeys)
        peerSigner.signPending('space-rewind', 10, 13)
        const peerOp = peerRuntime.listSignedOperations('space-rewind', 10)[0]!
        peerAuthorDeviceId = peerOp.authorDeviceId
        hub.registerMember('space-rewind', peerAuthorDeviceId, peerKeys.publicKeySpkiBase64(peerAuthorDeviceId))
        const peerSession = hub.session('space-rewind', peerAuthorDeviceId)
        const pushRes = await peerSession.pushOperations([toSyncOperationEnvelope(peerOp)])
        expect(pushRes.acceptedOperationIds).toHaveLength(1)
      } finally {
        peerDb.close()
      }

      const realSession = hub.session('space-rewind', authorDeviceId)
      let rewindInjected = false

      // 模拟远程 Server 发生历史倒退，首次拉取操作时抛出 SERVER_HISTORY_REWIND
      const simulatedSession = new Proxy(realSession, {
        get(target, prop, receiver) {
          if (prop === 'pushOperations') {
            return async (...args: Parameters<typeof target.pushOperations>) => {
              const receipt = await target.pushOperations(...args)
              return rewindInjected ? { ...receipt, coverage: { ...receipt.coverage, received: {} } } : receipt
            }
          }
          if (prop === 'getRemoteStateVector') {
            return async () => {
              const vector = await target.getRemoteStateVector()
              return rewindInjected ? { ...vector, coverage: { ...vector.coverage, received: {} } } : vector
            }
          }
          if (prop === 'requestOperations') {
            return async (...args: unknown[]) => {
              if (!rewindInjected) {
                rewindInjected = true
                throw new Error('Sync endpoint 409: {"code":"SERVER_HISTORY_REWIND","message":"rewound to snapshot"}')
              }
              return (target.requestOperations as Function).apply(target, args)
            }
          }
          return Reflect.get(target, prop, receiver)
        }
      })

      const result = await sessionCoordinator.run('space-rewind', simulatedSession, {
        resolvePeerKey: (space, device) => space === 'space-rewind' && device === peerAuthorDeviceId
          ? { publicKeySpkiBase64: peerKeys.publicKeySpkiBase64(device), status: 'ACTIVE', authEpoch: 0 }
          : null,
        maxOperations: 2,
        now: 50
      })

      // 验证诊断信息记录了 CURSOR_REWIND
      expect(result.diagnostics.some((d) => d.code === 'CURSOR_REWIND')).toBe(true)
      // Every local operation must be acknowledged again after the history reset.
      expect(result.pushedOperationIds).toHaveLength(14)
      for (const op of signedOps) expect(result.pushedOperationIds.filter((id) => id === op.operationId)).toHaveLength(2)
      // 验证成功拉取并应用了 peer 操作
      expect(result.pulledOperationIds).toHaveLength(1)
      expect(result.appliedOperationIds).toHaveLength(1)
      expect(appliedOps).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('refuses an unauthenticated baseline without overwriting local state', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const identity = new SyncIdentityRepository(db)
      const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'test-witness-baseline')
      const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
      coordinator.prepareSpace(1, 'space-baseline', 1)

      const builder = new DesktopOperationBuilder(runtime)
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const signer = new DesktopSyncOperationSigner(runtime, keys)
      const state = new SyncStateRepository(db)
      const appliedOps: string[] = []
      const apply = new SyncApplyCoordinator(runtime, state, { apply: (op) => appliedOps.push(op.operationId) })

      let snapshotInstalled = false
      let snapshotActivated = false
      const mockSnapshotInstaller: any = {
        install: (localAccountId: number, bundle: any) => {
          expect(localAccountId).toBe(1)
          snapshotInstalled = true
          state.rebaseSnapshotCoverage(bundle.syncSpaceId, bundle.coverage, 100)
          return { snapshotBundleId: bundle.snapshotBundleId, syncSpaceId: bundle.syncSpaceId, materializedEntities: 1, rebasedLanes: [] }
        },
        activateAfterTail: (localAccountId: number, snapshotBundleId: string) => {
          expect(localAccountId).toBe(1)
          expect(snapshotBundleId).toBe('snap-heal-1')
          snapshotActivated = true
        }
      }

      const sessionCoordinator = new SyncSessionCoordinator(runtime, state, builder, signer, apply, mockSnapshotInstaller)

      let baselineRequiredInjected = false
      const mockSession: any = {
        negotiateProtocolAndCapabilities: async () => ({
          protocolVersion: 1, syncSpaceId: 'space-baseline', localDeviceId: 'dev-1', remoteDeviceId: 'server-1',
          capabilities: { protocolVersions: [1], replicationLanes: ['CORE_META', 'ARTICLE_STATE', 'AUTH'], snapshotClasses: ['GC_BASELINE'], blobTransfer: true, maxOperationBatch: 500, maxBlobChunkBytes: 1024, supportsRangeResume: true }
        }),
        getRemoteStateVector: async () => ({
          coverage: { received: {}, applied: {}, retained: { ARTICLE_STATE: { 'act-remote': 5 } }, snapshot: {}, stableGc: {} },
          policyByLane: { ARTICLE_STATE: 'ENABLED' },
          serverCursor: { serverEpoch: 'epoch-1', logOffset: 5, checkpointHash: 'hash-5' }
        }),
        requestOperations: async () => {
          if (!baselineRequiredInjected) {
            baselineRequiredInjected = true
            throw new Error('[BASELINE_REQUIRED] Server log truncated, baseline snapshot required')
          }
          return { operations: [], nextCursor: null, coverage: { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} }, serverCursor: null }
        },
        pushOperations: async () => ({ acceptedOperationIds: [], duplicateOperationIds: [], rejected: [], coverage: { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} } }),
        getLatestSnapshot: async () => ({
          snapshotBundleId: 'snap-heal-1', syncSpaceId: 'space-baseline', snapshotClass: 'GC_BASELINE',
          capturedAt: 100, rootHash: 'root-1', policyHash: 'pol-1', shards: [
            { replicationLaneId: 'CORE_META', contentHash: 'c1' },
            { replicationLaneId: 'ARTICLE_STATE', contentHash: 'c2' },
            { replicationLaneId: 'AUTH', contentHash: 'c3' }
          ],
          coverage: { ARTICLE_STATE: { 'act-remote': 5 } }
        }),
        acknowledgeReceived: async () => {},
        reportAppliedCoverage: async () => {},
        reportRetainedCoverage: async () => {},
      }

      // 注册 endpoint config 并保存一个旧 cursor
      state.upsertEndpoint({
        endpointId: 'ep-1', syncSpaceId: 'space-baseline', kind: 'SERVER', url: 'http://localhost',
        displayName: 'Test Server', enabled: true, createdAt: 1, updatedAt: 1, lastError: null
      })
      state.saveCursor('ep-1', 'space-baseline', { serverEpoch: 'epoch-0', logOffset: 1, checkpointHash: 'h' }, 10)
      expect(state.readCursor('ep-1')).not.toBeNull()

      const result = await sessionCoordinator.run('space-baseline', mockSession, {
        endpointId: 'ep-1',
        localAccountId: 1,
        resolvePeerKey: () => null,
        now: 100
      })

      expect(result.diagnostics.some((item) => item.code === 'BASELINE_REQUIRED')).toBe(true)
      expect(snapshotInstalled).toBe(true)
      expect(snapshotActivated).toBe(true)
      // 验证清空了失效游标
      expect(state.readCursor('ep-1')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('aborts session and refuses to reverse push when BASELINE_REQUIRED snapshot install fails', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const identity = new SyncIdentityRepository(db)
      const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'test-witness-fail')
      const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
      coordinator.prepareSpace(1, 'space-fail', 1)

      const builder = new DesktopOperationBuilder(runtime)
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const signer = new DesktopSyncOperationSigner(runtime, keys)
      const state = new SyncStateRepository(db)
      const apply = new SyncApplyCoordinator(runtime, state, { apply: () => {} })

      const failingSnapshotInstaller: any = {
        install: () => {
          throw new Error('Corrupted snapshot during recovery')
        }
      }

      const sessionCoordinator = new SyncSessionCoordinator(runtime, state, builder, signer, apply, failingSnapshotInstaller)

      let reversePushed = false
      const mockSession: any = {
        negotiateProtocolAndCapabilities: async () => ({
          protocolVersion: 1, syncSpaceId: 'space-fail', localDeviceId: 'dev-1', remoteDeviceId: 'server-1',
          capabilities: { protocolVersions: [1], replicationLanes: ['CORE_META', 'ARTICLE_STATE', 'AUTH'], snapshotClasses: ['GC_BASELINE'], blobTransfer: true, maxOperationBatch: 500, maxBlobChunkBytes: 1024, supportsRangeResume: true }
        }),
        getRemoteStateVector: async () => ({
          coverage: { received: {}, applied: {}, retained: { ARTICLE_STATE: { 'act-remote': 5 } }, snapshot: {}, stableGc: {} },
          policyByLane: { ARTICLE_STATE: 'ENABLED' },
          serverCursor: { serverEpoch: 'epoch-1', logOffset: 5, checkpointHash: 'hash-5' }
        }),
        requestOperations: async () => {
          throw new Error('[BASELINE_REQUIRED] Baseline required')
        },
        pushOperations: async () => {
          reversePushed = true
          return { acceptedOperationIds: [], duplicateOperationIds: [], rejected: [], coverage: { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} } }
        },
        getLatestSnapshot: async () => ({
          snapshotBundleId: 'snap-bad', syncSpaceId: 'space-fail', snapshotClass: 'GC_BASELINE',
          capturedAt: 100, rootHash: 'root-1', policyHash: 'pol-1', shards: [], coverage: {}
        }),
        acknowledgeReceived: async () => {},
        reportAppliedCoverage: async () => {},
        reportRetainedCoverage: async () => {},
      }

      await expect(() => sessionCoordinator.run('space-fail', mockSession, {
        localAccountId: 1,
        resolvePeerKey: () => null,
        now: 100
      })).rejects.toThrow('REBASE_UNSAFE')

      // 验证绝不执行反向补齐推操作
      expect(reversePushed).toBe(false)
    } finally {
      db.close()
    }
  })

  it('drains large pending outbox over multiple batches in single push loop', async () => {
    const db = localOperation()
    try {
      const runtime = new SyncRuntimeRepository(db)
      const identity = new SyncIdentityRepository(db)
      const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'test-witness-drain')
      const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
      const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
      coordinator.prepareSpace(1, 'space-drain', 1)
      const context = coordinator.beginGenesisCapture(1, 'genesis-drain', 2)

      // 本地生成 25 条待构建 Outbox（批次大小限制为 10，需 3 批完全排空）
      for (let i = 1; i <= 25; i++) {
        runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', {
          entityType: 'article', entitySyncId: `art-${i}`, mutationType: 'FIELD_SET',
          payloadJson: JSON.stringify({ field: 'isStarred', value: true })
        }, [], 100 + i))
      }

      const builder = new DesktopOperationBuilder(runtime)
      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const signer = new DesktopSyncOperationSigner(runtime, keys)
      const state = new SyncStateRepository(db)
      bootstrapOwnerAuth(runtime, state, keys, 'space-drain', 150)
      const apply = new SyncApplyCoordinator(runtime, state, { apply: () => {} })
      const sessionCoordinator = new SyncSessionCoordinator(runtime, state, builder, signer, apply)

      let totalPushedOps = 0
      let pushCallCount = 0
      const mockSession: any = {
        negotiateProtocolAndCapabilities: async () => ({
          protocolVersion: 1, syncSpaceId: 'space-drain', localDeviceId: 'dev-1', remoteDeviceId: 'server-1',
          capabilities: { protocolVersions: [1], replicationLanes: ['CORE_META', 'ARTICLE_STATE', 'AUTH'], snapshotClasses: ['GC_BASELINE'], blobTransfer: true, maxOperationBatch: 10, maxBlobChunkBytes: 1024, supportsRangeResume: true }
        }),
        getRemoteStateVector: async () => ({
          coverage: { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} },
          policyByLane: { ARTICLE_STATE: 'ENABLED' },
          serverCursor: null
        }),
        requestOperations: async () => ({ operations: [], nextCursor: null, coverage: { received: {}, applied: {}, retained: {}, snapshot: {}, stableGc: {} }, serverCursor: null }),
        pushOperations: async (envelopes: any[]) => {
          pushCallCount++
          totalPushedOps += envelopes.length
          const opIds = envelopes.map((e) => e.operationId)
          return {
            acceptedOperationIds: opIds,
            duplicateOperationIds: [],
            rejected: [],
            coverage: { received: { ARTICLE_STATE: { [envelopes[0].actorIncarnationId]: envelopes[envelopes.length - 1].sequence } }, applied: {}, retained: {}, snapshot: {}, stableGc: {} }
          }
        },
        acknowledgeReceived: async () => {},
        reportAppliedCoverage: async () => {},
        reportRetainedCoverage: async () => {},
      }

      const result = await sessionCoordinator.run('space-drain', mockSession, {
        maxOperations: 10,
        maxBatches: 5,
        resolvePeerKey: () => null,
        now: 200
      })

      // 验证单次 session 推进了全部 25 条操作（分 3 批：10, 10, 5）
      expect(result.pushedOperationIds).toHaveLength(25)
      expect(totalPushedOps).toBe(25)
      expect(pushCallCount).toBe(3)
    } finally {
      db.close()
    }
  })
})
