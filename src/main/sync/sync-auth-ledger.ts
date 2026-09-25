import type { SyncAuthProtocolObject, SyncCoverage } from '../../shared/sync-protocol'
import { canonicalJson } from './sync-operation-canonicalizer'
import {
  validateSyncAuthProtocolObject,
  verifyOwnerRecoveryProof,
  verifyOwnerTransferAcceptance,
  verifySyncAuthSignature
} from './sync-auth-wire'
import { SyncRuntimeRepository, computeActiveGrant } from './sync-runtime-repository'
import type { SyncApplyCoordinator } from './sync-apply-coordinator'
import { SyncStateRepository } from './sync-state-repository'
import { mergeSyncCoverage } from '../../shared/sync-protocol'
import type { DesktopSyncOperationSigner } from './sync-operation-signer'

const order = (a: SyncAuthProtocolObject, b: SyncAuthProtocolObject): number =>
  a.authEpoch - b.authEpoch || (a.authSequence ?? 0) - (b.authSequence ?? 0)

/** Persist only verified single-writer history. Pairing is a trust anchor, not a grant. */
export class DesktopAuthLedgerService {
  constructor(private readonly runtime: SyncRuntimeRepository, private readonly state: SyncStateRepository, private readonly apply?: SyncApplyCoordinator) {}

  issueStabilityCheckpoint(
    space: string,
    signer: DesktopSyncOperationSigner,
    now = Date.now(),
    acceptedSnapshotBundleId?: string,
    verifiedExternalCoverage?: SyncCoverage
  ): SyncAuthProtocolObject | null {
    return this.runtime.transaction(() => {
      if (verifiedExternalCoverage && !acceptedSnapshotBundleId) {
        throw new Error('AUTH_FAILED: external stable coverage requires an accepted Snapshot')
      }
      const history = this.runtime.listAuthObjects(space)
      const head = history.at(-1)
      const device = this.runtime.findDeviceIdentity()
      if (!head || !device || head.ownerDeviceId !== device.deviceId) return null
      const previous = latestStabilityCoverage(history)
      // Retained coverage excludes terminally rejected input; local signed rows are already durable.
      const accepted = mergeSyncCoverage(
        previous,
        this.state.getCoverage(space).retained,
        this.runtime.getSignedCoverage(space),
        verifiedExternalCoverage ?? {}
      )
      if (canonicalJson(JSON.stringify(accepted)) === canonicalJson(JSON.stringify(previous)) &&
        acceptedSnapshotBundleId == null) return null
      const object = signer.signAuth({
        protocolVersion: 1, authObjectId: 'pending', syncSpaceId: space, authEpoch: head.authEpoch,
        authSequence: (head.authSequence ?? 0) + 1, objectType: 'AUTH_STABILITY_CHECKPOINT',
        authorDeviceId: device.deviceId, ownerDeviceId: device.deviceId,
        previousEpochFinalAcceptedPrefixByActorLane: {},
        payloadJson: canonicalJson(JSON.stringify({
          acceptedPrefixByActorLane: accepted,
          ...(acceptedSnapshotBundleId ? { acceptedSnapshotBundleId } : {})
        })),
        payloadHash: 'pending', signingDigest: 'pending', authorSignature: 'pending'
      })
      this.append(space, [object], now)
      return object
    })
  }

