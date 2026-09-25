import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { SyncCoverage, SyncSnapshotBundleWire, SyncSnapshotShardWire } from '../../shared/sync-protocol'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'

export const SNAPSHOT_HASH_SCHEMA_VERSION = 2
const SIGNING_DOMAIN = 'ORIGREAD_SNAPSHOT_V1'

export interface SnapshotShardDescriptor {
  replicationLaneId: string
  shardHash: string
  frontierByActorJson: string
}

export function snapshotSigningMaterial(snapshot: SyncSnapshotBundleWire): string {
  const { authorSignature: _authorSignature, ...manifest } = snapshot
  return SIGNING_DOMAIN + '\n' + canonicalJson(JSON.stringify(manifest))
}

export function snapshotCoverageCommitment(coverage: SyncCoverage): string {
  return sha256Hex(canonicalJson(JSON.stringify(normalizeCoverage(coverage))))
}

export function verifySnapshotSignature(snapshot: SyncSnapshotBundleWire, publicKeySpkiBase64: string): boolean {
  if (!snapshot.authorSignature) return false
  try {
    return cryptoVerify(
      'sha256',
      Buffer.from(snapshotSigningMaterial(snapshot), 'utf8'),
      createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(snapshot.authorSignature, 'base64')
    )
  } catch {
    return false
  }
}

export function snapshotShardContentHash(shard: SyncSnapshotShardWire, hashSchemaVersion = 1): string {
  if (hashSchemaVersion !== SNAPSHOT_HASH_SCHEMA_VERSION) {
    return sha256Hex([
      shard.frontierJson,
      shard.entityStateJson,
      shard.fieldVersionStateJson,
      shard.causalMetadataJson,
      shard.genesisCoverageJson,
      shard.deletionGenerationSummaryJson
    ].join('\n'))
  }
  if (shard.deletionSummaryJson == null || shard.generationSummaryJson == null ||
      shard.blobManifestIndexJson == null || shard.blobReferenceIndexJson == null) {
    throw new Error('SNAPSHOT_INCOMPATIBLE: rich shard merge metadata is incomplete')
  }
  const material = {
    replicationLaneId: shard.replicationLaneId,
    frontierByActorJson: shard.frontierJson,
    entityStateJson: shard.entityStateJson,
    fieldVersionStateJson: shard.fieldVersionStateJson,
    causalMergeMetadataJson: shard.causalMetadataJson,
    genesisCoverageJson: shard.genesisCoverageJson,
    deletionSummaryJson: shard.deletionSummaryJson,
    generationSummaryJson: shard.generationSummaryJson,
    blobManifestIndexJson: shard.blobManifestIndexJson,
    blobReferenceIndexJson: shard.blobReferenceIndexJson
  }
  return sha256Hex(canonicalJson(JSON.stringify(material)))
}

export function snapshotRootHash(snapshot: SyncSnapshotBundleWire): string {
  if ((snapshot.hashSchemaVersion ?? 1) !== SNAPSHOT_HASH_SCHEMA_VERSION) {
    const sorted = [...snapshot.shards].sort((a, b) => a.replicationLaneId.localeCompare(b.replicationLaneId))
    return sha256Hex(sorted.map((shard) => shard.contentHash).join('\n'))
  }
  if (!snapshot.crossDbCutId || !snapshot.requiredCoreShardIds?.length) {
    throw new Error('SNAPSHOT_INCOMPATIBLE: rich Snapshot manifest is incomplete')
  }
  const descriptors: SnapshotShardDescriptor[] = snapshot.shards
    .map((shard) => ({
      replicationLaneId: shard.replicationLaneId,
      shardHash: shard.contentHash,
      frontierByActorJson: shard.frontierJson
    }))
    .sort((a, b) => a.replicationLaneId.localeCompare(b.replicationLaneId))
  const material = {
    schemaVersion: snapshot.schemaVersion ?? 1,
    snapshotEpoch: snapshot.snapshotEpoch ?? 1,
    crossDbCutId: snapshot.crossDbCutId,
    replicationPolicyHash: snapshot.policyHash,
    requiredCoreShardIdsJson: canonicalJson(JSON.stringify([...snapshot.requiredCoreShardIds].sort())),
    shardDescriptorsJson: JSON.stringify(descriptors)
  }
  return sha256Hex(canonicalJson(JSON.stringify(material)))
}

