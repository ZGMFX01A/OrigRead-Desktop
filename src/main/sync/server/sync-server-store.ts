import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  SyncBlobChunk,
  SyncBlobPersistedAck,
  SyncBlobStatus,
  SyncCoverage,
  SyncCoverageVector,
  SyncCursor,
  SyncOperationBatchResult,
  SyncOperationEnvelope,
  SyncOperationsPage,
  SyncAuthLedgerPage,
  SyncAuthProtocolObject,
  SyncPeerCapabilities,
  SyncSnapshotBundleWire,
  SyncStateVectorResponse,
  SyncRange,
  SyncReplicationPolicy
} from '../../../shared/sync-protocol'
import { SYNC_PROTOCOL_VERSION, emptySyncCoverageVector, coveragePrefix, normalizeSyncCoverage, coverageDominates, mergeSyncCoverage } from '../../../shared/sync-protocol'
import { canonicalJson, sha256Hex } from '../sync-operation-canonicalizer'
import { validateSyncOperationEnvelope, verifySyncOperationSignature } from '../sync-operation-wire'
import { canonicalAuthObjectContent, validateSyncAuthProtocolObject, verifySyncAuthSignature, verifyOwnerRecoveryProof, ownerRecoverySigningMaterial } from '../sync-auth-wire'
import { assertSnapshotIntegrity, snapshotSigningMaterial } from '../sync-snapshot-wire'

export class SyncServerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(`[${code}] ${message}`) }
}

export interface SyncServerStoreOptions {
  databasePath: string
  blobDirectory?: string
  serverEpoch?: string
}

export interface SyncServerMember {
  syncSpaceId: string
  deviceId: string
  publicKeySpkiBase64: string
  status: 'ACTIVE' | 'REVOKED'
  authEpoch: number
}

export const SYNC_SERVER_CAPABILITIES: SyncPeerCapabilities = {
  protocolVersions: [SYNC_PROTOCOL_VERSION],
  replicationLanes: ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH'],
  snapshotClasses: ['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'],
  blobTransfer: true,
  maxOperationBatch: 500,
  maxBlobChunkBytes: 4 * 1024 * 1024,
  supportsRangeResume: true
}

export class SyncServerStore {
  readonly database: DatabaseSync
  readonly blobDirectory: string
  serverEpoch: string
  readonly serverReplicaId: string