  append(space: string, incoming: SyncAuthProtocolObject[], now = Date.now()): void {
    this.runtime.transaction(() => {
      const history = this.runtime.listAuthObjects(space)
      for (const object of [...incoming].sort(order)) {
        validateSyncAuthProtocolObject(object)
        if (object.syncSpaceId !== space) throw new Error('AUTH_SPACE_MISMATCH')
        const existing = history.find((entry) => entry.authObjectId === object.authObjectId)
        if (existing) {
          if (canonicalJson(JSON.stringify(existing)) !== canonicalJson(JSON.stringify(object))) throw new Error('AUTH_COLLISION')
          continue
        }
        const head = history.at(-1)
        const transition = object.objectType === 'OWNER_TRANSFER' || object.objectType === 'OWNER_RECOVERY'
        if (head) {
          if (object.objectType === 'SPACE_ROOT') throw new Error('AUTH_FAILED: immutable Space root')
          if (transition) {
            if (object.authEpoch !== head.authEpoch + 1 || (object.authSequence ?? 0) !== 0) throw new Error('AUTH_EPOCH_CONFLICT')
            if (!object.targetDeviceId || object.ownerDeviceId !== object.targetDeviceId) throw new Error('AUTH_FAILED: owner transition target mismatch')
            const stable = latestStabilityCoverage(history)
            if (!coverageDominates(object.previousEpochFinalAcceptedPrefixByActorLane, stable)) {
              throw new Error('AUTH_FAILED: owner transition crosses stable history')
            }
            if (!this.apply && hasProvisionalTail(this.runtime, this.state, space, object.previousEpochFinalAcceptedPrefixByActorLane, object.authEpoch)) {
              throw new Error('REBASE_UNSAFE: owner transition rollback is not configured')
            }
          } else {
            if (object.authEpoch !== head.authEpoch || object.ownerDeviceId !== head.ownerDeviceId || object.authorDeviceId !== head.ownerDeviceId) {
              throw new Error('AUTH_FAILED: only the current owner may mutate the current epoch')
            }
            if ((object.authSequence ?? 0) !== (head.authSequence ?? 0) + 1) throw new Error('AUTH_SEQUENCE_GAP')
          }
        } else if (object.objectType !== 'SPACE_ROOT' || object.authEpoch !== 0 || (object.authSequence ?? 0) !== 0 || object.authorDeviceId !== object.ownerDeviceId) {
          throw new Error('AUTH_FAILED: initial SPACE_ROOT required')
        }
        const author = [...history].reverse().find((entry) =>
          (entry.objectType === 'SPACE_ROOT' && entry.ownerDeviceId === object.authorDeviceId) ||
          (['MEMBER_GRANT', 'OWNER_TRANSFER', 'OWNER_RECOVERY'].includes(entry.objectType) && entry.targetDeviceId === object.authorDeviceId))
        const payload = author ? JSON.parse(author.payloadJson) as Record<string, unknown> : {}
        const key = author
          ? (payload.ownerPublicKeySpkiBase64 ?? payload.publicKeySpkiBase64)
          : this.state.findPeer(space, object.authorDeviceId)?.publicKeySpkiBase64
        if (typeof key !== 'string' || !verifySyncAuthSignature(object, key)) throw new Error('AUTH_FAILED: untrusted author signature')
        if (object.objectType === 'SPACE_ROOT') {
          const root = JSON.parse(object.payloadJson) as Record<string, unknown>
          if ((root.ownerPublicKeySpkiBase64 ?? root.publicKeySpkiBase64) !== key) throw new Error('AUTH_FAILED: root identity mismatch')
        }
        if (transition) {
          const transitionPayload = JSON.parse(object.payloadJson) as Record<string, unknown>
          const targetKey = transitionPayload.publicKeySpkiBase64
          const trustedTarget = object.targetDeviceId ? this.state.findPeer(space, object.targetDeviceId) : null
          if (typeof targetKey !== 'string' || !trustedTarget || trustedTarget.publicKeySpkiBase64 !== targetKey) {
            throw new Error('AUTH_FAILED: owner transition target key is not confirmed')
          }
          if (object.objectType === 'OWNER_TRANSFER') {
            if (object.authorDeviceId !== head?.ownerDeviceId) throw new Error('AUTH_FAILED: only current owner can transfer ownership')
            const acceptance = transitionPayload.ownerAcceptanceSignature
            if (typeof acceptance !== 'string' || !verifyOwnerTransferAcceptance(
              space, object.authEpoch, object.targetDeviceId!, object.previousEpochFinalAcceptedPrefixByActorLane, acceptance, targetKey
            )) throw new Error('AUTH_FAILED: invalid owner transfer acceptance')
          } else {
            const root = history.find((entry) => entry.objectType === 'SPACE_ROOT')
            const rootPayload = root ? JSON.parse(root.payloadJson) as Record<string, unknown> : {}
            const rootKey = rootPayload.spaceRootPublicKey
            const proof = transitionPayload.recoveryProof
            if (typeof rootKey !== 'string' || typeof proof !== 'string' || !verifyOwnerRecoveryProof(
              space, object.authEpoch, object.targetDeviceId!, object.previousEpochFinalAcceptedPrefixByActorLane, proof, rootKey
            )) throw new Error('AUTH_FAILED: invalid owner recovery proof')
          }
          this.apply?.applyEpochTransitionRollback(
            space,
            object.previousEpochFinalAcceptedPrefixByActorLane,
            object.authEpoch,
            now
          )
        }
        if (object.objectType === 'MEMBER_REVOKE') {
          if (!object.targetDeviceId) throw new Error('AUTH_FAILED: revoke target is missing')
          const affected = this.state.listAppliedProvisionalInbox(space).map((row) => this.runtime.findOperation(row.operationId))
            .filter((op) => op && op.authorDeviceId === object.targetDeviceId && op.sequence >
              (object.revokeCutoffByActorLane?.[op.replicationLaneId]?.[op.actorIncarnationId] ?? 0))
          const checkpointStable = latestStabilityCoverage(history)
          if (!coverageDominates(object.revokeCutoffByActorLane ?? {}, checkpointStableForDevice(this.runtime, this.state, space, object.targetDeviceId, checkpointStable))) {
            throw new Error('AUTH_FAILED: revoke crosses AuthStabilityCheckpoint')
          }
          const stable = this.state.getCoverage(space).stableGc
          if (affected.some((op) => op && op.sequence <= (stable[op.replicationLaneId]?.[op.actorIncarnationId] ?? 0))) throw new Error('AUTH_FAILED: revoke crosses stable history')
          if (affected.length) {
            if (!this.apply) throw new Error('REBASE_UNSAFE: revocation rollback is not configured')
            this.apply.applyRevocationRollback(space, object.targetDeviceId, object.revokeCutoffByActorLane, now)
          }
        }
        if (object.objectType === 'AUTH_STABILITY_CHECKPOINT') {
          const checkpointPayload = JSON.parse(object.payloadJson) as Record<string, unknown>
          const accepted = checkpointPayload.acceptedPrefixByActorLane
          if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
            throw new Error('AUTH_FAILED: checkpoint acceptedPrefixByActorLane is missing')
          }
          const previousStable = latestStabilityCoverage(history)
          if (!coverageDominates(accepted as SyncCoverage, previousStable)) {
            throw new Error('AUTH_FAILED: stability checkpoint cannot move backwards')
          }
        }
        this.runtime.upsertAuthObject(object, now)
        history.push(object)
        if (object.objectType === 'AUTH_STABILITY_CHECKPOINT') {
          const payload = JSON.parse(object.payloadJson) as Record<string, unknown>
          const accepted = payload.acceptedPrefixByActorLane
          if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
            throw new Error('AUTH_FAILED: checkpoint acceptedPrefixByActorLane is missing')
          }
          this.state.promoteStableAuthorization(
            space,
            accepted as Record<string, Record<string, number>>,
            object.authObjectId
          )
        }
      }
      for (const object of history) {
        const payload = JSON.parse(object.payloadJson) as Record<string, unknown>
        const device = object.objectType === 'SPACE_ROOT' ? object.ownerDeviceId : object.targetDeviceId
        const publicKey = payload.ownerPublicKeySpkiBase64 ?? payload.publicKeySpkiBase64
        if (device && typeof publicKey === 'string') this.state.registerPeer({
          syncSpaceId: space, deviceId: device, publicKeySpkiBase64: publicKey,
          status: computeActiveGrant(history, device) ? 'ACTIVE' : 'REVOKED',
          authEpoch: history.at(-1)?.authEpoch ?? 0, updatedAt: now,
        })
      }
    })
  }
}