export function snapshotCoverageFromShards(shards: SyncSnapshotShardWire[]): SyncCoverage {
  const result: SyncCoverage = {}
  for (const shard of shards) {
    const parsed = JSON.parse(shard.frontierJson) as unknown
    let actors: Record<string, number> = {}
    if (Array.isArray(parsed)) {
      const lane = parsed.find((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false
        return (row as Record<string, unknown>).replicationLaneId === shard.replicationLaneId
      }) as Record<string, unknown> | undefined
      if (lane?.actorFrontiers && typeof lane.actorFrontiers === 'object' && !Array.isArray(lane.actorFrontiers)) {
        const entries: Array<[string, number]> = []
        for (const [actor, value] of Object.entries(lane.actorFrontiers as Record<string, unknown>)) {
          const prefix = Number(value)
          if (actor.length > 0 && Number.isSafeInteger(prefix) && prefix > 0) entries.push([actor, prefix])
        }
        actors = Object.fromEntries(entries)
      }
    } else if (parsed && typeof parsed === 'object') {
      const entries: Array<[string, number]> = []
      for (const [actor, value] of Object.entries(parsed as Record<string, unknown>)) {
        const prefix = Number(value)
        if (actor.length > 0 && Number.isSafeInteger(prefix) && prefix > 0) entries.push([actor, prefix])
      }
      actors = Object.fromEntries(entries)
    }
    const normalizedActors = Object.fromEntries(Object.entries(actors).sort(([a], [b]) => a.localeCompare(b)))
    if (Object.keys(normalizedActors).length > 0) result[shard.replicationLaneId] = normalizedActors
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

export function assertSnapshotIntegrity(snapshot: SyncSnapshotBundleWire): void {
  const lanes = new Set<string>()
  for (const shard of snapshot.shards) {
    if (!shard.replicationLaneId || lanes.has(shard.replicationLaneId)) {
      throw new Error('SNAPSHOT_INCOMPATIBLE: Snapshot shards must have unique lanes')
    }
    lanes.add(shard.replicationLaneId)
    const expected = snapshotShardContentHash(shard, snapshot.hashSchemaVersion ?? 1)
    if (shard.contentHash !== expected) {
      throw new Error(
        'SNAPSHOT_CORRUPTED: shard hash mismatch for ' + shard.replicationLaneId +
        ': expected ' + expected + ', got ' + shard.contentHash
      )
    }
  }
  const expectedRoot = snapshotRootHash(snapshot)
  if (snapshot.rootHash !== expectedRoot) {
    throw new Error('SNAPSHOT_CORRUPTED: root hash mismatch: expected ' + expectedRoot + ', got ' + snapshot.rootHash)
  }
  if ((snapshot.hashSchemaVersion ?? 1) === SNAPSHOT_HASH_SCHEMA_VERSION) {
    const coverage = canonicalJson(JSON.stringify(snapshotCoverageFromShards(snapshot.shards)))
    const declared = canonicalJson(JSON.stringify(normalizeCoverage(snapshot.coverage)))
    if (coverage !== declared) throw new Error('SNAPSHOT_CORRUPTED: coverage does not match shard frontiers')
  }
}

function normalizeCoverage(coverage: SyncCoverage): SyncCoverage {
  return Object.fromEntries(
    Object.entries(coverage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lane, actors]) => [lane, Object.fromEntries(
        Object.entries(actors).filter(([, prefix]) => prefix > 0).sort(([a], [b]) => a.localeCompare(b))
      )] as const)
      .filter(([, actors]) => Object.keys(actors).length > 0)
  )
}
