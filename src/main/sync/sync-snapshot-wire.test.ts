import { describe, expect, it } from 'vitest'
import type { SyncSnapshotBundleWire, SyncSnapshotShardWire } from '../../shared/sync-protocol'
import { sha256Hex } from './sync-operation-canonicalizer'
import {
  SNAPSHOT_HASH_SCHEMA_VERSION,
  assertSnapshotIntegrity,
  snapshotRootHash,
  snapshotShardContentHash,
  snapshotSigningMaterial
} from './sync-snapshot-wire'

describe('R10 Snapshot wire v2 fixture', () => {
  it('matches the cross-platform shard/root/signing fixture', () => {
    const shard: SyncSnapshotShardWire = {
      replicationLaneId: 'ARTICLE_STATE',
      frontierJson: '[{"actorFrontiers":{"actor-A":4},"replicationLaneId":"ARTICLE_STATE"}]',
      entityStateJson: '{"articles":[],"schemaVersion":1}',
      fieldVersionStateJson: '[]',
      causalMetadataJson: '{"crossDbCutId":"cut-1","schemaVersion":1}',
      genesisCoverageJson: '["base-1"]',
      deletionGenerationSummaryJson: '{"deleted":[],"generations":{},"schemaVersion":1}',
      contentHash: '',
      deletionSummaryJson: '[]',
      generationSummaryJson: '{}',
      blobManifestIndexJson: '[]',
      blobReferenceIndexJson: '[]'
    }
    const contentHash = snapshotShardContentHash(shard, SNAPSHOT_HASH_SCHEMA_VERSION)
    expect(contentHash).toBe('fa2a24f74e976676ba8374cc6b5bb8ece969a110e0df77c43744532df14af7fa')
    shard.contentHash = contentHash

    const bundle: SyncSnapshotBundleWire = {
      snapshotBundleId: 'snap-fixture',
      syncSpaceId: 'space-1',
      snapshotClass: 'WORKING',
      genesisBaselineId: 'base-1',
      rootHash: '',
      policyHash: 'policy-1',
      capturedAt: 123456789,
      shards: [shard],
      coverage: { ARTICLE_STATE: { 'actor-A': 4 } },
      hashSchemaVersion: 2,
      schemaVersion: 1,
      snapshotEpoch: 1,
      crossDbCutId: 'cut-1',
      requiredCoreShardIds: ['AUTH', 'CORE_META'],
      coverageCommitment: null,
      authStabilityCheckpoint: null,
      authorDeviceId: 'device-A',
      authorSignature: null
    }
    bundle.rootHash = snapshotRootHash(bundle)
    expect(bundle.rootHash).toBe('3b1cd419111a9f56233a6cef3677a21a654d9e94106f5d4d40ebc69799a43694')
    expect(sha256Hex(snapshotSigningMaterial(bundle)))
      .toBe('423d1f696383f65a01129b61b2d21d52a0767d5fe404ef9560da36876590b4f6')
    expect(() => assertSnapshotIntegrity(bundle)).not.toThrow()
  })
})