function latestStabilityCoverage(history: SyncAuthProtocolObject[]): SyncCoverage {
  for (const object of [...history].reverse()) {
    if (object.objectType !== 'AUTH_STABILITY_CHECKPOINT') continue
    const payload = JSON.parse(object.payloadJson) as Record<string, unknown>
    const accepted = payload.acceptedPrefixByActorLane
    if (accepted && typeof accepted === 'object' && !Array.isArray(accepted)) return accepted as SyncCoverage
  }
  return {}
}

function coverageDominates(left: SyncCoverage, right: SyncCoverage): boolean {
  return Object.entries(right).every(([lane, actors]) =>
    Object.entries(actors).every(([actor, prefix]) => (left[lane]?.[actor] ?? 0) >= prefix)
  )
}

function checkpointStableForDevice(
  runtime: SyncRuntimeRepository,
  state: SyncStateRepository,
  space: string,
  deviceId: string,
  stable: SyncCoverage
): SyncCoverage {
  const result: SyncCoverage = {}
  for (const [lane, actors] of Object.entries(stable)) {
    for (const [actor, prefix] of Object.entries(actors)) {
      if (!runtime.actorBelongsTo(space, actor, deviceId)) continue
      result[lane] ??= {}
      result[lane]![actor] = prefix
    }
  }
  return result
}

function hasProvisionalTail(
  runtime: SyncRuntimeRepository,
  state: SyncStateRepository,
  space: string,
  cut: SyncCoverage,
  newEpoch: number
): boolean {
  return state.listAppliedProvisionalInbox(space)
    .map((row) => runtime.findOperation(row.operationId))
    .some((op) => Boolean(op && (op.authEpoch ?? -1) < newEpoch &&
      op.sequence > (cut[op.replicationLaneId]?.[op.actorIncarnationId] ?? 0)))
}
