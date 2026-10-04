import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { SyncAuthProtocolObject, SyncCoverage } from '../../shared/sync-protocol'
import { SYNC_PROTOCOL_VERSION, normalizeSyncCoverage } from '../../shared/sync-protocol'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'

export class SyncAuthWireValidationError extends Error {
  readonly code = 'INVALID_AUTH_OBJECT' as const
}

/** Canonical, framed material shared by every AUTH-lane signature implementation. */
export function authSigningMaterial(object: SyncAuthProtocolObject): string {
  let result = 'ORIGREAD_SYNC_AUTH_V1\n'
  const field = (name: string, value: string): void => {
    result += `${name}=${Buffer.byteLength(value, 'utf8')}:${value}\n`
  }
  const nullable = (name: string, value: string | null | undefined): void => {
    if (value == null) result += `${name}=-1:\n`
    else field(name, value)
  }

  field('authObjectId', object.authObjectId)
  field('syncSpaceId', object.syncSpaceId)
  field('authEpoch', String(object.authEpoch))
  field('authSequence', String(object.authSequence ?? 0))
  field('objectType', object.objectType)
  field('authorDeviceId', object.authorDeviceId)
  field('ownerDeviceId', object.ownerDeviceId)
  nullable('targetDeviceId', object.targetDeviceId)
  field('previousEpochFinalAcceptedPrefixByActorLane', canonicalCoverage(object.previousEpochFinalAcceptedPrefixByActorLane))
  nullable('revokeCutoffByActorLane', object.revokeCutoffByActorLane == null ? null : canonicalCoverage(object.revokeCutoffByActorLane))
  field('payloadHash', object.payloadHash)
  return result
}

export function authSigningDigest(object: SyncAuthProtocolObject): string {
  return sha256Hex(authSigningMaterial(object))
}

/** 幂等比较采用正式签名语义；Android 显式 null 与 Desktop 省略可选字段表示同一对象。 */
export function canonicalAuthObjectContent(object: SyncAuthProtocolObject): string {
  validateSyncAuthProtocolObject(object)
  return canonicalJson(JSON.stringify({
    protocolVersion: object.protocolVersion,
    signingMaterial: authSigningMaterial(object),
    payloadJson: object.payloadJson,
    signingDigest: object.signingDigest,
    authorSignature: object.authorSignature
  }))
}

export function authObjectId(
  syncSpaceId: string,
  authEpoch: number,
  objectType: SyncAuthProtocolObject['objectType'],
  authorDeviceId: string,
  payloadHash: string,
  authSequence = 0,
): string {
  const material = [
    'ORIGREAD_SYNC_AUTH_ID_V1',
    framed('syncSpaceId', syncSpaceId),
    framed('authEpoch', String(authEpoch)),
    framed('authSequence', String(authSequence)),
    framed('objectType', objectType),
    framed('authorDeviceId', authorDeviceId),
    framed('payloadHash', payloadHash),
  ].join('\n')
  return `auth1:${sha256Hex(material)}`
}

