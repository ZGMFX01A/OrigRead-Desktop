import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import type { SyncBlobManifest } from '../../shared/sync-protocol'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { DesktopSyncBlobTransferCoordinator } from './sync-blob-transfer-coordinator'
import { SyncMemoryHub } from './sync-memory-session'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  applyMigrations(db)
  return db
}

function fixtureBytes(): Uint8Array {
  return new TextEncoder().encode('OrigRead durable blob fixture')
}

function manifest(bytes: Uint8Array, durability: SyncBlobManifest['durability'] = 'SYNC_DURABLE'): SyncBlobManifest {
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    totalBytes: bytes.byteLength,
    mediaType: 'text/plain',
    compression: null,
    encryptionInfoJson: null,
    availabilityPolicy: 'LAZY',
    durability,
    referenceCount: 0
  }
}

describe('DesktopSyncBlobTransferCoordinator', () => {
  it('separates BlobPersistedAck from metadata and keeps final custody without an explicit handoff', async () => {
    const db = database()
    try {
      const bytes = fixtureBytes()
      const value = manifest(bytes)
      const state = new DesktopSyncBlobStateService(db)
      const transfer = new DesktopSyncBlobTransferCoordinator(state)
      const hub = new SyncMemoryHub()
      state.registerManifest(value)
      state.addReference('space', 'ARTICLE_STATE', 'article', 'article-1', 0, 'full_content', value.hash)

      const indexes = state.snapshotIndexes('space', 'ARTICLE_STATE')
      expect(JSON.parse(indexes.manifestIndexJson)).toHaveLength(1)
      expect(JSON.parse(indexes.referenceIndexJson)).toHaveLength(1)
      expect(state.canAutoGc('space', value.hash, 'local-device')).toBe(false)

      const ack = await transfer.upload(
        'space', value, bytes, hub.session('space', 'local-device'), { ARTICLE_STATE: 'ENABLED' }, 5, 100
      )
      expect(ack?.replicaId).toBe('memory-hub')
      expect(state.canAutoGc('space', value.hash, 'local-device')).toBe(false)

      state.removeReference('space', 'ARTICLE_STATE', 'article', 'article-1', 0, 'full_content', value.hash)
      // 旧 ACK 没有存储代次及责任接管证明，即使无业务引用也不能释放最后保管责任。
      expect(state.canAutoGc('space', value.hash, 'local-device')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('does not let Blob transfer bypass a paused lane and marks fetched bytes READY only after persistence', async () => {
    const sourceDb = database()
    const targetDb = database()
    try {
      const bytes = fixtureBytes()
      const value = manifest(bytes, 'REHYDRATABLE')
      const hub = new SyncMemoryHub()
      const sourceState = new DesktopSyncBlobStateService(sourceDb)
      const source = new DesktopSyncBlobTransferCoordinator(sourceState)
      sourceState.registerManifest(value)
      sourceState.addReference('space', 'AI_HISTORY', 'message', 'm-1', 0, 'context', value.hash)
      await expect(source.upload('space', value, bytes, hub.session('space', 'source'), { AI_HISTORY: 'PAUSED' }))
        .rejects.toThrow('blocked by replication lane policy')

      sourceState.removeReference('space', 'AI_HISTORY', 'message', 'm-1', 0, 'context', value.hash)
      sourceState.addReference('space', 'ARTICLE_STATE', 'article', 'a-1', 0, 'full_content', value.hash)
      await source.upload('space', value, bytes, hub.session('space', 'source'), { ARTICLE_STATE: 'ENABLED' }, 7)

      const targetState = new DesktopSyncBlobStateService(targetDb)
      const target = new DesktopSyncBlobTransferCoordinator(targetState)
      let persisted: Uint8Array | null = null
      const fetched = await target.fetch(
        'space', value, hub.session('space', 'target'), { ARTICLE_STATE: 'ENABLED' },
        (result) => { persisted = result }, 6, 200
      )
      expect(Buffer.from(fetched).equals(Buffer.from(bytes))).toBe(true)
      expect(Buffer.from(persisted!).equals(Buffer.from(bytes))).toBe(true)
      expect(targetDb.prepare('SELECT availability_state FROM sync_blob_manifest WHERE hash=?').get(value.hash))
        .toEqual({ availability_state: 'READY' })
    } finally {
      sourceDb.close()
      targetDb.close()
    }
  })

  it('resumes a matching durable prefix, restarts a corrupt prefix and treats a completed replica idempotently', async () => {
    const db = database()
    try {
      const bytes = fixtureBytes()
      const value = manifest(bytes)
      const state = new DesktopSyncBlobStateService(db)
      const transfer = new DesktopSyncBlobTransferCoordinator(state)

      const resumeHub = new SyncMemoryHub()
      const resumeSession = resumeHub.session('space', 'source')
      await resumeSession.pushBlob!({
        hash: value.hash,
        offset: 0,
        totalBytes: bytes.byteLength,
        bytes: bytes.slice(0, 8),
        isFinal: false
      })
      expect((await resumeSession.getBlobStatus!(value.hash))?.receivedBytes).toBe(8)
      const firstAck = await transfer.upload(
        'space', value, bytes, resumeSession, { ARTICLE_STATE: 'ENABLED' }, 5, 300
      )
      expect((await resumeSession.getBlobStatus!(value.hash))?.complete).toBe(true)

      // The second call observes the completed durable replica and does not re-upload it.
      const secondAck = await transfer.upload(
        'space', value, bytes, resumeSession, { ARTICLE_STATE: 'ENABLED' }, 5, 301
      )
      expect(secondAck?.persistedAt).toBe(firstAck?.persistedAt)

      const restartHub = new SyncMemoryHub()
      const restartSession = restartHub.session('space', 'source')
      const corruptPrefix = bytes.slice(0, 6)
      corruptPrefix[0] = corruptPrefix[0]! ^ 0xff
      await restartSession.pushBlob!({
        hash: value.hash,
        offset: 0,
        totalBytes: bytes.byteLength,
        bytes: corruptPrefix,
        isFinal: false
      })
      const restartedAck = await transfer.upload(
        'space', value, bytes, restartSession, { ARTICLE_STATE: 'ENABLED' }, 7, 302
      )
      expect(restartedAck?.replicaId).toBe('memory-hub')
      const fetched = await restartSession.fetchBlob(value.hash)
      expect(Buffer.from(fetched.bytes).equals(Buffer.from(bytes))).toBe(true)
    } finally {
      db.close()
    }
  })
})
