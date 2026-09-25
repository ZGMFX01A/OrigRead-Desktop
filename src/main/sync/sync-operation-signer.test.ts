import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../security/secret-store'
import { applyMigrations } from '../database/migrations'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopOperationBuilder } from './sync-operation-builder'
import { DesktopSyncOperationSigner } from './sync-operation-signer'
import { SyncRuntimeRepository } from './sync-runtime-repository'

class TestSecretStore implements SecretStore {
  private values = new Map<string, string>()
  get(key: string): string { return this.values.get(key) ?? '' }
  put(key: string, value: string): void { value.trim() ? this.values.set(key, value.trim()) : this.values.delete(key) }
  contains(key: string): boolean { return this.values.has(key) }
  delete(key: string): void { this.values.delete(key) }
  snapshot(): Readonly<Record<string, string>> { return Object.fromEntries(this.values) }
  restoreSnapshot(snapshot: Readonly<Record<string, string>>): void {
    this.values = new Map(Object.entries(snapshot))
  }
}

describe('SYNC operation signing', () => {
  it('keeps a stable P-256 key per device and verifies signatures', () => {
    const keys = new DesktopSyncDeviceSigningKeyStore(new TestSecretStore())
    const first = keys.publicKeySpkiBase64('device-1')
    const second = keys.publicKeySpkiBase64('device-1')
    expect(second).toBe(first)
    const signature = keys.signBase64('device-1', '跨端签名 fixture')
    expect(keys.verifyBase64(first, '跨端签名 fixture', signature)).toBe(true)
    expect(keys.verifyBase64(first, 'tampered', signature)).toBe(false)
  })

  it('signs only canonical local operations and makes them independently verifiable', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    applyMigrations(db)
    const runtime = new SyncRuntimeRepository(db)
    const keys = new DesktopSyncDeviceSigningKeyStore(new TestSecretStore())
    const builder = new DesktopOperationBuilder(runtime, { strictAuth: false })
    const signer = new DesktopSyncOperationSigner(runtime, keys)
    try {
      db.prepare('INSERT INTO sync_spaces(sync_space_id,created_at,updated_at) VALUES(?,?,?)').run('space-1', 1, 1)
      runtime.replaceDeviceIdentity({ deviceId: 'device-1', witnessId: 'witness-1', createdAt: 1, updatedAt: 1 })
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
      expect(signer.signPending('space-1', 100, 30)).toBe(1)
      expect(signer.signPending('space-1', 100, 31)).toBe(0)

      const signed = runtime.listOperationsByStatus('space-1', 'SIGNED', 10)[0]
      if (!signed) throw new Error('Expected a signed Sync operation')
      expect(signed.authorSignature).toBeTruthy()
      expect(signer.verify(signer.publicKeySpkiBase64('device-1'), signed)).toBe(true)
      expect(signer.verify(signer.publicKeySpkiBase64('device-1'), { ...signed, payloadJson: '{"field":"isStarred","value":false}' }))
        .toBe(false)
    } finally {
      db.close()
    }
  })
})
