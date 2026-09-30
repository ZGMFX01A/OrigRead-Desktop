import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryRepository } from '../database/library-repository'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { MemorySecretStore } from '../security/secret-store'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import { DesktopSnapshotInstallService, SyncRebaseUnsafeError } from './desktop-snapshot-install-service'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import type { SyncSnapshotBundleWire } from '../../shared/sync-protocol'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopSyncOperationSigner } from './sync-operation-signer'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import { snapshotSigningMaterial } from './sync-snapshot-wire'
import { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'

function testDb() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database)
  database.exec('DELETE FROM articles; DELETE FROM feeds')
  return database
}

function signTrustedBundle(
  state: SyncStateRepository,
  bundle: SyncSnapshotBundleWire,
  deviceId = 'snapshot-author'
): SyncSnapshotBundleWire {
  const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
  state.registerPeer({
    syncSpaceId: bundle.syncSpaceId,
    deviceId,
    publicKeySpkiBase64: keys.publicKeySpkiBase64(deviceId),
    status: 'ACTIVE',
    authEpoch: 0,
    updatedAt: 1
  })
  const unsigned = { ...bundle, authorDeviceId: deviceId, authorSignature: null }
  return {
    ...unsigned,
    authorSignature: keys.signBase64(deviceId, snapshotSigningMaterial(unsigned))
  }
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

describe('DesktopSnapshotInstallService', () => {
  it.each([false, true])('installs snapshot with a historical checkpoint=%s', (historicalCheckpoint) => {
    const sourceDb = testDb()
    const targetDb = testDb()

    const tempDir = mkdtempSync(join(tmpdir(), 'origread-snap-test-'))
    try {
      // 1. 在 Source 端填充业务数据
      sourceDb.prepare("INSERT INTO groups(id, account_id, name, sort_order, is_default) VALUES('group-1', 1, 'Tech', 1, 0)").run()
      sourceDb.prepare(`
        INSERT INTO feeds(id, account_id, group_id, name, url, source_type, created_at, updated_at)
        VALUES('feed-1', 1, 'group-1', 'TechNews', 'https://example.com/rss', 'rss', 100, 100)
      `).run()
      sourceDb.prepare(`
        INSERT INTO articles(id, account_id, feed_id, title, url, description, is_unread, is_starred, created_at, updated_at)
        VALUES('art-1', 1, 'feed-1', 'Breaking News', 'https://example.com/1', 'Content', 1, 0, 100, 100)
      `).run()

      const sourceRuntime = new SyncRuntimeRepository(sourceDb)
      const sourceIdentity = new SyncIdentityRepository(sourceDb)
      const sourceWitness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'src-witness')
      const sourceCoord = new DesktopSyncRuntimeCoordinator(sourceRuntime, sourceIdentity, sourceWitness)
      const sourceFilter = new ArticleFilterRepository(join(tempDir, 'filter-rules.json'))
      const sourceKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
      const sourceRssHub = new RssHubSettingsRepository(sourceDb)
      new LibraryRepository(sourceDb).setRssHubDescriptor('feed-1', {
        originalInput: 'rsshub://new/route', routePath: '/new/route', preferredInstance: null,
        lastResolvedInstance: null, lastResolvedUrl: null
      })
      const genesisService = new DesktopGenesisSnapshotService(
        sourceDb,
        sourceRuntime,
        sourceCoord,
        sourceFilter,
        undefined,
        undefined,
        sourceKeys,
        undefined,
        undefined,
        undefined,
        sourceRssHub
      )

      // 生成创世快照
      const cutover = genesisService.run(1, 'space-snap-test', undefined, 100)
      expect(cutover.snapshotBundleId).toBeTruthy()

      let bundleWire = genesisService.exportWire(cutover.snapshotBundleId)
      if (historicalCheckpoint) {
        const sourceState = new SyncStateRepository(sourceDb)
        const ledger = new DesktopAuthLedgerService(sourceRuntime, sourceState)
        const signer = new DesktopSyncOperationSigner(sourceRuntime, sourceKeys)
        const checkpoint = ledger.issueStabilityCheckpoint('space-snap-test', signer, 110, bundleWire.snapshotBundleId, bundleWire.coverage)
        if (!checkpoint) throw new Error('Expected owner checkpoint')
        const unsigned = { ...bundleWire, snapshotClass: 'GC_BASELINE' as const,
          authStabilityCheckpoint: checkpoint.authObjectId, authorSignature: null }
        bundleWire = { ...unsigned, authorSignature: sourceKeys.signBase64(unsigned.authorDeviceId!, snapshotSigningMaterial(unsigned)) }
        ledger.issueStabilityCheckpoint('space-snap-test', signer, 120, bundleWire.snapshotBundleId, bundleWire.coverage)
      }

      // 2. 在全新的 Target 端安装该快照
      const targetRuntime = new SyncRuntimeRepository(targetDb)
      const targetState = new SyncStateRepository(targetDb)
      const targetIdentity = new SyncIdentityRepository(targetDb)
      const targetWitness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'tgt-witness')
      const targetCoord = new DesktopSyncRuntimeCoordinator(targetRuntime, targetIdentity, targetWitness)
      targetCoord.prepareSpace(1, 'space-snap-test', 100)
      targetState.registerPeer({
        syncSpaceId: 'space-snap-test',
        deviceId: bundleWire.authorDeviceId!,
        publicKeySpkiBase64: sourceKeys.publicKeySpkiBase64(bundleWire.authorDeviceId!),
        status: 'ACTIVE',
        authEpoch: 0,
        updatedAt: 100
      })
      new DesktopAuthLedgerService(targetRuntime, targetState).append(
        'space-snap-test',
        sourceRuntime.listAuthObjects('space-snap-test'),
        100
      )

      const targetRssHub = new RssHubSettingsRepository(targetDb)
      const installService = new DesktopSnapshotInstallService(
        targetDb,
        targetRuntime,
        targetState,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        targetRssHub
      )
      targetRssHub.setEnabled(false)
      const partialResult = installService.install(1, bundleWire, 199, new Set(['CORE_META', 'AUTH', 'LIBRARY']))
      expect(targetRssHub.current().enabled).toBe(false)
      const partialFeed = targetDb.prepare("SELECT id FROM feeds WHERE name='TechNews'").get() as { id: string }
      new LibraryRepository(targetDb).setRssHubDescriptor(partialFeed.id, {
        originalInput: 'rsshub://old/route', routePath: '/old/route', preferredInstance: 'https://old.example',
        lastResolvedInstance: 'https://old.example', lastResolvedUrl: 'https://old.example/old/route'
      })
      const result = installService.install(1, bundleWire, 200)
      expect(targetRssHub.current().enabled).toBe(true)

      expect(result.snapshotBundleId).toBe(bundleWire.snapshotBundleId)
      expect(result.materializedEntities + partialResult.materializedEntities).toBeGreaterThanOrEqual(3)

        // 3. 验证业务实体在 Target 端完整实例化，且 Local ID 独立分配（R10-02/R10-03 隔离验证）
      const targetGroup = targetDb.prepare("SELECT * FROM groups WHERE name='Tech'").get() as Record<string, unknown>
      expect(targetGroup).toBeTruthy()
      expect(targetGroup.name).toBe('Tech')
      expect(targetGroup.id).not.toBe('group-1')

      const targetFeed = targetDb.prepare("SELECT * FROM feeds WHERE name='TechNews'").get() as Record<string, unknown>
      expect(targetFeed).toBeTruthy()
      expect(targetFeed.url).toBe('https://example.com/rss')
      expect(targetFeed.id).not.toBe('feed-1')
      expect(targetFeed.group_id).toBe(targetGroup.id)

      const targetLibrary = new LibraryRepository(targetDb)
      expect(targetLibrary.getRssHubDescriptor(String(targetFeed.id))?.routePath).toBe('/new/route')
      expect(targetLibrary.getRssHubDescriptor(String(targetFeed.id))?.lastResolvedUrl).toBeNull()

      const targetArticle = targetDb.prepare("SELECT * FROM articles WHERE title='Breaking News'").get() as Record<string, unknown>
      expect(targetArticle).toBeTruthy()
      expect(targetArticle.id).not.toBe('art-1')
      expect(targetArticle.feed_id).toBe(targetFeed.id)
      expect(targetArticle.is_unread).toBe(1)

      // 4. 验证 Target 端 Field Versions 已经完整物化恢复（R10-06）
      const fieldVersions = targetDb.prepare("SELECT * FROM sync_field_version WHERE entity_type='article'").all() as Array<Record<string, unknown>>
      expect(fieldVersions.length).toBeGreaterThan(0)
      const unreadFv = fieldVersions.find((fv) => fv.field_id === 'isUnread')
      expect(unreadFv).toBeTruthy()
      expect(String(unreadFv!.version_token)).toContain('GENESIS_V1')
      expect(unreadFv!.value_json).toBe('true')

      // 5. 验证 Target 端的 Coverage：retainedPrefix 绝未虚高设置为 snapshotPrefix（R10-09）
      const coverage = targetState.getCoverage('space-snap-test')
      expect(coverage.received).toEqual(bundleWire.coverage)
      expect(coverage.applied).toEqual(bundleWire.coverage)
      expect(coverage.snapshot).toEqual(bundleWire.coverage)
      expect(coverage.retained).toEqual({})

      // 6. Snapshot 进入可写的 STAGING；Tail replay 完成前不得提前 ACTIVE。
      expect(targetRuntime.findBinding(1)?.lifecycleState).toBe('STAGING')
      targetRssHub.setEnabled(false)
      installService.install(1, bundleWire, 201)
      expect(targetRssHub.current().enabled).toBe(false)
      installService.activateAfterTail(1, bundleWire.snapshotBundleId, 201)
      expect(targetRuntime.findBinding(1)?.lifecycleState).toBe('ACTIVE')

      // 7. 直接绕过 Outbox 的裸业务行不是 Sync 历史，不能伪造 LocalRecovery 条件。
      // 正常生产写入必须经 mutation capture；同一已验证 Snapshot 重装应保持幂等。
      targetDb.prepare("INSERT INTO groups(id, account_id, name, sort_order, is_default) VALUES('local-unmapped', 1, 'Local only', 99, 0)").run()
      expect(() => installService.install(1, bundleWire, 300)).not.toThrow()
      expect(targetDb.prepare("SELECT id FROM groups WHERE id='local-unmapped'").get()).toBeTruthy()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      sourceDb.close()
      targetDb.close()
    }
  })

  it('rejects tampered snapshot shard contentHash (R10-04)', () => {
    const db = testDb()
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const identity = new SyncIdentityRepository(db)
    const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'w')
    const coord = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
    coord.prepareSpace(1, 'space-tamper', 100)

    const installService = new DesktopSnapshotInstallService(db, runtime, state)
    const bundle: SyncSnapshotBundleWire = {
      snapshotBundleId: 'snap-tampered',
      syncSpaceId: 'space-tamper',
      snapshotClass: 'WORKING',
      genesisBaselineId: 'base-1',
      rootHash: 'fake-root',
      policyHash: 'fake-policy',
      capturedAt: 100,
      shards: [
        {
          replicationLaneId: 'CORE_META',
          frontierJson: '{}',
          entityStateJson: '{"schemaVersion":1,"lane":"CORE_META","entities":[]}',
          fieldVersionStateJson: '{}',
          causalMetadataJson: '{}',
          genesisCoverageJson: '{}',
          deletionGenerationSummaryJson: '[]',
          contentHash: 'tampered-content-hash'
        },
        {
          replicationLaneId: 'CONFIG',
          frontierJson: '{}',
          entityStateJson: '{"schemaVersion":1,"lane":"CONFIG","entities":[]}',
          fieldVersionStateJson: '{}',
          causalMetadataJson: '{}',
          genesisCoverageJson: '{}',
          deletionGenerationSummaryJson: '[]',
          contentHash: 'hash-config'
        },
        {
          replicationLaneId: 'AUTH',
          frontierJson: '{}',
          entityStateJson: '{"schemaVersion":1,"lane":"AUTH","entities":[]}',
          fieldVersionStateJson: '{}',
          causalMetadataJson: '{}',
          genesisCoverageJson: '{}',
          deletionGenerationSummaryJson: '[]',
          contentHash: 'hash-auth'
        },
        {
          replicationLaneId: 'LIBRARY',
          frontierJson: '{}',
          entityStateJson: '{"schemaVersion":1,"lane":"LIBRARY","entities":[]}',
          fieldVersionStateJson: '{}',
          causalMetadataJson: '{}',
          genesisCoverageJson: '{}',
          deletionGenerationSummaryJson: '[]',
          contentHash: 'hash-lib'
        },
        {
          replicationLaneId: 'ARTICLE_STATE',
          frontierJson: '{}',
          entityStateJson: '{"schemaVersion":1,"lane":"ARTICLE_STATE","entities":[]}',
          fieldVersionStateJson: '{}',
          causalMetadataJson: '{}',
          genesisCoverageJson: '{}',
          deletionGenerationSummaryJson: '[]',
          contentHash: 'hash-art'
        }
      ],
      coverage: {}
    }

    const signed = signTrustedBundle(state, bundle)
    expect(() => installService.install(1, signed, 100)).toThrowError(/hash mismatch/i)
    db.close()
  })

  it('fails with SnapshotDependencyMissingError when article feed is missing (R10-05)', () => {
    const db = testDb()
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const identity = new SyncIdentityRepository(db)
    const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'w')
    const coord = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
    coord.prepareSpace(1, 'space-missing-dep', 100)
    const authKeys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const root = bootstrapOwnerAuth(runtime, state, authKeys, 'space-missing-dep', 100)

    const articleShard = {
      replicationLaneId: 'ARTICLE_STATE' as const,
      frontierJson: '{}',
      entityStateJson: JSON.stringify({
        schemaVersion: 1,
        lane: 'ARTICLE_STATE',
        entities: [
          {
            entityType: 'article',
            entitySyncId: 'art-orphan',
            generation: 0,
            fields: {
              feedSyncId: 'non-existent-feed-sync-id',
              title: 'Orphan Article'
            }
          }
        ]
      }),
      fieldVersionStateJson: '{}',
      causalMetadataJson: '{}',
      genesisCoverageJson: '{}',
      deletionGenerationSummaryJson: '[]'
    }

    const { createHash } = require('node:crypto')
    const calcHash = (s: typeof articleShard) =>
      createHash('sha256').update([s.frontierJson, s.entityStateJson, s.fieldVersionStateJson, s.causalMetadataJson, s.genesisCoverageJson, s.deletionGenerationSummaryJson].join('\n'), 'utf8').digest('hex')

    const baseShards = ['CORE_META', 'CONFIG', 'AUTH', 'LIBRARY'].map((lane) => {
      const s = {
        replicationLaneId: lane as any,
        frontierJson: '{}',
        entityStateJson: JSON.stringify({
          schemaVersion: 1,
          lane,
          entities: lane === 'AUTH'
            ? [{
                entityType: 'auth_ledger',
                entitySyncId: 'space-missing-dep:auth',
                generation: 0,
                fields: { objects: [root] }
              }]
            : []
        }),
        fieldVersionStateJson: '{}',
        causalMetadataJson: '{}',
        genesisCoverageJson: '{}',
        deletionGenerationSummaryJson: '[]'
      }
      return { ...s, contentHash: calcHash(s as any) }
    })
    const fullShards = [...baseShards, { ...articleShard, contentHash: calcHash(articleShard as any) }]
    const sortedForRoot = [...fullShards].sort((a, b) => a.replicationLaneId.localeCompare(b.replicationLaneId))
    const rootHash = createHash('sha256').update(sortedForRoot.map((s) => s.contentHash).join('\n'), 'utf8').digest('hex')

    const bundle: SyncSnapshotBundleWire = {
      snapshotBundleId: 'snap-orphan',
      syncSpaceId: 'space-missing-dep',
      snapshotClass: 'WORKING',
      genesisBaselineId: 'base-orphan',
      rootHash,
      policyHash: 'pol',
      capturedAt: 100,
      shards: fullShards,
      coverage: {}
    }

    const installService = new DesktopSnapshotInstallService(db, runtime, state)
    const signed = signTrustedBundle(state, bundle)
    expect(() => installService.install(1, signed, 100)).toThrowError(/Missing feed dependency/)

    // 验证事务完整回滚，数据库没有残留孤儿文章
    const orphan = db.prepare("SELECT * FROM articles WHERE title='Orphan Article'").get()
    expect(orphan).toBeFalsy()
    db.close()
  })

  it('rejects unsafe rebase when rootHash or policyHash is missing and leaves binding non-ACTIVE', () => {
    const db = testDb()
    const runtime = new SyncRuntimeRepository(db)
    const state = new SyncStateRepository(db)
    const identity = new SyncIdentityRepository(db)
    const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'witness')
    const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
    coordinator.prepareSpace(1, 'space-unsafe-test', 100)

    const bundle: SyncSnapshotBundleWire = {
      snapshotBundleId: 'snap-unsafe',
      genesisBaselineId: null,
      syncSpaceId: 'space-unsafe-test',
      snapshotClass: 'WORKING',
      rootHash: '', // empty rootHash
      policyHash: 'pol',
      capturedAt: 100,
      shards: [],
      coverage: {}
    }

    const installService = new DesktopSnapshotInstallService(db, runtime, state)
    expect(() => installService.install(1, bundle, 100)).toThrow(SyncRebaseUnsafeError)

    const binding = runtime.findBinding(1)
    expect(binding?.lifecycleState).not.toBe('ACTIVE')
    db.close()
  })
})
