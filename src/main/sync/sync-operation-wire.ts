import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { SyncOperationRecord, SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import { SYNC_PROTOCOL_VERSION } from '../../shared/sync-protocol'
import { canonicalJson, operationId, operationSigningDigest, operationSigningMaterial, sha256Hex } from './sync-operation-canonicalizer'

export class SyncWireValidationError extends Error {
  readonly code = 'INVALID_OPERATION' as const
}

export function operationRecordFromWire(envelope: SyncOperationEnvelope, receivedAt = Date.now()): SyncOperationRecord {
  validateSyncOperationEnvelope(envelope)
  return {
    operationId: envelope.operationId,
    syncSpaceId: envelope.syncSpaceId,
    authorDeviceId: envelope.authorDeviceId,
    actorIncarnationId: envelope.actorIncarnationId,
    replicationLaneId: envelope.replicationLaneId as SyncReplicationLane,
    sequence: envelope.sequence,
    logicalClock: envelope.logicalClock,
    causalContextJson: envelope.causalContextJson,
    dependencyDotsJson: envelope.dependencyDotsJson,
    entityType: envelope.entityType,
    entitySyncId: envelope.entitySyncId,
    entityGeneration: envelope.entityGeneration,
    operationType: envelope.operationType as SyncOperationRecord['operationType'],
    payloadSchemaVersion: envelope.payloadSchemaVersion,
    payloadJson: envelope.payloadJson,
    schemaVersion: envelope.schemaVersion,
    authGrantId: envelope.authGrantId,
    authEpoch: envelope.authEpoch,
    createdWallClock: envelope.createdWallClock,
    payloadHash: envelope.payloadHash,
    signingDigest: envelope.signingDigest,
    authorSignature: envelope.authorSignature,
    buildStatus: 'SIGNED',
    createdAt: receivedAt,
    updatedAt: receivedAt
  }
}

export function validateSyncOperationEnvelope(envelope: SyncOperationEnvelope): void {
  if (!envelope || typeof envelope !== 'object') throw new SyncWireValidationError('Operation envelope must be an object')
  if (envelope.protocolVersion !== SYNC_PROTOCOL_VERSION) throw new SyncWireValidationError('Unsupported Sync protocol version')
  for (const [name, value] of [
    ['operationId', envelope.operationId],
    ['syncSpaceId', envelope.syncSpaceId],
    ['authorDeviceId', envelope.authorDeviceId],
    ['actorIncarnationId', envelope.actorIncarnationId],
    ['replicationLaneId', envelope.replicationLaneId],
    ['entityType', envelope.entityType],
    ['entitySyncId', envelope.entitySyncId],
    ['operationType', envelope.operationType],
    ['causalContextJson', envelope.causalContextJson],
    ['dependencyDotsJson', envelope.dependencyDotsJson],
    ['payloadJson', envelope.payloadJson],
    ['payloadHash', envelope.payloadHash],
    ['signingDigest', envelope.signingDigest],
    ['authorSignature', envelope.authorSignature]
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') throw new SyncWireValidationError(`${name} must not be blank`)
  }
  assertPositiveSafeInteger(envelope.sequence, 'sequence')
  assertPositiveSafeInteger(envelope.logicalClock, 'logicalClock')
  assertNonNegativeSafeInteger(envelope.entityGeneration, 'entityGeneration')
  assertPositiveSafeInteger(envelope.payloadSchemaVersion, 'payloadSchemaVersion')
  assertPositiveSafeInteger(envelope.schemaVersion, 'schemaVersion')
  assertNonNegativeSafeInteger(envelope.createdWallClock, 'createdWallClock')
  if (envelope.authEpoch !== null) assertNonNegativeSafeInteger(envelope.authEpoch, 'authEpoch')
  try {
    const normalizedPayload = canonicalJson(envelope.payloadJson)
    const normalizedCausal = canonicalJson(envelope.causalContextJson)
    const normalizedDependencies = canonicalJson(envelope.dependencyDotsJson)
    if (normalizedPayload !== envelope.payloadJson) throw new SyncWireValidationError('payloadJson is not canonical')
    if (normalizedCausal !== envelope.causalContextJson) throw new SyncWireValidationError('causalContextJson is not canonical')
    if (normalizedDependencies !== envelope.dependencyDotsJson) throw new SyncWireValidationError('dependencyDotsJson is not canonical')
    if (envelope.payloadHash !== sha256Hex(normalizedPayload)) throw new SyncWireValidationError('payloadHash mismatch')
    const operation = operationRecordFromWireUnchecked(envelope)
    const expectedId = operationId(operation.syncSpaceId, operation.actorIncarnationId, operation.replicationLaneId, operation.sequence)
    if (expectedId !== operation.operationId) throw new SyncWireValidationError('operationId mismatch')
    if (operationSigningDigest(operation) !== operation.signingDigest) throw new SyncWireValidationError('signingDigest mismatch')
  } catch (error) {
    if (error instanceof SyncWireValidationError) throw error
    throw new SyncWireValidationError(error instanceof Error ? error.message : 'Invalid operation JSON')
  }
}

export function verifySyncOperationSignature(envelope: SyncOperationEnvelope, publicKeySpkiBase64: string): boolean {
  try {
    validateSyncOperationEnvelope(envelope)
    const operation = operationRecordFromWireUnchecked(envelope)
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return cryptoVerify(
      'sha256',
      Buffer.from(operationSigningMaterial(operation), 'utf8'),
      publicKey,
      Buffer.from(envelope.authorSignature, 'base64')
    )
  } catch {
    return false
  }
}

function operationRecordFromWireUnchecked(envelope: SyncOperationEnvelope): SyncOperationRecord {
  return {
    operationId: envelope.operationId,
    syncSpaceId: envelope.syncSpaceId,
    authorDeviceId: envelope.authorDeviceId,
    actorIncarnationId: envelope.actorIncarnationId,
    replicationLaneId: envelope.replicationLaneId as SyncReplicationLane,
    sequence: envelope.sequence,
    logicalClock: envelope.logicalClock,
    causalContextJson: envelope.causalContextJson,
    dependencyDotsJson: envelope.dependencyDotsJson,
    entityType: envelope.entityType,
    entitySyncId: envelope.entitySyncId,
    entityGeneration: envelope.entityGeneration,
    operationType: envelope.operationType as SyncOperationRecord['operationType'],
    payloadSchemaVersion: envelope.payloadSchemaVersion,
    payloadJson: envelope.payloadJson,
    schemaVersion: envelope.schemaVersion,
    authGrantId: envelope.authGrantId,
    authEpoch: envelope.authEpoch,
    createdWallClock: envelope.createdWallClock,
    payloadHash: envelope.payloadHash,
    signingDigest: envelope.signingDigest,
    authorSignature: envelope.authorSignature,
    buildStatus: 'SIGNED',
    createdAt: 0,
    updatedAt: 0
  }
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SyncWireValidationError(`${name} must be a positive safe integer`)
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SyncWireValidationError(`${name} must be a non-negative safe integer`)
}