  constructor(options: SyncServerStoreOptions) {
    if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true })
    this.database = new DatabaseSync(options.databasePath)
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    this.blobDirectory = options.blobDirectory ?? (options.databasePath === ':memory:' ? join(process.cwd(), '.sync-blobs') : join(dirname(options.databasePath), 'blobs'))
    mkdirSync(this.blobDirectory, { recursive: true })
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sync_server_members (
        sync_space_id TEXT NOT NULL, device_id TEXT NOT NULL, public_key_spki_base64 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')), auth_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY(sync_space_id,device_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_server_auth_objects (
        auth_object_id TEXT PRIMARY KEY, sync_space_id TEXT NOT NULL, auth_epoch INTEGER NOT NULL,
        auth_sequence INTEGER NOT NULL DEFAULT 0,
        object_type TEXT NOT NULL, author_device_id TEXT NOT NULL, owner_device_id TEXT NOT NULL,
        target_device_id TEXT, previous_epoch_final_accepted_prefix_json TEXT NOT NULL,
        revoke_cutoff_json TEXT, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        signing_digest TEXT NOT NULL, author_signature TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_server_auth_objects_space_seq_idx
        ON sync_server_auth_objects(sync_space_id,auth_sequence);
      CREATE INDEX IF NOT EXISTS sync_server_auth_objects_space_epoch_idx
        ON sync_server_auth_objects(sync_space_id,auth_epoch,created_at);
      CREATE TABLE IF NOT EXISTS sync_server_operations (
        log_offset INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, sync_space_id TEXT NOT NULL,
        actor_incarnation_id TEXT NOT NULL, replication_lane_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ACCEPTED','REJECTED')), rejection_digest TEXT,
        operation_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(actor_incarnation_id,replication_lane_id,sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_server_operations_space_lane_actor_idx
        ON sync_server_operations(sync_space_id,replication_lane_id,actor_incarnation_id,sequence);
      CREATE TABLE IF NOT EXISTS sync_server_snapshots (
        snapshot_bundle_id TEXT PRIMARY KEY, sync_space_id TEXT NOT NULL, snapshot_class TEXT NOT NULL,
        captured_at INTEGER NOT NULL, root_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_server_snapshots_space_class_idx
        ON sync_server_snapshots(sync_space_id,snapshot_class,captured_at DESC);
      CREATE TABLE IF NOT EXISTS sync_server_snapshot_state (
        snapshot_bundle_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('CANDIDATE','ACCEPTED')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_server_peer_coverage (
        sync_space_id TEXT NOT NULL, device_id TEXT NOT NULL, coverage_kind TEXT NOT NULL,
        coverage_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(sync_space_id,device_id,coverage_kind)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_server_blob_manifest (
        hash TEXT PRIMARY KEY, expected_bytes INTEGER NOT NULL, received_bytes INTEGER NOT NULL,
        complete INTEGER NOT NULL CHECK(complete IN (0,1)), updated_at INTEGER NOT NULL
      ) STRICT;
    `)
    try {
      this.database.exec('ALTER TABLE sync_server_auth_objects ADD COLUMN auth_sequence INTEGER NOT NULL DEFAULT 0')
    } catch {
      // 忽略已存在列时的异常
    }
    const persistedEpoch = this.database.prepare('SELECT value FROM sync_server_meta WHERE key=\'server_epoch\'').get() as { value: string } | undefined
    this.serverEpoch = persistedEpoch?.value ?? options.serverEpoch ?? randomUUID()
    this.database.prepare(`INSERT INTO sync_server_meta(key,value) VALUES('server_epoch',?) ON CONFLICT(key) DO NOTHING`).run(this.serverEpoch)
    const persistedReplica = this.database.prepare('SELECT value FROM sync_server_meta WHERE key=\'server_replica_id\'').get() as { value: string } | undefined
    this.serverReplicaId = persistedReplica?.value ?? `server:${randomUUID()}`
    this.database.prepare(`INSERT INTO sync_server_meta(key,value) VALUES('server_replica_id',?) ON CONFLICT(key) DO NOTHING`).run(this.serverReplicaId)
  }

  close(): void { if (this.database.isOpen) this.database.close() }

  /** Atomically starts a new transport history generation after a restore/rewind event. */
  rewindHistory(): SyncCursor {
    const nextEpoch = randomUUID()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('UPDATE sync_server_meta SET value=? WHERE key=\'server_epoch\'').run(nextEpoch)
      this.database.exec('COMMIT')
      this.serverEpoch = nextEpoch
      return this.currentCursor()
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  }

  registerMember(member: SyncServerMember): void {
    const existing = this.findMember(member.syncSpaceId, member.deviceId)
    if (existing && existing.publicKeySpkiBase64 !== member.publicKeySpkiBase64) throw new SyncServerError(409, 'AUTH_KEY_COLLISION', 'Device public key cannot be replaced')
    this.database.prepare(`
      INSERT INTO sync_server_members(sync_space_id,device_id,public_key_spki_base64,status,auth_epoch,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,device_id) DO UPDATE SET status=excluded.status,auth_epoch=excluded.auth_epoch,updated_at=excluded.updated_at
    `).run(member.syncSpaceId, member.deviceId, member.publicKeySpkiBase64, member.status, member.authEpoch, Date.now())
  }

  revokeMember(syncSpaceId: string, deviceId: string, authEpoch: number): void {
    const existing = this.findMember(syncSpaceId, deviceId)
    if (!existing) throw new SyncServerError(404, 'AUTH_UNKNOWN_DEVICE', `Unknown device ${deviceId}`)
    this.database.prepare(`UPDATE sync_server_members SET status='REVOKED',auth_epoch=?,updated_at=? WHERE sync_space_id=? AND device_id=?`)
      .run(authEpoch, Date.now(), syncSpaceId, deviceId)
  }

  findMember(syncSpaceId: string, deviceId: string): SyncServerMember | null {
    const row = this.database.prepare('SELECT * FROM sync_server_members WHERE sync_space_id=? AND device_id=? LIMIT 1').get(syncSpaceId, deviceId) as Record<string, unknown> | undefined
    return row ? {
      syncSpaceId: String(row.sync_space_id), deviceId: String(row.device_id), publicKeySpkiBase64: String(row.public_key_spki_base64),
      status: String(row.status) as SyncServerMember['status'], authEpoch: Number(row.auth_epoch)
    } : null
  }

  authLedger(syncSpaceId: string): SyncAuthLedgerPage {
    const rows = this.database.prepare(`
      SELECT * FROM sync_server_auth_objects
      WHERE sync_space_id=? ORDER BY auth_epoch ASC, auth_sequence ASC
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    const objects = rows.map(authObjectFromRow)
    const owner = objects.length === 0 ? null : objects[objects.length - 1]!.ownerDeviceId
    const epoch = objects.length === 0 ? 0 : objects[objects.length - 1]!.authEpoch
    const checkpoint = [...objects].reverse().find((object) => object.objectType === 'AUTH_STABILITY_CHECKPOINT')
    return { objects, authEpoch: epoch, ownerDeviceId: owner, authStabilityCheckpointId: checkpoint?.authObjectId ?? null }
  }

  appendAuthObjects(syncSpaceId: string, objects: SyncAuthProtocolObject[]): SyncAuthLedgerPage {
    if (objects.length === 0) return this.authLedger(syncSpaceId)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const object of [...objects].sort((a, b) => a.authEpoch - b.authEpoch || (a.authSequence ?? 0) - (b.authSequence ?? 0))) this.appendAuthObject(syncSpaceId, object)
      this.database.exec('COMMIT')
      return this.authLedger(syncSpaceId)
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* preserve original validation error */ }
      throw error
    }
  }

  private appendAuthObject(syncSpaceId: string, object: SyncAuthProtocolObject): void {
    validateSyncAuthProtocolObject(object)
    if (object.syncSpaceId !== syncSpaceId) throw new SyncServerError(400, 'AUTH_SPACE_MISMATCH', 'AUTH object Sync Space does not match endpoint')
    const existingRow = this.database.prepare('SELECT * FROM sync_server_auth_objects WHERE auth_object_id=?').get(object.authObjectId) as Record<string, unknown> | undefined
    if (existingRow) {
      const existing = authObjectFromRow(existingRow)
      if (canonicalAuthObjectContent(existing) !== canonicalAuthObjectContent(object)) throw new SyncServerError(409, 'AUTH_COLLISION', 'AUTH object identity differs from stored history')
      return
    }

    const member = this.findMember(syncSpaceId, object.authorDeviceId)
    if (!member || member.status !== 'ACTIVE') throw new SyncServerError(403, 'AUTH_FAILED', 'AUTH object author is not an active member')
    if (!verifySyncAuthSignature(object, member.publicKeySpkiBase64)) throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', 'AUTH object signature verification failed')

    const current = this.authLedger(syncSpaceId)
    const currentObjects = current.objects
    if (currentObjects.some((prior) => prior.authEpoch === object.authEpoch && (prior.authSequence ?? 0) === (object.authSequence ?? 0))) {
      throw new SyncServerError(409, 'AUTH_COLLISION', 'Conflicting AUTH object at the same epoch and sequence')
    }
    const expectedSequence = currentObjects.length === 0 || object.authEpoch > current.authEpoch ? 0 : (currentObjects.at(-1)!.authSequence ?? 0) + 1
    if ((object.authSequence ?? 0) !== expectedSequence) {
      throw new SyncServerError(409, 'AUTH_SEQUENCE_GAP', `Expected authSequence ${expectedSequence}, got ${object.authSequence}`)
    }

    if (currentObjects.length === 0) {
      if (object.objectType !== 'SPACE_ROOT' || object.authEpoch !== 0 || object.authorDeviceId !== object.ownerDeviceId || object.previousEpochFinalAcceptedPrefixByActorLane && Object.keys(object.previousEpochFinalAcceptedPrefixByActorLane).length > 0) {
        throw new SyncServerError(409, 'AUTH_EPOCH_CONFLICT', 'The first AUTH object must be a single-owner SPACE_ROOT at epoch 0')
      }
      const root = parseAuthPayload(object.payloadJson)
      if ((root.ownerPublicKeySpkiBase64 ?? root.publicKeySpkiBase64) !== member.publicKeySpkiBase64) {
        throw new SyncServerError(403, 'AUTH_FAILED', 'Space root must bind the confirmed owner key')
      }
      this.insertAuthObject(object)
      return
    }

    const owner = current.ownerDeviceId
    if (object.objectType === 'SPACE_ROOT') throw new SyncServerError(403, 'AUTH_FAILED', 'Space root is immutable')
    if (!owner) throw new SyncServerError(409, 'AUTH_EPOCH_CONFLICT', 'AUTH history has no current owner')
    const acceptedCoverage = this.acceptedCoverage(syncSpaceId)
    const payload = parseAuthPayload(object.payloadJson)
    const transition = object.objectType === 'OWNER_TRANSFER' || object.objectType === 'OWNER_RECOVERY'
    if (transition) {
      if (object.authEpoch !== current.authEpoch + 1) throw new SyncServerError(409, 'AUTH_EPOCH_CONFLICT', 'Owner epoch must advance exactly once')
      if (object.previousEpochFinalAcceptedPrefixByActorLane && !coverageEquals(object.previousEpochFinalAcceptedPrefixByActorLane, acceptedCoverage)) {
        throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Owner epoch transition must carry the current accepted coverage cut')
      }
      const target = this.requireTarget(object)
      if (object.ownerDeviceId !== target) throw new SyncServerError(403, 'AUTH_FAILED', 'New owner must match targetDeviceId')
      if (object.objectType === 'OWNER_TRANSFER' && object.authorDeviceId !== owner) {
        throw new SyncServerError(403, 'AUTH_FAILED', 'Only the current owner can transfer ownership')
      }
      if (object.objectType === 'OWNER_RECOVERY') {
        const recoveryProof = nonBlankString(payload.recoveryProof)
        if (!recoveryProof) {
          throw new SyncServerError(403, 'AUTH_FAILED', 'Owner recovery requires a recovery proof when the old owner is unavailable')
        }
        const spaceRoot = this.authLedger(syncSpaceId).objects[0]
        const spaceRootPayload = spaceRoot ? parseAuthPayload(spaceRoot.payloadJson) : {}
        const rootKey = nonBlankString(spaceRootPayload.spaceRootPublicKey)
        if (!rootKey) {
          throw new SyncServerError(500, 'AUTH_FAILED', 'Cannot resolve SpaceRoot public key for recovery validation')
        }
        const validProof = verifyOwnerRecoveryProof(
          syncSpaceId,
          object.authEpoch,
          target,
          object.previousEpochFinalAcceptedPrefixByActorLane,
          recoveryProof,
          rootKey
        )
        if (!validProof) {
          throw new SyncServerError(403, 'AUTH_FAILED', 'Invalid OWNER_RECOVERY cryptographic proof signature')
        }
      }
      const targetMember = this.findMember(syncSpaceId, target)
      if (!targetMember || targetMember.status !== 'ACTIVE') throw new SyncServerError(409, 'AUTH_UNKNOWN_DEVICE', 'New owner must already be an active member')
      if (payload.publicKeySpkiBase64 !== targetMember.publicKeySpkiBase64) throw new SyncServerError(403, 'AUTH_FAILED', 'Transition must bind the new owner key')
      if (object.objectType === 'OWNER_TRANSFER') {
        const acceptance = nonBlankString(payload.ownerAcceptanceSignature)
        const material = ownerRecoverySigningMaterial(syncSpaceId, object.authEpoch, target, object.previousEpochFinalAcceptedPrefixByActorLane)
          .replace('ORIGREAD_OWNER_RECOVERY_PROOF_V1', 'ORIGREAD_OWNER_TRANSFER_ACCEPTANCE_V1')
        if (!acceptance || !cryptoVerify('sha256', Buffer.from(material), createPublicKey({ key: Buffer.from(targetMember.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(acceptance, 'base64'))) {
          throw new SyncServerError(403, 'AUTH_FAILED', 'OWNER_TRANSFER requires the new owner acceptance signature')
        }
      }
      this.insertAuthObject(object)
      return
    }

    if (object.authEpoch !== current.authEpoch || object.ownerDeviceId !== owner || object.authorDeviceId !== owner) {
      throw new SyncServerError(403, 'AUTH_FAILED', 'Only the current owner may mutate the current AUTH epoch')
    }
    if (Object.keys(object.previousEpochFinalAcceptedPrefixByActorLane).length > 0) {
      throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Same-epoch AUTH objects cannot carry a previous-epoch cut')
    }

    if (object.objectType === 'MEMBER_GRANT') {
      const target = this.requireTarget(object)
      const publicKey = nonBlankString(payload.publicKeySpkiBase64)
      if (!publicKey) throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', 'MEMBER_GRANT payload must contain a public key')
      const existing = this.findMember(syncSpaceId, target)
      if (existing && existing.publicKeySpkiBase64 !== publicKey) throw new SyncServerError(409, 'AUTH_KEY_COLLISION', 'Granted device public key cannot be replaced')
      this.insertAuthObject(object)
      this.upsertMember({ syncSpaceId, deviceId: target, publicKeySpkiBase64: publicKey, status: 'ACTIVE', authEpoch: current.authEpoch })
      return
    }

    if (object.objectType === 'MEMBER_REVOKE') {
      const target = this.requireTarget(object)
      const existing = this.findMember(syncSpaceId, target)
      if (!existing) throw new SyncServerError(404, 'AUTH_UNKNOWN_DEVICE', `Unknown device ${target}`)
      const cutoff = object.revokeCutoffByActorLane ?? {}
      if (!coverageDominates(acceptedCoverage, cutoff)) throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Revoke cutoff cannot exceed accepted coverage')
      const stable = this.latestAuthStabilityCoverage(syncSpaceId)
      const targetStable = this.coverageForAuthor(syncSpaceId, target, stable)
      if (!coverageDominates(cutoff, targetStable)) {
        throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Revoke cutoff cannot cross stable authorized history')
      }
      this.insertAuthObject(object)
      this.database.prepare('UPDATE sync_server_members SET status=\'REVOKED\',auth_epoch=?,updated_at=? WHERE sync_space_id=? AND device_id=?')
        .run(current.authEpoch, Date.now(), syncSpaceId, target)
      return
    }

    if (object.objectType === 'AUTH_STABILITY_CHECKPOINT') {
      const stable = parseCoverage(payload.acceptedPrefixByActorLane)
      if (!coverageDominates(acceptedCoverage, stable)) throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Stability checkpoint cannot exceed accepted coverage')
      const previousStable = this.latestAuthStabilityCoverage(syncSpaceId)
      if (!coverageDominates(stable, previousStable)) {
        throw new SyncServerError(409, 'AUTH_CUT_MISMATCH', 'Stability checkpoint cannot move backwards')
      }
      this.insertAuthObject(object)
      return
    }

    throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', `Unsupported AUTH mutation ${object.objectType}`)
  }

  private insertAuthObject(object: SyncAuthProtocolObject): void {
    this.database.prepare(`
      INSERT INTO sync_server_auth_objects(
        auth_object_id,sync_space_id,auth_epoch,auth_sequence,object_type,author_device_id,owner_device_id,target_device_id,
        previous_epoch_final_accepted_prefix_json,revoke_cutoff_json,payload_json,payload_hash,signing_digest,author_signature,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      object.authObjectId, object.syncSpaceId, object.authEpoch, object.authSequence ?? 0, object.objectType, object.authorDeviceId, object.ownerDeviceId,
      object.targetDeviceId ?? null, canonicalJson(JSON.stringify(object.previousEpochFinalAcceptedPrefixByActorLane)),
      object.revokeCutoffByActorLane == null ? null : canonicalJson(JSON.stringify(object.revokeCutoffByActorLane)),
      object.payloadJson, object.payloadHash, object.signingDigest, object.authorSignature, Date.now(),
    )
  }

  private upsertMember(member: SyncServerMember): void {
    this.database.prepare(`
      INSERT INTO sync_server_members(sync_space_id,device_id,public_key_spki_base64,status,auth_epoch,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,device_id) DO UPDATE SET public_key_spki_base64=excluded.public_key_spki_base64,status=excluded.status,auth_epoch=excluded.auth_epoch,updated_at=excluded.updated_at
    `).run(member.syncSpaceId, member.deviceId, member.publicKeySpkiBase64, member.status, member.authEpoch, Date.now())
  }

  private requireTarget(object: SyncAuthProtocolObject): string {
    if (!object.targetDeviceId?.trim()) throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', `${object.objectType} requires targetDeviceId`)
    return object.targetDeviceId
  }

  private operationRejectionDigest(syncSpaceId: string, operation: SyncOperationEnvelope, member: SyncServerMember): string | null {
    const ledger = this.authLedger(syncSpaceId)
    if (ledger.objects.length === 0) {
      return member.status === 'REVOKED' || (operation.authEpoch != null && operation.authEpoch < member.authEpoch)
        ? `rejected:${operation.operationId}:${member.authEpoch}`
        : null
    }
    if (operation.authEpoch == null) return `rejected:${operation.operationId}:missing-auth-epoch`

    const grantIndex = ledger.objects.findIndex((object) => object.authObjectId === operation.authGrantId ||
      (!operation.authGrantId && object.objectType === 'SPACE_ROOT' && object.ownerDeviceId === operation.authorDeviceId))
    const grant = ledger.objects[grantIndex]
    if (!grant || !['SPACE_ROOT', 'MEMBER_GRANT', 'OWNER_TRANSFER', 'OWNER_RECOVERY'].includes(grant.objectType) ||
      (grant.objectType === 'SPACE_ROOT' ? grant.ownerDeviceId : grant.targetDeviceId) !== operation.authorDeviceId ||
      grant.authEpoch > operation.authEpoch) return `rejected:${operation.operationId}:invalid-auth-grant`
    const transitions = ledger.objects.filter((object) => object.objectType === 'OWNER_TRANSFER' || object.objectType === 'OWNER_RECOVERY')
    const stableAuthorized = ledger.objects.slice(grantIndex + 1).some((object) => {
      if (object.objectType !== 'AUTH_STABILITY_CHECKPOINT') return false
      const stable = parseCoverage(parseAuthPayload(object.payloadJson).acceptedPrefixByActorLane)
      return coveragePrefix(stable, operation.replicationLaneId, operation.actorIncarnationId) >= operation.sequence
    })
    // A later grant does not restore an earlier grant's revoked tail.
    for (const object of ledger.objects.slice(grantIndex + 1)) {
      if (object.objectType === 'MEMBER_REVOKE' && object.targetDeviceId === operation.authorDeviceId &&
        !stableAuthorized &&
        operation.sequence > coveragePrefix(object.revokeCutoffByActorLane ?? {}, operation.replicationLaneId, operation.actorIncarnationId)) {
        return `rejected:${operation.operationId}:revoke-cutoff`
      }
    }
    for (const transition of transitions) {
      if (operation.authEpoch < transition.authEpoch && operation.sequence > coveragePrefix(
        transition.previousEpochFinalAcceptedPrefixByActorLane,
        operation.replicationLaneId,
        operation.actorIncarnationId,
      )) return `rejected:${operation.operationId}:epoch-${transition.authEpoch}-cut`
    }
    if (operation.authEpoch > ledger.authEpoch) return `rejected:${operation.operationId}:future-auth-epoch`
    return null
  }

  private operationRejectionCode(
    operation: SyncOperationEnvelope,
    member: SyncServerMember,
    rejectionDigest: string
  ): 'AUTH_REVOKED' | 'AUTH_EPOCH_CUT' | 'AUTH_FAILED' {
    if (rejectionDigest.includes(':revoke-cutoff') || member.status === 'REVOKED') return 'AUTH_REVOKED'
    if (rejectionDigest.includes(':epoch-') || (operation.authEpoch != null && operation.authEpoch < member.authEpoch)) {
      return 'AUTH_EPOCH_CUT'
    }
    return 'AUTH_FAILED'
  }

  private acceptedCoverage(syncSpaceId: string): SyncCoverage {
    const result: SyncCoverage = {}
    const rows = this.database.prepare(`
      SELECT replication_lane_id,actor_incarnation_id,sequence FROM sync_server_operations
      WHERE sync_space_id=? AND state='ACCEPTED' ORDER BY replication_lane_id,actor_incarnation_id,sequence
    `).all(syncSpaceId) as unknown as Array<{ replication_lane_id: string; actor_incarnation_id: string; sequence: number }>
    for (const row of rows) {
      const lane = row.replication_lane_id
      const actor = row.actor_incarnation_id
      const current = coveragePrefix(result, lane, actor)
      if (row.sequence === current + 1) {
        result[lane] ??= {}
        result[lane]![actor] = row.sequence
      }
    }
    return result
  }

  private latestAuthStabilityCoverage(syncSpaceId: string): SyncCoverage {
    const checkpoint = [...this.authLedger(syncSpaceId).objects]
      .reverse()
      .find((object) => object.objectType === 'AUTH_STABILITY_CHECKPOINT')
    if (!checkpoint) return {}
    return parseCoverage(parseAuthPayload(checkpoint.payloadJson).acceptedPrefixByActorLane)
  }

  private coverageForAuthor(syncSpaceId: string, deviceId: string, coverage: SyncCoverage): SyncCoverage {
    const actors = this.database.prepare(`
      SELECT replication_lane_id,actor_incarnation_id,operation_json
      FROM sync_server_operations
      WHERE sync_space_id=?
      ORDER BY replication_lane_id,actor_incarnation_id,sequence
    `).all(syncSpaceId) as unknown as Array<{ replication_lane_id: string; actor_incarnation_id: string; operation_json: string }>
    const authorActors = new Set(
      actors
        .filter((row) => {
          try {
            return (JSON.parse(row.operation_json) as SyncOperationEnvelope).authorDeviceId === deviceId
          } catch {
            return false
          }
        })
        .map((row) => `${row.replication_lane_id}\u0000${row.actor_incarnation_id}`)
    )
    const result: SyncCoverage = {}
    for (const row of actors) {
      if (!authorActors.has(`${row.replication_lane_id}\u0000${row.actor_incarnation_id}`)) continue
      const prefix = coverage[row.replication_lane_id]?.[row.actor_incarnation_id] ?? 0
      if (prefix <= 0) continue
      result[row.replication_lane_id] ??= {}
      result[row.replication_lane_id]![row.actor_incarnation_id] = prefix
    }
    return result
  }

  state(syncSpaceId: string): SyncStateVectorResponse {
    return { coverage: this.coverage(syncSpaceId), policyByLane: defaultPolicies(), serverCursor: this.currentCursor() }
  }

  putOperations(syncSpaceId: string, operations: SyncOperationEnvelope[]): SyncOperationBatchResult {
    const acceptedOperationIds: string[] = []
    const duplicateOperationIds: string[] = []
    const rejected: SyncOperationBatchResult['rejected'] = []
    for (const operation of operations) {
      try {
        validateSyncOperationEnvelope(operation)
        if (operation.syncSpaceId !== syncSpaceId) throw new SyncServerError(400, 'INVALID_OPERATION', 'Operation Sync Space does not match endpoint')
        if (defaultPolicies()[operation.replicationLaneId] !== 'ENABLED') {
          throw new SyncServerError(409, 'PAUSED_LANE', `Replication lane ${operation.replicationLaneId} is paused by server policy`)
        }
        const member = this.findMember(syncSpaceId, operation.authorDeviceId)
        if (!member) throw new SyncServerError(403, 'AUTH_FAILED', 'Author device is not a registered member')
        if (!verifySyncOperationSignature(operation, member.publicKeySpkiBase64)) throw new SyncServerError(400, 'INVALID_OPERATION', 'Author signature verification failed')
        const canonical = canonicalOperationJson(operation)
        const existing = this.database.prepare('SELECT * FROM sync_server_operations WHERE operation_id=?').get(operation.operationId) as Record<string, unknown> | undefined
        const dot = this.database.prepare('SELECT * FROM sync_server_operations WHERE actor_incarnation_id=? AND replication_lane_id=? AND sequence=?').get(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence) as Record<string, unknown> | undefined
        if (existing || dot) {
          const same = String((existing ?? dot)!.operation_json) === canonical
          if (!same) throw new SyncServerError(409, 'DOT_COLLISION', 'Immutable Dot differs from stored operation')
          duplicateOperationIds.push(operation.operationId)
          continue
        }
        const rejectionDigest = this.operationRejectionDigest(syncSpaceId, operation, member)
        const revoked = rejectionDigest != null
        this.database.prepare(`
          INSERT INTO sync_server_operations(
            operation_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,state,rejection_digest,operation_json,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?)
        `).run(operation.operationId, syncSpaceId, operation.actorIncarnationId, operation.replicationLaneId, operation.sequence, revoked ? 'REJECTED' : 'ACCEPTED', rejectionDigest, canonical, Date.now())
        if (revoked) {
          const code = this.operationRejectionCode(operation, member, rejectionDigest!)
          rejected.push({
            operationId: operation.operationId,
            code,
            message: code === 'AUTH_REVOKED'
              ? 'Operation is outside the accepted member revoke cutoff'
              : code === 'AUTH_EPOCH_CUT'
                ? 'Operation is outside the accepted owner epoch cutoff'
                : 'Operation has invalid or stale authorization',
            rejectionDigest: rejectionDigest!
          })
        } else acceptedOperationIds.push(operation.operationId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof SyncServerError ? error.code : message.includes('AUTH') ? 'AUTH_FAILED' : 'INVALID_OPERATION'
        rejected.push({ operationId: typeof operation?.operationId === 'string' ? operation.operationId : null, code, message })
      }
    }
    return { acceptedOperationIds, duplicateOperationIds, rejected, coverage: this.coverage(syncSpaceId), serverCursor: this.currentCursor() }
  }

  requestOperations(syncSpaceId: string, ranges: SyncRange[], cursor?: SyncCursor | null, limit = 500): SyncOperationsPage {
    if (cursor && cursor.serverEpoch !== this.serverEpoch) throw new SyncServerError(409, 'SERVER_HISTORY_REWIND', 'Cursor belongs to a previous server history epoch')
    if (cursor) {
      if (!this.isCursorValid(cursor)) {
        throw new SyncServerError(409, 'CURSOR_REWIND', 'Cursor no longer matches the retained server history')
      }
    }
    const operations: SyncOperationEnvelope[] = []
    for (const range of ranges) {
      if (defaultPolicies()[range.replicationLaneId] !== 'ENABLED') continue
      if (range.fromSequence <= 0 || range.toSequence < range.fromSequence) throw new SyncServerError(400, 'INVALID_RANGE', 'Invalid operation range')
      const rows = this.database.prepare(`
        SELECT operation_json FROM sync_server_operations
        WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=?
          AND state = 'ACCEPTED'
          AND sequence BETWEEN ? AND ?
        ORDER BY sequence LIMIT ?
      `).all(syncSpaceId, range.actorIncarnationId, range.replicationLaneId, range.fromSequence, range.toSequence, Math.max(0, limit - operations.length)) as unknown as Array<{ operation_json: string }>
      for (const row of rows) {
        if (operations.length >= limit) break
        operations.push(JSON.parse(row.operation_json) as SyncOperationEnvelope)
      }
      if (operations.length >= limit) break
    }
    return { operations, nextCursor: null, coverage: this.coverage(syncSpaceId), serverCursor: this.currentCursor() }
  }

  /** Prunes server operations strictly dominated by the given coverage (e.g. after GC_BASELINE snapshot promotion). */
  pruneOperations(syncSpaceId: string, beforeCoverage: SyncCoverage): number {
    normalizeSyncCoverage(beforeCoverage)
    // A caller-provided frontier is not evidence of a stable, recoverable baseline.
    throw new SyncServerError(409, 'GC_UNSAFE', `Verified recovery and Blob retention proofs are required before pruning ${syncSpaceId}`)
  }

  putSnapshot(snapshot: SyncSnapshotBundleWire): void {
    if (!snapshot.snapshotBundleId.trim() || !snapshot.syncSpaceId.trim() || !snapshot.rootHash.trim() || !snapshot.policyHash.trim()) {
      throw new SyncServerError(400, 'SNAPSHOT_INCOMPATIBLE', 'Snapshot manifest is missing an identity or commitment')
    }
    if (!['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'].includes(snapshot.snapshotClass)) {
      throw new SyncServerError(400, 'SNAPSHOT_INCOMPATIBLE', 'Unknown Snapshot class')
    }
    const lanes = new Set<string>()
    for (const shard of snapshot.shards) {
      if (!shard.replicationLaneId || lanes.has(shard.replicationLaneId) || !shard.contentHash?.trim()) {
        throw new SyncServerError(400, 'SNAPSHOT_INCOMPATIBLE', 'Snapshot shards must have unique lanes and hashes')
      }
      lanes.add(shard.replicationLaneId)

      if (defaultPolicies()[shard.replicationLaneId] !== 'ENABLED' ||
        [shard.frontierJson, shard.entityStateJson, shard.fieldVersionStateJson,
          shard.causalMetadataJson, shard.genesisCoverageJson, shard.deletionGenerationSummaryJson]
          .some((value) => typeof value !== 'string')) {
        throw new SyncServerError(400, 'SNAPSHOT_INCOMPATIBLE', 'Snapshot requires complete enabled shard payloads')
      }
    }

    try {
      assertSnapshotIntegrity(snapshot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message.includes('CORRUPTED') ? 'SNAPSHOT_CORRUPTED' : 'SNAPSHOT_INCOMPATIBLE'
      throw new SyncServerError(400, code, message)
    }

    if (!snapshot.authorDeviceId || !snapshot.authorSignature) {
      throw new SyncServerError(403, 'AUTH_FAILED', 'Snapshot requires an author signature')
    }
    const authorMember = this.findMember(snapshot.syncSpaceId, snapshot.authorDeviceId)
    if (!authorMember || authorMember.status !== 'ACTIVE') {
      throw new SyncServerError(403, 'AUTH_FAILED', 'Snapshot author is not an active member')
    }
    const authorSignature = snapshot.authorSignature
    const signingMaterial = snapshotSigningMaterial(snapshot)
    if (!cryptoVerify('sha256', Buffer.from(signingMaterial),
      createPublicKey({ key: Buffer.from(authorMember.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(authorSignature, 'base64'))) {
      throw new SyncServerError(400, 'SNAPSHOT_CORRUPTED', 'Snapshot author signature verification failed')
    }
    const retained = this.coverage(snapshot.syncSpaceId).retained
    const enabledCoverage = filterCoverageByPolicy(normalizeSyncCoverage(snapshot.coverage), defaultPolicies())
    let state: 'CANDIDATE' | 'ACCEPTED' = 'ACCEPTED'
    if (snapshot.snapshotClass === 'WORKING') {
      if (!coverageDominates(retained, enabledCoverage)) {
        throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Normal Snapshot coverage exceeds the server retained history')
      }
    } else {
      const ledger = this.authLedger(snapshot.syncSpaceId)
      if (!snapshot.authStabilityCheckpoint ||
        snapshot.authStabilityCheckpoint !== ledger.authStabilityCheckpointId) {
        throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Stable/Recovery Snapshot must reference the current AuthStabilityCheckpoint')
      }
      const checkpoint = ledger.objects.find((object) => object.authObjectId === snapshot.authStabilityCheckpoint)
      if (!checkpoint || checkpoint.objectType !== 'AUTH_STABILITY_CHECKPOINT') {
        throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Referenced AuthStabilityCheckpoint is unavailable')
      }
      const checkpointCoverage = parseCoverage(parseAuthPayload(checkpoint.payloadJson).acceptedPrefixByActorLane)
      if (!coverageDominates(checkpointCoverage, enabledCoverage)) {
        throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Snapshot coverage exceeds stable authorized history')
      }
      if (snapshot.snapshotClass === 'GC_BASELINE') {
        if (!coverageDominates(retained, enabledCoverage)) {
          throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'GC baseline cannot claim history the server has never retained')
        }
      } else {
        const expectedCommitment = sha256Hex(canonicalJson(JSON.stringify(enabledCoverage)))
        if (!snapshot.coverageCommitment || snapshot.coverageCommitment !== expectedCommitment) {
          throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Bootstrap recovery coverage commitment is missing or invalid')
        }
        state = 'CANDIDATE'
      }
    }
    const canonical = canonicalJson(JSON.stringify(snapshot))

    // Snapshot Identity 不可变性校验（R12-08）：严禁任何篡改或覆盖已有同 ID 快照
    const existing = this.database.prepare('SELECT root_hash, snapshot_json FROM sync_server_snapshots WHERE snapshot_bundle_id=? LIMIT 1')
      .get(snapshot.snapshotBundleId) as { root_hash: string; snapshot_json: string } | undefined
    if (existing) {
      if (existing.root_hash !== snapshot.rootHash || existing.snapshot_json !== canonical) {
        throw new SyncServerError(409, 'SNAPSHOT_COLLISION', 'Snapshot identity is immutable and differs from stored snapshot')
      }
      return
    }

    this.database.prepare(`
      INSERT INTO sync_server_snapshots(snapshot_bundle_id,sync_space_id,snapshot_class,captured_at,root_hash,snapshot_json,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(snapshot.snapshotBundleId, snapshot.syncSpaceId, snapshot.snapshotClass, snapshot.capturedAt, snapshot.rootHash, canonical, Date.now())
    this.database.prepare(`
      INSERT INTO sync_server_snapshot_state(snapshot_bundle_id,state,updated_at) VALUES(?,?,?)
    `).run(snapshot.snapshotBundleId, state, Date.now())
  }

  promoteRecoverySnapshot(syncSpaceId: string, snapshotBundleId: string, acceptance: SyncAuthProtocolObject): void {
    const row = this.database.prepare('SELECT snapshot_class FROM sync_server_snapshots WHERE sync_space_id=? AND snapshot_bundle_id=? LIMIT 1').get(syncSpaceId, snapshotBundleId) as { snapshot_class: string } | undefined
    if (!row || row.snapshot_class !== 'BOOTSTRAP_RECOVERY') throw new SyncServerError(404, 'SNAPSHOT_INCOMPATIBLE', 'Recovery Snapshot candidate was not found')
    validateSyncAuthProtocolObject(acceptance)
    if (acceptance.syncSpaceId !== syncSpaceId || acceptance.objectType !== 'AUTH_STABILITY_CHECKPOINT') throw new SyncServerError(400, 'SNAPSHOT_INCOMPATIBLE', 'Recovery acceptance must be an AUTH stability checkpoint')
    const ledger = this.authLedger(syncSpaceId)
    if (acceptance.authorDeviceId !== ledger.ownerDeviceId || acceptance.authObjectId !== ledger.authStabilityCheckpointId) throw new SyncServerError(403, 'AUTH_FAILED', 'Recovery acceptance is not signed by the current owner checkpoint')
    const owner = this.findMember(syncSpaceId, acceptance.authorDeviceId)
    if (!owner || owner.status !== 'ACTIVE' || !verifySyncAuthSignature(acceptance, owner.publicKeySpkiBase64)) throw new SyncServerError(403, 'AUTH_FAILED', 'Recovery acceptance signature is invalid')
    const payload = parseAuthPayload(acceptance.payloadJson)
    if (payload.acceptedSnapshotBundleId !== snapshotBundleId) throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Owner acceptance does not name this Snapshot candidate')
    this.database.prepare('UPDATE sync_server_snapshot_state SET state=\'ACCEPTED\',updated_at=? WHERE snapshot_bundle_id=?').run(Date.now(), snapshotBundleId)
  }

  latestSnapshot(syncSpaceId: string, snapshotClass?: SyncSnapshotBundleWire['snapshotClass'], lanes?: string[]): SyncSnapshotBundleWire | null {
    const classFilter = snapshotClass ? ' AND snapshot_class=?' : ''
    const params = snapshotClass ? [syncSpaceId, snapshotClass] : [syncSpaceId]
    const rows = this.database.prepare(`
      SELECT snapshot_json FROM sync_server_snapshots
      WHERE sync_space_id=?${classFilter}
        AND (snapshot_class<>'BOOTSTRAP_RECOVERY' OR EXISTS(SELECT 1 FROM sync_server_snapshot_state WHERE snapshot_bundle_id=sync_server_snapshots.snapshot_bundle_id AND state='ACCEPTED'))
      ORDER BY captured_at DESC
    `).all(...params) as unknown as Array<{ snapshot_json: string }>
    if (rows.length === 0) return null
    // Never filter a signed manifest: doing so invalidates its signature and root.
    // A selective-sync request may only receive a pre-signed Snapshot with exactly the
    // requested lane scope; a wider Snapshot would relay paused lane payloads.
    const requestedLanes = new Set(lanes ?? [])
    const snapshots = rows.map((row) => JSON.parse(row.snapshot_json) as SyncSnapshotBundleWire)
      .filter((snapshot) => {
        if (!snapshot.authorSignature) return false
        if (requestedLanes.size === 0) return true
        const snapshotLanes = new Set(snapshot.shards.map((shard) => shard.replicationLaneId))
        return snapshotLanes.size === requestedLanes.size &&
          [...requestedLanes].every((lane) => snapshotLanes.has(lane))
      })
    if (!snapshots.length) return null
    const heads = snapshots.filter((candidate, index) => !snapshots.some((other, otherIndex) => otherIndex !== index && strictlyCoverageDominates(other.coverage, candidate.coverage)))
    const distinctHeads = heads.filter((candidate, index) => !heads.slice(0, index).some((other) => other.rootHash === candidate.rootHash && other.policyHash === candidate.policyHash && canonicalJson(JSON.stringify(other.coverage)) === canonicalJson(JSON.stringify(candidate.coverage))))
    if (distinctHeads.length > 1) throw new SyncServerError(409, 'SNAPSHOT_HEADS_INCOMPARABLE', 'Multiple Snapshot heads require a client merge')
    return heads[0] ?? null
  }

  putCoverage(syncSpaceId: string, deviceId: string, kind: 'received' | 'applied' | 'retained', coverage: SyncCoverage): void {
    if (!syncSpaceId.trim() || !deviceId.trim()) throw new SyncServerError(400, 'INVALID_COVERAGE', 'Coverage requires authenticated Space and device identity')
    const incoming = normalizeSyncCoverage(coverage)
    const existing = this.database.prepare(
      'SELECT coverage_json FROM sync_server_peer_coverage WHERE sync_space_id=? AND device_id=? AND coverage_kind=? LIMIT 1'
    ).get(syncSpaceId, deviceId, kind) as { coverage_json: string } | undefined
    const previous = existing ? normalizeSyncCoverage(JSON.parse(existing.coverage_json) as SyncCoverage) : {}
    const merged = mergeSyncCoverage(previous, incoming)
    this.database.prepare(`
      INSERT INTO sync_server_peer_coverage(sync_space_id,device_id,coverage_kind,coverage_json,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(sync_space_id,device_id,coverage_kind) DO UPDATE SET coverage_json=excluded.coverage_json,updated_at=excluded.updated_at
    `).run(syncSpaceId, deviceId, kind, canonicalJson(JSON.stringify(merged)), Date.now())
  }

  putBlob(syncSpaceId: string, chunk: SyncBlobChunk): SyncBlobPersistedAck | null {
    if (!syncSpaceId.trim()) throw new SyncServerError(400, 'AUTH_FAILED', 'Blob requires a Sync Space')
    if (!/^[a-f0-9]{64}$/.test(chunk.hash)) throw new SyncServerError(400, 'BLOB_MISSING', 'Blob hash must be SHA-256 hex')
    if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0) {
      throw new SyncServerError(400, 'BLOB_SIZE', 'Blob offset and size must be non-negative safe integers')
    }
    const namespace = sha256Hex(syncSpaceId)
    const blobKey = `${namespace}:${chunk.hash}`
    const directory = join(this.blobDirectory, namespace)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, chunk.hash)
    const manifest = this.database.prepare('SELECT * FROM sync_server_blob_manifest WHERE hash=? LIMIT 1').get(blobKey) as { expected_bytes: number; received_bytes: number; complete: number; updated_at: number } | undefined
    if (manifest && Number(manifest.expected_bytes) !== chunk.totalBytes) throw new SyncServerError(409, 'BLOB_SIZE', 'Blob total size cannot change during resume')
    if (manifest?.complete === 1) {
      const completeRetry = chunk.offset === 0 && chunk.isFinal && chunk.bytes.byteLength === chunk.totalBytes &&
        createHash('sha256').update(chunk.bytes).digest('hex') === chunk.hash
      if ((chunk.offset === chunk.totalBytes && chunk.bytes.byteLength === 0 && chunk.isFinal) || completeRetry) {
        this.getBlob(syncSpaceId, chunk.hash, 0, 0) // Verify the durable file before acknowledging a retry.
        return {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          syncSpaceId,
          hash: chunk.hash,
          replicaId: this.serverReplicaId,
          totalBytes: chunk.totalBytes,
          persistedAt: Number(manifest.updated_at)
        }
      }
      throw new SyncServerError(409, 'BLOB_OFFSET', 'Blob is already durable')
    }
    const restart = chunk.restart === true
    if (restart && chunk.offset !== 0) throw new SyncServerError(400, 'BLOB_OFFSET', 'Blob restart must begin at offset 0')
    // Legacy whole-Blob retries remain safe and idempotent because the final SHA-256 is verified below.
    const wholeBlobRetry = chunk.offset === 0 && chunk.isFinal && chunk.bytes.byteLength === chunk.totalBytes
    if ((restart || wholeBlobRetry) && existsSync(path)) truncateSync(path, 0)
    const currentLength = existsSync(path) ? statSync(path).size : 0
    if (chunk.offset !== currentLength) throw new SyncServerError(409, 'BLOB_OFFSET', `Expected offset ${currentLength}`)
    const nextLength = chunk.offset + chunk.bytes.byteLength
    if (nextLength > chunk.totalBytes) throw new SyncServerError(400, 'BLOB_SIZE', 'Blob exceeds declared size')
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w+')
    try {
      if (chunk.bytes.byteLength > 0) {
        const bytes = Buffer.from(chunk.bytes)
        const written = writeSync(fd, bytes, 0, bytes.byteLength, chunk.offset)
        if (written !== bytes.byteLength) throw new SyncServerError(500, 'BLOB_WRITE', 'Blob chunk write was incomplete')
      }
    } finally {
      closeSync(fd)
    }
    if (chunk.isFinal && (nextLength !== chunk.totalBytes || sha256FileHex(path) !== chunk.hash)) {
      truncateSync(path, currentLength)
      throw new SyncServerError(400, 'BLOB_HASH', 'Blob content hash mismatch')
    }
    this.database.prepare(`
      INSERT INTO sync_server_blob_manifest(hash,expected_bytes,received_bytes,complete,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET received_bytes=excluded.received_bytes,updated_at=excluded.updated_at
    `).run(blobKey, chunk.totalBytes, nextLength, 0, Date.now())
    if (chunk.isFinal) {
      const persistedAt = Date.now()
      this.database.prepare('UPDATE sync_server_blob_manifest SET complete=1,received_bytes=?,updated_at=? WHERE hash=?').run(nextLength, persistedAt, blobKey)
      return {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        syncSpaceId,
        hash: chunk.hash,
        replicaId: this.serverReplicaId,
        totalBytes: chunk.totalBytes,
        persistedAt
      }
    }
    return null
  }

  blobStatus(syncSpaceId: string, hash: string): SyncBlobStatus | null {
    if (!/^[a-f0-9]{64}$/.test(hash) || !syncSpaceId.trim()) {
      throw new SyncServerError(400, 'BLOB_MISSING', 'Invalid Blob scope or hash')
    }
    const namespace = sha256Hex(syncSpaceId)
    const blobKey = `${namespace}:${hash}`
    const manifest = this.database.prepare(
      'SELECT expected_bytes,received_bytes,complete,updated_at FROM sync_server_blob_manifest WHERE hash=? LIMIT 1'
    ).get(blobKey) as { expected_bytes: number; received_bytes: number; complete: number; updated_at: number } | undefined
    if (!manifest) return null
    const path = join(this.blobDirectory, namespace, hash)
    const durableBytes = existsSync(path) ? statSync(path).size : 0
    if (durableBytes !== Number(manifest.received_bytes)) {
      throw new SyncServerError(409, 'BLOB_SIZE', 'Blob durable prefix does not match its manifest')
    }
    if (manifest.complete === 1 &&
      (durableBytes !== Number(manifest.expected_bytes) || sha256FileHex(path) !== hash)) {
      throw new SyncServerError(409, 'BLOB_HASH', 'Durable blob is missing or corrupt')
    }
    return {
      hash,
      totalBytes: Number(manifest.expected_bytes),
      receivedBytes: durableBytes,
      receivedPrefixSha256: sha256FileHex(path, durableBytes),
      complete: manifest.complete === 1,
      replicaId: manifest.complete === 1 ? this.serverReplicaId : null,
      persistedAt: manifest.complete === 1 ? Number(manifest.updated_at) : null
    }
  }

  getBlob(syncSpaceId: string, hash: string, offset = 0, length?: number): SyncBlobChunk {
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(offset) || offset < 0) throw new SyncServerError(400, 'BLOB_MISSING', 'Invalid Blob hash or offset')
    if (!syncSpaceId.trim() || (length != null && (!Number.isSafeInteger(length) || length < 0))) throw new SyncServerError(400, 'BLOB_SIZE', 'Invalid Blob scope or range')
    const namespace = sha256Hex(syncSpaceId)
    const path = join(this.blobDirectory, namespace, hash)
    if (!existsSync(path)) throw new SyncServerError(404, 'BLOB_MISSING', `Blob ${hash} is not available`)
    const manifest = this.database.prepare('SELECT * FROM sync_server_blob_manifest WHERE hash=? LIMIT 1').get(`${namespace}:${hash}`) as { expected_bytes: number; complete: number } | undefined
    if (!manifest) throw new SyncServerError(404, 'BLOB_MISSING', 'Blob has no durable manifest')
    const durableBytes = statSync(path).size
    if (manifest.complete === 1 && (durableBytes !== Number(manifest.expected_bytes) || sha256FileHex(path) !== hash)) {
      throw new SyncServerError(409, 'BLOB_HASH', 'Durable blob is missing or corrupt')
    }
    const totalBytes = Number(manifest?.expected_bytes ?? durableBytes)
    if (offset > durableBytes) throw new SyncServerError(416, 'BLOB_OFFSET', `Blob offset ${offset} is beyond the durable prefix ${durableBytes}`)
    const end = length == null ? durableBytes : Math.min(durableBytes, offset + Math.max(0, length))
    const selected = Buffer.allocUnsafe(Math.max(0, end - offset))
    if (selected.byteLength > 0) {
      const fd = openSync(path, 'r')
      try {
        const read = readSync(fd, selected, 0, selected.byteLength, offset)
        if (read !== selected.byteLength) throw new SyncServerError(500, 'BLOB_READ', 'Blob range read was incomplete')
      } finally {
        closeSync(fd)
      }
    }
    return { hash, offset, totalBytes, bytes: selected, isFinal: manifest?.complete === 1 && end >= totalBytes }
  }

  currentCursor(): SyncCursor {
    const last = this.database.prepare('SELECT log_offset,operation_id FROM sync_server_operations ORDER BY log_offset DESC LIMIT 1').get() as { log_offset: number; operation_id: string } | undefined
    const logOffset = Number(last?.log_offset ?? 0)
    return { serverEpoch: this.serverEpoch, logOffset, checkpointHash: sha256Hex(`${this.serverEpoch}\n${logOffset}\n${last?.operation_id ?? ''}`) }
  }

  isCursorValid(cursor: SyncCursor): boolean {
    const current = this.currentCursor()
    if (cursor.serverEpoch !== current.serverEpoch || cursor.logOffset > current.logOffset) return false
    if (cursor.logOffset === current.logOffset) return cursor.checkpointHash === current.checkpointHash
    if (cursor.logOffset === 0) return cursor.checkpointHash === sha256Hex(`${this.serverEpoch}\n0\n`)
    const row = this.database.prepare('SELECT operation_id FROM sync_server_operations WHERE log_offset=?').get(cursor.logOffset) as { operation_id: string } | undefined
    if (!row) return false
    return cursor.checkpointHash === sha256Hex(`${this.serverEpoch}\n${cursor.logOffset}\n${row.operation_id}`)
  }

  private coverage(syncSpaceId: string): SyncCoverageVector {
    const result = emptySyncCoverageVector()
    const rows = this.database.prepare(`
      SELECT replication_lane_id,actor_incarnation_id,sequence,state FROM sync_server_operations
      WHERE sync_space_id=? ORDER BY replication_lane_id,actor_incarnation_id,sequence
    `).all(syncSpaceId) as unknown as Array<{ replication_lane_id: string; actor_incarnation_id: string; sequence: number; state: string }>
    for (const row of rows) {
      result.received[row.replication_lane_id] ??= {}
      const currentReceived = coveragePrefix(result.received, row.replication_lane_id, row.actor_incarnation_id)
      if (row.sequence === currentReceived + 1) {
        result.received[row.replication_lane_id]![row.actor_incarnation_id] = row.sequence
      }

      result.retained[row.replication_lane_id] ??= {}
      const currentRetained = coveragePrefix(result.retained, row.replication_lane_id, row.actor_incarnation_id)
      if (row.sequence === currentRetained + 1 && row.state === 'ACCEPTED') {
        result.retained[row.replication_lane_id]![row.actor_incarnation_id] = row.sequence
      }
    }
    return result
  }
}

function canonicalOperationJson(operation: SyncOperationEnvelope): string {
  const value = { ...operation }
  delete value.authorPublicKeySpkiBase64
  return canonicalJson(JSON.stringify(value))
}

function authObjectFromRow(row: Record<string, unknown>): SyncAuthProtocolObject {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    authObjectId: String(row.auth_object_id),
    syncSpaceId: String(row.sync_space_id),
    authEpoch: Number(row.auth_epoch),
    authSequence: Number(row.auth_sequence ?? 0),
    objectType: String(row.object_type) as SyncAuthProtocolObject['objectType'],
    authorDeviceId: String(row.author_device_id),
    ownerDeviceId: String(row.owner_device_id),
    targetDeviceId: row.target_device_id == null ? null : String(row.target_device_id),
    previousEpochFinalAcceptedPrefixByActorLane: JSON.parse(String(row.previous_epoch_final_accepted_prefix_json)) as SyncCoverage,
    revokeCutoffByActorLane: row.revoke_cutoff_json == null ? null : JSON.parse(String(row.revoke_cutoff_json)) as SyncCoverage,
    payloadJson: String(row.payload_json),
    payloadHash: String(row.payload_hash),
    signingDigest: String(row.signing_digest),
    authorSignature: String(row.author_signature),
  }
}

function parseAuthPayload(payloadJson: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payloadJson) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object')
    return value as Record<string, unknown>
  } catch (error) {
    throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', error instanceof Error ? error.message : 'Invalid AUTH payload')
  }
}

