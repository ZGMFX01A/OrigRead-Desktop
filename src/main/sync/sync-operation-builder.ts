import type { SyncOperationRecord, SyncOutboxRecord } from '../../shared/sync-runtime'
import { canonicalJson, operationId, operationSigningDigest, sha256Hex } from './sync-operation-canonicalizer'
import { syncPayloadBlobRefs } from './sync-blob-payload'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { SyncRuntimeRepository, type SyncActorRecord } from './sync-runtime-repository'

export class SyncDotCollisionError extends Error {}
export class SyncAuthNotGrantedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncAuthNotGrantedError'
  }
}

export interface DesktopOperationBuilderOptions {
  strictAuth?: boolean
}

export class DesktopOperationBuilder {
  private readonly blobs: DesktopSyncBlobStateService

  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly options?: DesktopOperationBuilderOptions
  ) {
    this.blobs = new DesktopSyncBlobStateService(runtime.databaseHandle())
  }

  buildPending(syncSpaceId: string, limit = 100, now = Date.now()): number {
    return this.runtime.transaction(() => {
      const pending = this.runtime.listPendingOutbox(syncSpaceId, limit)
      for (const outbox of pending) {
        const actor = this.runtime.findActor(outbox.actorIncarnationId)
        if (!actor) throw new Error(`Missing actor ${outbox.actorIncarnationId} for outbox ${outbox.outboxId}`)
        const operation = this.buildOperation(outbox, actor, now)
        this.persistIdempotently(operation)
        for (const ref of syncPayloadBlobRefs(operation.payloadJson)) {
          this.blobs.addReference(
            operation.syncSpaceId,
            operation.replicationLaneId,
            '__operation__',
            operation.operationId,
            0,
            `payload:${ref.referenceKind}`,
            ref.manifest.hash,
            now
          )
        }
        this.runtime.markOutboxBuilt(outbox.outboxId, now)
      }
      return pending.length
    })
  }

  buildOperation(outbox: SyncOutboxRecord, actor: SyncActorRecord, now: number): SyncOperationRecord {
    const authObjects = this.runtime.listAuthObjects(outbox.syncSpaceId)
    const grant = this.runtime.findActiveGrant(outbox.syncSpaceId, actor.deviceId)
    // Production fails closed; an explicit false is reserved for isolated protocol fixtures.
    const effectiveStrict = this.options?.strictAuth ?? true
    if (!grant && effectiveStrict) {
      throw new SyncAuthNotGrantedError(`Device ${actor.deviceId} is not authorized in space ${outbox.syncSpaceId}`)
    }
    const payloadJson = canonicalJson(outbox.payloadJson)
    const causalContextJson = canonicalJson(outbox.causalContextJson)
    const dependencyDotsJson = canonicalJson('[]')
    const provisional: SyncOperationRecord = {
      operationId: operationId(
        outbox.syncSpaceId,
        outbox.actorIncarnationId,
        outbox.replicationLaneId,
        outbox.sequence
      ),
      syncSpaceId: outbox.syncSpaceId,
      authorDeviceId: actor.deviceId,
      actorIncarnationId: outbox.actorIncarnationId,
      replicationLaneId: outbox.replicationLaneId,
      sequence: outbox.sequence,
      logicalClock: outbox.sequence,
      causalContextJson,
      dependencyDotsJson,
      entityType: outbox.entityType,
      entitySyncId: outbox.entitySyncId,
      entityGeneration: outbox.entityGeneration,
      operationType: outbox.mutationType,
      payloadSchemaVersion: outbox.payloadSchemaVersion,
      payloadJson,
      schemaVersion: 1,
      authGrantId: grant?.authGrantId ?? null,
      authEpoch: grant?.authEpoch ?? null,
      createdWallClock: outbox.createdAt,
      payloadHash: sha256Hex(payloadJson),
      signingDigest: '',
      authorSignature: null,
      buildStatus: 'AWAITING_SIGNATURE',
      createdAt: now,
      updatedAt: now
    }
    return { ...provisional, signingDigest: operationSigningDigest(provisional) }
  }

  persistIdempotently(operation: SyncOperationRecord): void {
    if (this.runtime.insertOperationIgnore(operation)) return
    const existing = this.runtime.findOperation(operation.operationId) ?? this.runtime.findOperationByDot(
      operation.actorIncarnationId,
      operation.replicationLaneId,
      operation.sequence
    )
    if (!existing || !sameImmutableOperation(existing, operation)) {
      throw new SyncDotCollisionError(
        `DOT_COLLISION for ${operation.actorIncarnationId}/${operation.replicationLaneId}/${operation.sequence}: ` +
        `incoming operationId=${operation.operationId}`
      )
    }
  }
}

function sameImmutableOperation(left: SyncOperationRecord, right: SyncOperationRecord): boolean {
  return left.syncSpaceId === right.syncSpaceId &&
    left.authorDeviceId === right.authorDeviceId &&
    left.actorIncarnationId === right.actorIncarnationId &&
    left.replicationLaneId === right.replicationLaneId &&
    left.sequence === right.sequence &&
    left.logicalClock === right.logicalClock &&
    left.causalContextJson === right.causalContextJson &&
    left.dependencyDotsJson === right.dependencyDotsJson &&
    left.entityType === right.entityType &&
    left.entitySyncId === right.entitySyncId &&
    left.entityGeneration === right.entityGeneration &&
    left.operationType === right.operationType &&
    left.payloadSchemaVersion === right.payloadSchemaVersion &&
    left.payloadJson === right.payloadJson &&
    left.schemaVersion === right.schemaVersion &&
    left.authGrantId === right.authGrantId &&
    left.authEpoch === right.authEpoch &&
    left.createdWallClock === right.createdWallClock &&
    left.payloadHash === right.payloadHash &&
    left.signingDigest === right.signingDigest
}