export function validateSyncAuthProtocolObject(object: SyncAuthProtocolObject): void {
  if (!object || typeof object !== 'object') throw new SyncAuthWireValidationError('AUTH object must be an object')
  if (object.protocolVersion !== SYNC_PROTOCOL_VERSION) throw new SyncAuthWireValidationError('Unsupported Sync protocol version')
  for (const [name, value] of [
    ['authObjectId', object.authObjectId],
    ['syncSpaceId', object.syncSpaceId],
    ['objectType', object.objectType],
    ['authorDeviceId', object.authorDeviceId],
    ['ownerDeviceId', object.ownerDeviceId],
    ['payloadJson', object.payloadJson],
    ['payloadHash', object.payloadHash],
    ['signingDigest', object.signingDigest],
    ['authorSignature', object.authorSignature],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') throw new SyncAuthWireValidationError(`${name} must not be blank`)
  }
  if (!Number.isSafeInteger(object.authEpoch) || object.authEpoch < 0) throw new SyncAuthWireValidationError('authEpoch must be a non-negative safe integer')
  if (!Number.isSafeInteger(object.authSequence ?? 0) || (object.authSequence ?? 0) < 0) throw new SyncAuthWireValidationError('authSequence must be a non-negative safe integer')
  if (!['SPACE_ROOT', 'OWNER_TRANSFER', 'OWNER_RECOVERY', 'MEMBER_GRANT', 'MEMBER_REVOKE', 'AUTH_STABILITY_CHECKPOINT'].includes(object.objectType)) {
    throw new SyncAuthWireValidationError(`Unsupported AUTH object type: ${object.objectType}`)
  }
  if (object.targetDeviceId != null && (typeof object.targetDeviceId !== 'string' || object.targetDeviceId.trim() === '')) {
    throw new SyncAuthWireValidationError('targetDeviceId must be blank or a non-empty string')
  }
  try {
    const payload = canonicalJson(object.payloadJson)
    if (payload !== object.payloadJson) throw new SyncAuthWireValidationError('payloadJson is not canonical')
    const previous = normalizeSyncCoverage(object.previousEpochFinalAcceptedPrefixByActorLane)
    if (canonicalJson(JSON.stringify(previous)) !== canonicalCoverage(object.previousEpochFinalAcceptedPrefixByActorLane)) {
      throw new SyncAuthWireValidationError('previousEpochFinalAcceptedPrefixByActorLane is not canonical')
    }
    if (object.revokeCutoffByActorLane != null) {
      const cutoff = normalizeSyncCoverage(object.revokeCutoffByActorLane)
      if (canonicalJson(JSON.stringify(cutoff)) !== canonicalCoverage(object.revokeCutoffByActorLane)) {
        throw new SyncAuthWireValidationError('revokeCutoffByActorLane is not canonical')
      }
    }
    if (object.payloadHash !== sha256Hex(payload)) throw new SyncAuthWireValidationError('AUTH payloadHash mismatch')
    if (object.authObjectId !== authObjectId(object.syncSpaceId, object.authEpoch, object.objectType, object.authorDeviceId, object.payloadHash, object.authSequence ?? 0)) {
      throw new SyncAuthWireValidationError('AUTH authObjectId mismatch')
    }
    if (object.signingDigest !== authSigningDigest(object)) throw new SyncAuthWireValidationError('AUTH signingDigest mismatch')
  } catch (error) {
    if (error instanceof SyncAuthWireValidationError) throw error
    throw new SyncAuthWireValidationError(error instanceof Error ? error.message : 'Invalid AUTH JSON')
  }
}

export function verifySyncAuthSignature(object: SyncAuthProtocolObject, publicKeySpkiBase64: string): boolean {
  try {
    validateSyncAuthProtocolObject(object)
    const publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    return cryptoVerify(
      'sha256',
      Buffer.from(authSigningMaterial(object), 'utf8'),
      publicKey,
      Buffer.from(object.authorSignature, 'base64'),
    )
  } catch {
    return false
  }
}

/** Canonical signing material for OWNER_RECOVERY proof. */
export function ownerRecoverySigningMaterial(
  syncSpaceId: string,
  authEpoch: number,
  targetDeviceId: string,
  previousCut: SyncCoverage
): string {
  return [
    'ORIGREAD_OWNER_RECOVERY_PROOF_V1',
    framed('syncSpaceId', syncSpaceId),
    framed('authEpoch', String(authEpoch)),
    framed('targetDeviceId', targetDeviceId),
    framed('previousEpochFinalAcceptedPrefixByActorLane', canonicalCoverage(previousCut))
  ].join('\n')
}

/** 验证 OWNER_RECOVERY 的密码学恢复证明签名 */
export function verifyOwnerRecoveryProof(
  syncSpaceId: string,
  authEpoch: number,
  targetDeviceId: string,
  previousCut: SyncCoverage,
  recoveryProofBase64: string,
  spaceRootPublicKeySpkiBase64: string
): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(spaceRootPublicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    const material = ownerRecoverySigningMaterial(syncSpaceId, authEpoch, targetDeviceId, previousCut)
    return cryptoVerify(
      'sha256',
      Buffer.from(material, 'utf8'),
      publicKey,
      Buffer.from(recoveryProofBase64, 'base64')
    )
  } catch {
    return false
  }
}

export function verifyOwnerTransferAcceptance(
  syncSpaceId: string,
  authEpoch: number,
  targetDeviceId: string,
  previousCut: SyncCoverage,
  acceptanceSignatureBase64: string,
  targetPublicKeySpkiBase64: string
): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(targetPublicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    const material = ownerRecoverySigningMaterial(syncSpaceId, authEpoch, targetDeviceId, previousCut)
      .replace('ORIGREAD_OWNER_RECOVERY_PROOF_V1', 'ORIGREAD_OWNER_TRANSFER_ACCEPTANCE_V1')
    return cryptoVerify(
      'sha256',
      Buffer.from(material, 'utf8'),
      publicKey,
      Buffer.from(acceptanceSignatureBase64, 'base64')
    )
  } catch {
    return false
  }
}

function canonicalCoverage(value: SyncCoverage): string {
  return canonicalJson(JSON.stringify(normalizeSyncCoverage(value)))
}

function framed(name: string, value: string): string {
  return `${name}=${Buffer.byteLength(value, 'utf8')}:${value}`
}
