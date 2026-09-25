import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { canonicalJson, operationId, operationSigningDigest, sha256Hex } from './sync-operation-canonicalizer'
import { DesktopOperationBuilder, SyncDotCollisionError } from './sync-operation-builder'
import { SyncRuntimeRepository } from './sync-runtime-repository'

describe('SYNC-2 operation builder', () => {
  it('matches the Android canonical fixture', () => {
    const payload = canonicalJson('{"z":1,"a":{"y":2,"x":"汉"}}')
    const causal = canonicalJson(
      '{"lanes":[{"actors":[{"prefix":3,"actorIncarnationId":"actor-A"}],"replicationLaneId":"ARTICLE_STATE"}],"schemaVersion":1}'
    )
    expect(payload).toBe('{"a":{"x":"汉","y":2},"z":1}')
    expect(sha256Hex(payload)).toBe('d73c001609cc6a22a49c7bddb0eb12101330ead01b152535ed3c7e17e2d5f2e1')
    expect(operationId('space-1', 'actor-A', 'ARTICLE_STATE', 4))
      .toBe('op1:c72e27cd6a19a23c0f3e853d363336fe5e7c8caa654f746fd0407c39a847000b')
    expect(operationSigningDigest({
      operationId: 'actor-A:ARTICLE_STATE:4', syncSpaceId: 'space-1', authorDeviceId: 'device-1',
      actorIncarnationId: 'actor-A', replicationLaneId: 'ARTICLE_STATE', sequence: 4, logicalClock: 4,
      causalContextJson: causal, dependencyDotsJson: '[]', entityType: 'article', entitySyncId: 'article-sync-1',
      entityGeneration: 0, operationType: 'FIELD_SET', payloadSchemaVersion: 1, payloadJson: payload,
      schemaVersion: 1, authGrantId: null, authEpoch: null, createdWallClock: 1_700_000_000_000,
      payloadHash: sha256Hex(payload), signingDigest: '', authorSignature: null, buildStatus: 'AWAITING_SIGNATURE',
      createdAt: 1, updatedAt: 1
    })).toBe('91c4ea9088e143a7abfded10022703f19780fff3a8422ef62836be2308be35ae')
  })

  it('builds pending outbox idempotently and rejects a conflicting Dot', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const builder = new DesktopOperationBuilder(runtime, { strictAuth: false })
    try {
      db.prepare('INSERT INTO sync_spaces(sync_space_id,created_at,updated_at) VALUES(?,?,?)').run('space-1', 1, 1)
      runtime.insertActor({
        actorIncarnationId: 'actor-1', syncSpaceId: 'space-1', deviceId: 'device-1',
        status: 'ACTIVE', createdAt: 1, retiredAt: null
      })
      runtime.insertOutbox({
        outboxId: 'actor-1:ARTICLE_STATE:1', syncSpaceId: 'space-1', actorIncarnationId: 'actor-1',
        replicationLaneId: 'ARTICLE_STATE', sequence: 1, entityType: 'article', entitySyncId: 'article-1',
        entityGeneration: 0, mutationType: 'FIELD_SET', payloadSchemaVersion: 1,
        payloadJson: '{"value":true,"field":"isStarred"}',
        causalContextJson: '{"schemaVersion":1,"lanes":[]}', observedEntityVersionJson: null,
        status: 'PENDING_BUILD', createdAt: 10, updatedAt: 10, genesisIncludedAt: null
      })

      expect(builder.buildPending('space-1', 100, 20)).toBe(1)
      expect(builder.buildPending('space-1', 100, 21)).toBe(0)
      const operation = runtime.findOperation(operationId('space-1', 'actor-1', 'ARTICLE_STATE', 1))!
      expect(operation.payloadJson).toBe('{"field":"isStarred","value":true}')
      expect(operation.buildStatus).toBe('AWAITING_SIGNATURE')

      const conflicting = { ...operation, operationId: 'different-id', payloadJson: '{"field":"isStarred","value":false}', payloadHash: 'different' }
      expect(runtime.insertOperationIgnore(conflicting)).toBe(false)
      expect(() => builder.persistIdempotently(conflicting)).toThrow(SyncDotCollisionError)
    } finally {
      db.close()
    }
  })

  it('injects active AUTH grant and rejects unauthorized device under strict mode', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const strictBuilder = new DesktopOperationBuilder(runtime, { strictAuth: true })

    try {
      db.prepare('INSERT INTO sync_spaces(sync_space_id,created_at,updated_at) VALUES(?,?,?)').run('space-1', 1, 1)
      runtime.insertActor({
        actorIncarnationId: 'actor-1', syncSpaceId: 'space-1', deviceId: 'device-1',
        status: 'ACTIVE', createdAt: 1, retiredAt: null
      })
      runtime.insertOutbox({
        outboxId: 'actor-1:ARTICLE_STATE:1', syncSpaceId: 'space-1', actorIncarnationId: 'actor-1',
        replicationLaneId: 'ARTICLE_STATE', sequence: 1, entityType: 'article', entitySyncId: 'article-1',
        entityGeneration: 0, mutationType: 'FIELD_SET', payloadSchemaVersion: 1,
        payloadJson: '{"value":true,"field":"isStarred"}',
        causalContextJson: '{"schemaVersion":1,"lanes":[]}', observedEntityVersionJson: null,
        status: 'PENDING_BUILD', createdAt: 10, updatedAt: 10, genesisIncludedAt: null
      })

      // 1. 无 AUTH grant 时，严格模式抛出异常
      expect(() => strictBuilder.buildPending('space-1', 100, 20)).toThrow('is not authorized in space space-1')

      // 2. 写入创世 SPACE_ROOT（device-1 为 owner）
      runtime.upsertAuthObject({
        protocolVersion: 1,
        authObjectId: 'auth1:root-1',
        syncSpaceId: 'space-1',
        authEpoch: 0,
        objectType: 'SPACE_ROOT',
        authorDeviceId: 'device-1',
        ownerDeviceId: 'device-1',
        targetDeviceId: null,
        previousEpochFinalAcceptedPrefixByActorLane: {},
        revokeCutoffByActorLane: null,
        payloadJson: '{"kind":"space-root"}',
        payloadHash: sha256Hex('{"kind":"space-root"}'),
        signingDigest: 'digest-root',
        authorSignature: 'sig-root'
      })

      // 3. 此时能够正常构建，并成功注入真实的 authGrantId 和 authEpoch
      expect(strictBuilder.buildPending('space-1', 100, 20)).toBe(1)
      const operation = runtime.findOperation(operationId('space-1', 'actor-1', 'ARTICLE_STATE', 1))!
      expect(operation.authGrantId).toBe('auth1:root-1')
      expect(operation.authEpoch).toBe(0)
    } finally {
      db.close()
    }
  })
})
