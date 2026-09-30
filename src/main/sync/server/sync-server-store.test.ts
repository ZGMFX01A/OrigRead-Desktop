import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../../security/secret-store'
import { DesktopSyncDeviceSigningKeyStore } from '../sync-device-signing-key-store'
import { canonicalJson, operationId, operationSigningDigest, operationSigningMaterial, sha256Hex } from '../sync-operation-canonicalizer'
import { SyncServerStore } from './sync-server-store'
import { toSyncOperationEnvelope } from '../../../shared/sync-protocol'
import type { SyncOperationRecord } from '../../../shared/sync-runtime'

describe('Durable Sync Peer', () => {
  it('stores signed envelopes opaquely, deduplicates them, and serves continuous ranges', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    try {
      const payloadJson = canonicalJson('{"value":true,"field":"isStarred"}')
      const unsigned: SyncOperationRecord = {
        operationId: operationId('space-server', 'actor-server', 'ARTICLE_STATE', 1),
        syncSpaceId: 'space-server', authorDeviceId: 'device-server', actorIncarnationId: 'actor-server',
        replicationLaneId: 'ARTICLE_STATE', sequence: 1, logicalClock: 1,
        causalContextJson: '{"lanes":[],"schemaVersion":1}', dependencyDotsJson: '[]',
        entityType: 'article', entitySyncId: 'article-1', entityGeneration: 0, operationType: 'FIELD_SET',
        payloadSchemaVersion: 1, payloadJson, schemaVersion: 1, authGrantId: null, authEpoch: null,
        createdWallClock: 1, payloadHash: sha256Hex(payloadJson), signingDigest: '', authorSignature: null,
        buildStatus: 'AWAITING_SIGNATURE', createdAt: 1, updatedAt: 1
      }
      const unsignedWithDigest = { ...unsigned, signingDigest: operationSigningDigest(unsigned) }
      const signature = keys.signBase64(unsignedWithDigest.authorDeviceId, operationSigningMaterial(unsignedWithDigest))
      const operation: SyncOperationRecord = { ...unsignedWithDigest, authorSignature: signature, buildStatus: 'SIGNED' }
      server.registerMember({
        syncSpaceId: 'space-server', deviceId: 'device-server',
        publicKeySpkiBase64: keys.publicKeySpkiBase64('device-server'), status: 'ACTIVE', authEpoch: 0
      })
      const envelope = toSyncOperationEnvelope(operation)
      expect(server.putOperations('space-server', [envelope]).acceptedOperationIds).toEqual([operation.operationId])
      expect(server.putOperations('space-server', [envelope]).duplicateOperationIds).toEqual([operation.operationId])
      expect(server.state('space-server').coverage.received.ARTICLE_STATE).toEqual({ 'actor-server': 1 })
      expect(server.requestOperations('space-server', [{ actorIncarnationId: 'actor-server', replicationLaneId: 'ARTICLE_STATE', fromSequence: 1, toSequence: 1 }]).operations)
        .toHaveLength(1)
    } finally {
      server.close()
    }
  })

  it('keeps an incomplete Blob resumable and only marks it final after hash verification', () => {
    const blobDirectory = mkdtempSync(join(tmpdir(), 'origread-sync-test-'))
    const server = new SyncServerStore({ databasePath: ':memory:', blobDirectory })
    try {
      const bytes = Buffer.from('durable-sync-blob')
      const hash = sha256Hex(bytes.toString('utf8'))
      server.putBlob('space-a', { hash, offset: 0, totalBytes: bytes.length, bytes: bytes.subarray(0, 7), isFinal: false })
      const partial = server.getBlob('space-a', hash)
      expect(partial.isFinal).toBe(false)
      expect(partial.totalBytes).toBe(bytes.length)
      expect(server.blobStatus('space-a', hash)).toMatchObject({
        hash,
        totalBytes: bytes.length,
        receivedBytes: 7,
        complete: false,
        replicaId: null,
        persistedAt: null
      })
      expect(() => server.getBlob('space-b', hash)).toThrow(/not available/)
      expect(() => server.putBlob('space-a', { hash, offset: 7, totalBytes: bytes.length, bytes: Buffer.alloc(bytes.length - 7), isFinal: true })).toThrow(/hash mismatch/)
      expect(server.getBlob('space-a', hash).bytes.length).toBe(7)
      server.putBlob('space-a', { hash, offset: 7, totalBytes: bytes.length, bytes: bytes.subarray(7), isFinal: true })
      server.putBlob('space-c', { hash, offset: 0, totalBytes: bytes.length, bytes: Buffer.from('wrong'), isFinal: false })
      server.putBlob('space-c', { hash, offset: 0, totalBytes: bytes.length, bytes, isFinal: true })
      expect(server.getBlob('space-c', hash).isFinal).toBe(true)
      const complete = server.getBlob('space-a', hash)
      expect(complete.isFinal).toBe(true)
      expect(Buffer.from(complete.bytes).toString('utf8')).toBe('durable-sync-blob')
      expect(server.blobStatus('space-a', hash)).toMatchObject({
        hash,
        totalBytes: bytes.length,
        receivedBytes: bytes.length,
        complete: true,
        replicaId: server.serverReplicaId
      })
    } finally {
      server.close()
      rmSync(blobDirectory, { recursive: true, force: true })
    }
  })

  it('rotates the persisted history epoch and rejects cursors from the previous epoch', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    try {
      const deviceId = 'device-history'
      server.registerMember({
        syncSpaceId: 'space-history', deviceId,
        publicKeySpkiBase64: keys.publicKeySpkiBase64(deviceId), status: 'ACTIVE', authEpoch: 0
      })
      const payloadJson = canonicalJson('{"field":"isStarred","value":true}')
      const unsigned: SyncOperationRecord = {
        operationId: operationId('space-history', 'actor-history', 'ARTICLE_STATE', 1),
        syncSpaceId: 'space-history', authorDeviceId: deviceId, actorIncarnationId: 'actor-history',
        replicationLaneId: 'ARTICLE_STATE', sequence: 1, logicalClock: 1,
        causalContextJson: '{"lanes":[],"schemaVersion":1}', dependencyDotsJson: '[]',
        entityType: 'article', entitySyncId: 'article-history', entityGeneration: 0, operationType: 'FIELD_SET',
        payloadSchemaVersion: 1, payloadJson, schemaVersion: 1, authGrantId: null, authEpoch: null,
        createdWallClock: 1, payloadHash: sha256Hex(payloadJson), signingDigest: '', authorSignature: null,
        buildStatus: 'AWAITING_SIGNATURE', createdAt: 1, updatedAt: 1
      }
      const withDigest = { ...unsigned, signingDigest: operationSigningDigest(unsigned) }
      const operation: SyncOperationRecord = {
        ...withDigest,
        authorSignature: keys.signBase64(deviceId, operationSigningMaterial(withDigest)),
        buildStatus: 'SIGNED'
      }
      server.putOperations('space-history', [toSyncOperationEnvelope(operation)])
      const oldCursor = server.currentCursor()
      const newCursor = server.rewindHistory()

      expect(newCursor.serverEpoch).not.toBe(oldCursor.serverEpoch)
      expect(() => server.requestOperations('space-history', [], oldCursor)).toThrow(/previous server history epoch/i)
      expect(server.requestOperations('space-history', [], newCursor).serverCursor).toEqual(newCursor)
    } finally {
      server.close()
    }
  })

  it('prevents retainedPrefix from jumping across sequence gaps (R12-04)', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    try {
      // 人工插入 seq=1 和 seq=3（缺 seq=2）
      const db = (server as any).database
      db.prepare(`
        INSERT INTO sync_server_operations(
          operation_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,state,rejection_digest,operation_json,created_at
        ) VALUES('op-1', 'space-gap', 'actor-1', 'ARTICLE_STATE', 1, 'ACCEPTED', NULL, '{}', 100),
                ('op-3', 'space-gap', 'actor-1', 'ARTICLE_STATE', 3, 'ACCEPTED', NULL, '{}', 200)
      `).run()

      const state = server.state('space-gap')
      // received 因为缺失 2，只能到 1
      expect(state.coverage.received.ARTICLE_STATE?.['actor-1']).toBe(1)
      // retained 绝不能像以前一样 Math.max() 变成 3，必须也是严格连续的 1！
      expect(state.coverage.retained.ARTICLE_STATE?.['actor-1']).toBe(1)
    } finally {
      server.close()
    }
  })

  it('does not relay rejected operations as valid retained history', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    try {
      const db = (server as any).database
      db.prepare(`
        INSERT INTO sync_server_operations(
          operation_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,state,rejection_digest,operation_json,created_at
        ) VALUES('op-1', 'space-relay', 'actor-1', 'ARTICLE_STATE', 1, 'ACCEPTED', NULL, '{"operationId":"op-1"}', 100),
                ('op-2', 'space-relay', 'actor-1', 'ARTICLE_STATE', 2, 'REJECTED', 'rejected:op-2', '{"operationId":"op-2"}', 150),
                ('op-3', 'space-relay', 'actor-1', 'ARTICLE_STATE', 3, 'ACCEPTED', NULL, '{"operationId":"op-3"}', 200)
      `).run()

      const state = server.state('space-relay')
      expect(state.coverage.received.ARTICLE_STATE?.['actor-1']).toBe(3)
      expect(state.coverage.retained.ARTICLE_STATE?.['actor-1']).toBe(1)

      const page = server.requestOperations('space-relay', [{
        actorIncarnationId: 'actor-1',
        replicationLaneId: 'ARTICLE_STATE',
        fromSequence: 1,
        toSequence: 3
      }])
      expect(page.operations).toHaveLength(2)
      expect(page.operations.map((op) => op.operationId)).toEqual(['op-1', 'op-3'])
    } finally {
      server.close()
    }
  })

  it('rejects tampered snapshot bundle under existing ID (R12-08)', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    try {
      const contentHash = sha256Hex(Array(6).fill('{}').join('\n'))
      const validRootHash = sha256Hex(contentHash)
      const snapshot: any = {
        snapshotBundleId: 'snap-immutable',
        syncSpaceId: 'space-snap',
        snapshotClass: 'WORKING',
        capturedAt: 100,
        rootHash: validRootHash,
        policyHash: 'policy-hash',
        shards: [
          { replicationLaneId: 'CORE_META', contentHash, frontierJson: '{}', entityStateJson: '{}', fieldVersionStateJson: '{}', causalMetadataJson: '{}', genesisCoverageJson: '{}', deletionGenerationSummaryJson: '{}' }
        ],
        coverage: {}
      }
      expect(() => server.putSnapshot(snapshot)).toThrowError(/requires an author signature/)

      const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      server.registerMember({ syncSpaceId: 'space-snap', deviceId: 'snapshot-author', publicKeySpkiBase64: keys.publicKeySpkiBase64('snapshot-author'), status: 'ACTIVE', authEpoch: 0 })
      const manifest = { ...snapshot, authorDeviceId: 'snapshot-author' }
      const signed = { ...manifest, authorSignature: keys.signBase64('snapshot-author', `ORIGREAD_SNAPSHOT_V1\n${canonicalJson(JSON.stringify(manifest))}`) }
      server.putSnapshot(signed)
      expect(server.latestSnapshot('space-snap')).toEqual(signed)
      const equivalent = { ...manifest, snapshotBundleId: 'equivalent-id', capturedAt: 101 }
      server.putSnapshot({ ...equivalent, authorSignature: keys.signBase64('snapshot-author', `ORIGREAD_SNAPSHOT_V1\n${canonicalJson(JSON.stringify(equivalent))}`) })
      expect(server.latestSnapshot('space-snap')?.snapshotBundleId).toBe('equivalent-id')
      expect(() => server.putSnapshot({ ...signed, coverage: { ARTICLE_STATE: { attacker: 99 } } })).toThrowError(/signature verification failed/)
      expect(() => server.putSnapshot({ ...signed, snapshotClass: 'GC_BASELINE' })).toThrowError(/signature verification failed/)
      expect(server.latestSnapshot('space-snap', 'WORKING', ['ARTICLE_STATE'])).toBeNull()

      // 篡改了 rootHash 的快照会被独立重算直接拦截 (SNAPSHOT_CORRUPTED)
      const tampered = { ...snapshot, rootHash: 'root-hash-tampered' }
      expect(() => server.putSnapshot(tampered)).toThrowError(/root hash mismatch/i)
    } finally {
      server.close()
    }
  })

  it('refuses unverified pruning and preserves recoverable history', () => {
    const server = new SyncServerStore({ databasePath: ':memory:' })
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    try {
      server.registerMember({
        syncSpaceId: 'space-p', deviceId: 'dev-p',
        publicKeySpkiBase64: keys.publicKeySpkiBase64('dev-p'), status: 'ACTIVE', authEpoch: 0
      })

      const makeOp = (seq: number): any => {
        const payload = canonicalJson('{"value":true,"field":"isStarred"}')
        const unsigned: SyncOperationRecord = {
          operationId: operationId('space-p', 'act-1', 'ARTICLE_STATE', seq),
          syncSpaceId: 'space-p', authorDeviceId: 'dev-p', actorIncarnationId: 'act-1',
          replicationLaneId: 'ARTICLE_STATE', sequence: seq, logicalClock: seq,
          causalContextJson: '{"lanes":[],"schemaVersion":1}', dependencyDotsJson: '[]',
          entityType: 'article', entitySyncId: 'art-1', entityGeneration: 0, operationType: 'FIELD_SET',
          payloadSchemaVersion: 1, payloadJson: payload, schemaVersion: 1, authGrantId: null, authEpoch: null,
          createdWallClock: 1, payloadHash: sha256Hex(payload), signingDigest: '', authorSignature: null,
          buildStatus: 'AWAITING_SIGNATURE', createdAt: 1, updatedAt: 1
        }
        const withDigest = { ...unsigned, signingDigest: operationSigningDigest(unsigned) }
        const sig = keys.signBase64('dev-p', operationSigningMaterial(withDigest))
        return toSyncOperationEnvelope({ ...withDigest, authorSignature: sig, buildStatus: 'SIGNED' })
      }

      const putRes = server.putOperations('space-p', [makeOp(1), makeOp(2), makeOp(3)])
      expect(putRes.acceptedOperationIds).toHaveLength(3)
      expect(server.requestOperations('space-p', [{ actorIncarnationId: 'act-1', replicationLaneId: 'ARTICLE_STATE', fromSequence: 1, toSequence: 3 }]).operations)
        .toHaveLength(3)

      expect(() => server.pruneOperations('space-p', { ARTICLE_STATE: { 'act-1': 2 } })).toThrowError(/proofs are required/)
      expect(server.requestOperations('space-p', [{ actorIncarnationId: 'act-1', replicationLaneId: 'ARTICLE_STATE', fromSequence: 1, toSequence: 3 }]).operations).toHaveLength(3)

    } finally {
      server.close()
    }
  })
})
