import type { SyncOperationRecord } from '../../shared/sync-runtime'
import {
  canonicalJson,
  operationSigningDigest,
  operationSigningMaterial,
  sha256Hex
} from './sync-operation-canonicalizer'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncAuthProtocolObject } from '../../shared/sync-protocol'
import { authObjectId, authSigningDigest, authSigningMaterial } from './sync-auth-wire'

export class SyncOperationIntegrityError extends Error {}

/** Signs only immutable, already-built local operations. Transports must consume SIGNED rows only. */
export class DesktopSyncOperationSigner {
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly keys: DesktopSyncDeviceSigningKeyStore
  ) {}

  signPending(syncSpaceId: string, limit = 100, now = Date.now()): number {
    const device = this.runtime.findDeviceIdentity()
    if (!device) throw new Error('Device identity must exist before signing Sync operations')
    const pending = this.runtime.listOperationsByStatus(syncSpaceId, 'AWAITING_SIGNATURE', limit)

    for (const operation of pending) {
      this.validateLocalOperation(operation, device.deviceId)
      const material = operationSigningMaterial(operation)
      const signature = this.keys.signBase64(device.deviceId, material)
      const publicKey = this.keys.publicKeySpkiBase64(device.deviceId)
      if (!this.keys.verifyBase64(publicKey, material, signature)) {
        throw new SyncOperationIntegrityError('Generated Sync operation signature failed local verification')
      }
      const changed = this.runtime.markOperationSigned(
        operation.operationId,
        operation.signingDigest,
        signature,
        now
      )
      if (!changed) {
        throw new SyncOperationIntegrityError(
          `Sync operation ${operation.operationId} changed while it was being signed`
        )
      }
    }
    return pending.length
  }

  publicKeySpkiBase64(deviceId: string): string {
    return this.keys.publicKeySpkiBase64(deviceId)
  }

  signAuth(object: SyncAuthProtocolObject): SyncAuthProtocolObject {
    if (this.runtime.findDeviceIdentity()?.deviceId !== object.authorDeviceId) {
      throw new SyncOperationIntegrityError('Cannot sign AUTH for another installation')
    }
    const payloadJson = canonicalJson(object.payloadJson)
    const payloadHash = sha256Hex(payloadJson)
    const unsigned = { ...object, payloadJson, payloadHash,
      authObjectId: authObjectId(object.syncSpaceId, object.authEpoch, object.objectType,
        object.authorDeviceId, payloadHash, object.authSequence ?? 0) }
    return { ...unsigned, signingDigest: authSigningDigest(unsigned),
      authorSignature: this.keys.signBase64(object.authorDeviceId, authSigningMaterial(unsigned)) }
  }

  verify(publicKeySpkiBase64: string, operation: SyncOperationRecord): boolean {
    const signature = operation.authorSignature
    if (!signature || operation.buildStatus !== 'SIGNED' || !this.hasValidCanonicalIntegrity(operation)) return false
    return this.keys.verifyBase64(publicKeySpkiBase64, operationSigningMaterial(operation), signature)
  }

  private validateLocalOperation(operation: SyncOperationRecord, currentDeviceId: string): void {
    if (operation.authorDeviceId !== currentDeviceId) {
      throw new SyncOperationIntegrityError(
        `Refusing to sign operation ${operation.operationId} authored by another device`
      )
    }
    if (!this.hasValidCanonicalIntegrity(operation)) {
      throw new SyncOperationIntegrityError(
        `Canonical payload/signing digest mismatch for operation ${operation.operationId}`
      )
    }
  }

  private hasValidCanonicalIntegrity(operation: SyncOperationRecord): boolean {
    try {
      const payload = canonicalJson(operation.payloadJson)
      const causal = canonicalJson(operation.causalContextJson)
      const dependencies = canonicalJson(operation.dependencyDotsJson)
      return operation.payloadJson === payload &&
        operation.causalContextJson === causal &&
        operation.dependencyDotsJson === dependencies &&
        operation.payloadHash === sha256Hex(payload) &&
        operation.signingDigest === operationSigningDigest(operation)
    } catch {
      return false
    }
  }
}