function parseCoverage(value: unknown): SyncCoverage {
  try { return normalizeSyncCoverage(value) }
  catch (error) { throw new SyncServerError(400, 'INVALID_AUTH_OBJECT', error instanceof Error ? error.message : 'Invalid AUTH coverage') }
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function coverageEquals(left: SyncCoverage, right: SyncCoverage): boolean {
  return canonicalJson(JSON.stringify(normalizeSyncCoverage(left))) === canonicalJson(JSON.stringify(normalizeSyncCoverage(right)))
}

function filterCoverageByPolicy(coverage: SyncCoverage, policy: Record<string, SyncReplicationPolicy>): SyncCoverage {
  return Object.fromEntries(Object.entries(coverage).filter(([lane]) => policy[lane] === 'ENABLED').map(([lane, actors]) => [lane, { ...actors }]))
}

function strictlyCoverageDominates(left: SyncCoverage, right: SyncCoverage): boolean {
  return coverageDominates(left, right) && !coverageDominates(right, left)
}

function sha256FileHex(path: string, limit = statSync(path).size): string {
  if (!existsSync(path)) {
    if (limit === 0) return createHash('sha256').digest('hex')
    throw new SyncServerError(500, 'BLOB_READ', 'Blob durable file is missing')
  }
  const total = statSync(path).size
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > total) {
    throw new SyncServerError(500, 'BLOB_HASH', 'Blob hash prefix is outside the durable file')
  }
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < limit) {
      const size = Math.min(buffer.byteLength, limit - offset)
      const read = readSync(fd, buffer, 0, size, offset)
      if (read <= 0) throw new SyncServerError(500, 'BLOB_READ', 'Blob file ended before the requested hash prefix')
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function defaultPolicies(): Record<string, SyncReplicationPolicy> {
  return Object.fromEntries(SYNC_SERVER_CAPABILITIES.replicationLanes.map((lane) => [lane, 'ENABLED']))
}
