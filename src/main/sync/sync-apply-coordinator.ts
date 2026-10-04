import { actorIsolated, isolateActor } from './sync-actor-integrity'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type {
  SyncCoverage,
  SyncCoverageVector,
  SyncDiagnostic,
  SyncOperationEnvelope,
  SyncOperationBatchResult
} from '../../shared/sync-protocol'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import {
  operationRecordFromWire,
  operationEnvelopeFromRecord,
  validateSyncOperationEnvelope,
  verifySyncOperationSignature,
  SyncWireValidationError
} from './sync-operation-wire'
import { canonicalJson } from './sync-operation-canonicalizer'
import { dependenciesSatisfied } from './sync-apply-dependencies'
import { decodeSnapshotSignature } from './sync-snapshot-signature-proof'

export class SyncApplyDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncApplyDeferredError'
  }
}

export interface SyncPeerKey {
  publicKeySpkiBase64: string
  status: 'ACTIVE' | 'REVOKED'
  authEpoch: number
}

export interface SyncApplyHandler {
  apply(operation: SyncOperationRecord): void
  canApplyProvisionally?(operation: SyncOperationRecord): boolean
  rollbackField?(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    field: string,
    revokedOperationId: string
  ): void
}

export interface SyncRevocationRollbackResult {
  revokedOperationIds: string[]
  rolledBackFields: string[]
}

export interface SyncIngestOptions {
  resolvePeerKey: (syncSpaceId: string, deviceId: string) => SyncPeerKey | null
  now?: number
}

export interface SyncIngestReport {
  acceptedOperationIds: string[]
  duplicateOperationIds: string[]
  rejected: Array<{ operationId: string | null; code: string; message: string; rejectionDigest?: string }>
  diagnostics: SyncDiagnostic[]
}

/**
 * The one local apply boundary for all transports. LAN and Server sessions only call ingest(); they
 * never merge business rows themselves. Received, Applied and Retained coverage are updated here.
 */
export class SyncApplyCoordinator {
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly handler: SyncApplyHandler = { apply: () => { throw new SyncApplyDeferredError('Business projection is not configured') } },
    private readonly options: { allowUnanchoredTestOperations?: boolean } = {}
  ) {}

  ingest(batch: SyncOperationEnvelope[], options: SyncIngestOptions): SyncIngestReport {
    const now = options.now ?? Date.now()
    const acceptedOperationIds: string[] = []
    const duplicateOperationIds: string[] = []
    const rejected: SyncIngestReport['rejected'] = []
    const diagnostics: SyncDiagnostic[] = []

    for (const envelope of batch) {
      try {
        validateSyncOperationEnvelope(envelope)
        const peer = options.resolvePeerKey(envelope.syncSpaceId, envelope.authorDeviceId)
        if (!peer) throw new SyncApplyRejection('AUTH_FAILED', `Unknown author device ${envelope.authorDeviceId}`)
        if (!verifySyncOperationSignature(envelope, peer.publicKeySpkiBase64)) {
          throw new SyncApplyRejection('AUTH_FAILED', 'Author signature verification failed')
        }
        const otherAuthor = this.runtime.databaseHandle().prepare(
          'SELECT 1 FROM sync_actor_author WHERE sync_space_id=? AND actor_incarnation_id=? AND author_device_id<>? LIMIT 1'
        ).get(envelope.syncSpaceId, envelope.actorIncarnationId, envelope.authorDeviceId)
        if (otherAuthor) throw new SyncApplyRejection('AUTH_FAILED', 'Actor belongs to another author')
        const operation = operationRecordFromWire(envelope, now)
        const existingOperation = this.runtime.findOperation(operation.operationId) ?? this.runtime.findOperationByDot(
          operation.actorIncarnationId,
          operation.replicationLaneId,
          operation.sequence
        )
        if (existingOperation && existingOperation.syncSpaceId === operation.syncSpaceId &&
          existingOperation.authorDeviceId === operation.authorDeviceId && existingOperation.signingDigest !== operation.signingDigest &&
          verifySyncOperationSignature(operationEnvelopeFromRecord(existingOperation), peer.publicKeySpkiBase64)) {
          isolateActor(this.runtime.databaseHandle(), { first: existingOperation, second: operation, now })
          throw new SyncApplyRejection('DOT_COLLISION', 'Authenticated actor history conflict; actor is isolated')
        }
        if (actorIsolated(this.runtime.databaseHandle(), { space: operation.syncSpaceId, actor: operation.actorIncarnationId })) {
          throw new SyncApplyRejection('DOT_COLLISION', 'Actor remains isolated after authenticated history conflict')
        }
        if (existingOperation) {
          this.assertExistingOperationMatches(operation)
          this.runtime.transaction(() => {
            const existingInbox = this.state.findInbox(operation.operationId)
            if (!existingInbox) {
              const stored = this.state.insertInbox(operation, canonicalOperationJson(envelope), now)
              if (stored === 'DOT_COLLISION') {
                throw new SyncApplyRejection(
                  'DOT_COLLISION',
                  `Dot collision at ${operation.actorIncarnationId}/${operation.replicationLaneId}/${operation.sequence}`
                )
              }
              if (stored === 'INSERTED') this.state.markApplied(operation.operationId, now)
            }
          })
          duplicateOperationIds.push(operation.operationId)
          continue
        }
        const authorization = this.authorizationRejection(envelope)
        const fallbackAuthorization =
          this.runtime.listAuthObjects(envelope.syncSpaceId).length === 0
            ? peer.status === 'REVOKED'
              ? 'AUTH_REVOKED'
              : envelope.authEpoch != null && envelope.authEpoch < peer.authEpoch
                ? 'AUTH_EPOCH_CUT'
                : null
            : null
        const rejectionCode = authorization ?? fallbackAuthorization
        if (rejectionCode) {
          const rejectionDigest = `rejected:${operation.operationId}:${peer.authEpoch}:${rejectionCode}`
          let stored: 'INSERTED' | 'DUPLICATE' | 'DOT_COLLISION' = 'DUPLICATE'
          this.runtime.transaction(() => {
            const operationInserted = this.runtime.insertOperationIgnore(operation)
            if (!operationInserted) this.assertExistingOperationMatches(operation)
            stored = this.state.insertInbox(operation, canonicalOperationJson(envelope), now)
            if (stored === 'DOT_COLLISION') {
              throw new SyncApplyRejection(
                'DOT_COLLISION',
                `Dot collision at ${operation.actorIncarnationId}/${operation.replicationLaneId}/${operation.sequence}`
              )
            }
            if (stored === 'INSERTED') {
              this.state.markRejected(operation.operationId, rejectionCode, rejectionDigest, now)
            }
          })
          if (stored === 'DUPLICATE') {
            duplicateOperationIds.push(operation.operationId)
          } else {
            rejected.push({
              operationId: operation.operationId,
              code: rejectionCode,
              message: 'Operation is outside the accepted AUTH coverage',
              rejectionDigest
            })
          }
          continue
        }
        let inserted = false
        this.runtime.transaction(() => {
          inserted = this.runtime.insertOperationIgnore(operation)
          if (!inserted) this.assertExistingOperationMatches(operation)
          const stored = this.state.insertInbox(operation, canonicalOperationJson(envelope), now)
          if (stored === 'DOT_COLLISION') throw new SyncApplyRejection('DOT_COLLISION', `Dot collision at ${operation.actorIncarnationId}/${operation.replicationLaneId}/${operation.sequence}`)
          if (stored === 'DUPLICATE') duplicateOperationIds.push(operation.operationId)
        })
        if (inserted || !duplicateOperationIds.includes(operation.operationId)) acceptedOperationIds.push(operation.operationId)
      } catch (error) {
        const code = error instanceof SyncApplyRejection ? error.code : error instanceof SyncWireValidationError ? error.code : 'INVALID_OPERATION'
        const message = error instanceof Error ? error.message : String(error)
        const operationId = typeof envelope?.operationId === 'string' ? envelope.operationId : null
        rejected.push({ operationId, code, message })
        diagnostics.push({ code: code as SyncDiagnostic['code'], message, retryable: code === 'AUTH_FAILED', at: now })
      }
    }
    return { acceptedOperationIds, duplicateOperationIds, rejected, diagnostics }
  }

  applyPending(syncSpaceId: string, limit = 100, now = Date.now(), policyByLane: Record<string, string> = {}): { appliedOperationIds: string[]; deferredOperationIds: string[]; failedOperationIds: string[] } {
    this.resumeRevokedRollbacks(syncSpaceId, now)
    const appliedOperationIds: string[] = []
    const deferredOperationIds: string[] = []
    const failedOperationIds: string[] = []
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Apply limit must be positive')
    let after: ReturnType<SyncStateRepository['listPendingInbox']>[number] | undefined
    // Scan past deferred pages; keyset pagination is stable as APPLIED rows leave the queue.
    while (appliedOperationIds.length < limit) {
        const pending = this.state.listPendingInbox(syncSpaceId, limit,
          Object.keys(policyByLane).filter((lane) => policyByLane[lane] !== 'ENABLED'), after)
        if (!pending.length) break
        after = pending[pending.length - 1]!
        for (const inbox of pending) {
          if (actorIsolated(this.runtime.databaseHandle(), { space: syncSpaceId, actor: inbox.actorIncarnationId })) {
            deferredOperationIds.push(inbox.operationId)
            continue
          }
          if (appliedOperationIds.length >= limit) break
          const processedPrefix = this.state.processedPrefix(syncSpaceId, inbox.replicationLaneId, inbox.actorIncarnationId)
          const operation = this.runtime.findOperation(inbox.operationId)
          const localDeviceId = this.runtime.findDeviceIdentity()?.deviceId ?? null
          if (operation && localDeviceId && operation.authorDeviceId === localDeviceId) {
            this.runtime.transaction(() => this.state.markApplied(operation.operationId, now))
            appliedOperationIds.push(operation.operationId)
            continue
          }
          const appliedKnowledge = this.runtime.listAppliedFrontiers(syncSpaceId)
            .reduce<SyncCoverage>((result, row) => {
              result[row.replicationLaneId] ??= {}
              result[row.replicationLaneId]![row.actorIncarnationId] = row.appliedPrefix
              return result
            }, {})
          // Locally authored mutations are already materialized before their Builder runs.
          for (const row of this.runtime.databaseHandle().prepare('SELECT replication_lane_id,actor_incarnation_id,last_sequence FROM sync_lane_writer_state WHERE sync_space_id=?').all(syncSpaceId) as Array<{ replication_lane_id: string; actor_incarnation_id: string; last_sequence: number }>) {
            appliedKnowledge[row.replication_lane_id] ??= {}
            appliedKnowledge[row.replication_lane_id]![row.actor_incarnation_id] = Math.max(appliedKnowledge[row.replication_lane_id]![row.actor_incarnation_id] ?? 0, row.last_sequence)
          }
          if (inbox.sequence !== processedPrefix + 1 || !operation || !dependenciesSatisfied(operation.dependencyDotsJson, appliedKnowledge)) {
            deferredOperationIds.push(inbox.operationId)
            continue
          }
          try {
            this.runtime.transaction(() => {
              const lifecycle = this.runtime.findBindingBySpace(syncSpaceId)?.lifecycleState
              if (lifecycle === 'GENESIS_CAPTURING') {
                throw new SyncApplyDeferredError(
                  'Genesis fixed-view capture is in progress; remote Apply is deferred'
                )
              }
              const authorization = this.authorizationRejection(operation)
              if (authorization) {
                this.state.markRejected(
                  operation.operationId,
                  authorization,
                  `rejected:${operation.operationId}:${authorization}`,
                  now
                )
                return
              }
              if (operation.schemaVersion !== 1 || operation.payloadSchemaVersion !== 1 ||
                !['UPSERT', 'FIELD_SET', 'RELATION_SET', 'GLOBAL_DELETE'].includes(operation.operationType)) {
                throw new SyncApplyDeferredError('Unsupported operation schema; retained for a compatible client')
              }
              const authHistory = this.runtime.listAuthObjects(syncSpaceId)
              const stableCheckpointId = this.stabilityCheckpointFor(operation)
              const isProvisional =
                authHistory.length > 0 &&
                operation.authGrantId != null &&
                stableCheckpointId == null
              if (isProvisional && !this.handler.canApplyProvisionally?.(operation)) {
                throw new SyncApplyDeferredError(
                  'AUTH_PROVISIONAL: effect requires AuthStabilityCheckpoint before materialization'
                )
              }
              if (stableCheckpointId) this.state.markAuthorizationStable(operation.operationId, stableCheckpointId)
              this.handler.apply(operation)
              this.state.markApplied(operation.operationId, now)
            })
            if (this.state.findInbox(inbox.operationId)?.state === 'APPLIED') appliedOperationIds.push(inbox.operationId)
          } catch (error) {
            if (error instanceof SyncApplyDeferredError) {
              this.state.markApplyFailure(inbox.operationId, error.message)
              deferredOperationIds.push(inbox.operationId)
            } else {
              this.state.markApplyFailure(inbox.operationId, error instanceof Error ? error.message : String(error))
              failedOperationIds.push(inbox.operationId)
            }
          }
        }
    }
    return { appliedOperationIds, deferredOperationIds, failedOperationIds }
  }

  private resumeRevokedRollbacks(syncSpaceId: string, now = Date.now()): void {
    const revoked = this.state.listRevokedRejectedInbox(syncSpaceId)
    if (!revoked.length) return
    if (!this.handler.rollbackField) {
      throw new Error('REBASE_UNSAFE: rollback handler is unavailable')
    }
    for (const inbox of revoked) {
      const remaining = this.state.findFieldVersionsBySourceOperation(syncSpaceId, inbox.operationId)
      for (const field of remaining) {
        this.handler.rollbackField(
          syncSpaceId,
          field.entityType,
          field.entitySyncId,
          field.fieldId,
          inbox.operationId
        )
      }
      this.state.recalculateAppliedCoverage(
        syncSpaceId,
        inbox.replicationLaneId,
        inbox.actorIncarnationId,
        now
      )
    }
  }

  /** 快照中的 effect 沿用原作者验签和当前 AUTH；转发者签名不能替代操作授权。 */
  verifySnapshotOperation(envelope: SyncOperationEnvelope, publicKeySpkiBase64: string): { operation: SyncOperationRecord; checkpointId: string | null } {
    const operation = decodeSnapshotSignature({ database: this.runtime.databaseHandle(), envelope, publicKey: publicKeySpkiBase64 })
    if (actorIsolated(this.runtime.databaseHandle(), { space: operation.syncSpaceId, actor: operation.actorIncarnationId })) {
      throw new Error('DOT_COLLISION: Snapshot actor remains isolated')
    }
    const existing = this.runtime.findOperationByDot(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence)
    if (existing && existing.syncSpaceId === operation.syncSpaceId && existing.authorDeviceId === operation.authorDeviceId &&
      existing.signingDigest !== operation.signingDigest && verifySyncOperationSignature(operationEnvelopeFromRecord(existing), publicKeySpkiBase64)) {
      isolateActor(this.runtime.databaseHandle(), { first: existing, second: operation, now: Date.now() })
      throw new Error('DOT_COLLISION: authenticated Snapshot actor history conflict')
    }
    const rejection = this.authorizationRejection(envelope)
    if (rejection) throw new Error(rejection + ': Snapshot contains rejected original operation')
    const other = this.runtime.databaseHandle().prepare('SELECT 1 FROM sync_actor_author WHERE sync_space_id=? AND actor_incarnation_id=? AND author_device_id<>? LIMIT 1')
      .get(envelope.syncSpaceId, envelope.actorIncarnationId, envelope.authorDeviceId)
    if (other) throw new Error('AUTH_FAILED: Snapshot actor belongs to another author')
    const checkpointId = this.stabilityCheckpointFor(envelope)
    if (!checkpointId && !this.handler.canApplyProvisionally?.(operation)) throw new Error('AUTH_PROVISIONAL: Snapshot effect requires stable authorization')
    return { operation, checkpointId }
  }

  /** baseline 已完成物化后恢复真实 Inbox，未来撤销仍能定位这些已导入 effect。 */
  restoreSnapshotOperation(envelope: SyncOperationEnvelope, options: SyncIngestOptions): void {
    this.stageSnapshotOperation(envelope, options)
    this.state.markApplied(envelope.operationId, options.now ?? Date.now())
  }

  /** 来源恢复不代表整条业务操作已经完成，完成位由全部 effect 及正文验收后更新。 */
  stageSnapshotOperation(envelope: SyncOperationEnvelope, options: SyncIngestOptions): void {
    const peer = options.resolvePeerKey(envelope.syncSpaceId, envelope.authorDeviceId)
    if (!peer) throw new Error('AUTH_FAILED: unknown Snapshot operation author')
    const proof = this.verifySnapshotOperation(envelope, peer.publicKeySpkiBase64)
    const report = this.ingest([envelope], options)
    if (report.rejected.length || this.state.findInbox(envelope.operationId)?.state === 'REJECTED') throw new Error('AUTH_FAILED: Snapshot operation was rejected')
    if (proof.checkpointId) this.state.markAuthorizationStable(envelope.operationId, proof.checkpointId)
  }

  private authorizationRejection(
    operation: Pick<
      SyncOperationEnvelope,
      'syncSpaceId' | 'authGrantId' | 'authEpoch' | 'authorDeviceId' | 'replicationLaneId' | 'actorIncarnationId' | 'sequence'
    >
  ): 'AUTH_REVOKED' | 'AUTH_EPOCH_CUT' | null {
    const history = this.runtime.listAuthObjects(operation.syncSpaceId)
    if (!history.length) {
      if (this.options.allowUnanchoredTestOperations === true) return null
      throw new SyncApplyRejection('AUTH_FAILED', 'Verified AUTH ledger is required')
    }
    if (operation.authEpoch == null || operation.authEpoch > history.at(-1)!.authEpoch) throw new SyncApplyRejection('AUTH_FAILED', 'Missing or unknown auth epoch')
    const grant = history.find((entry) => entry.authObjectId === operation.authGrantId)
    if (!grant || grant.authEpoch > operation.authEpoch || (grant.objectType === 'SPACE_ROOT' ? grant.ownerDeviceId !== operation.authorDeviceId :
      !['MEMBER_GRANT', 'OWNER_TRANSFER', 'OWNER_RECOVERY'].includes(grant.objectType) || grant.targetDeviceId !== operation.authorDeviceId)) throw new SyncApplyRejection('AUTH_FAILED', 'Invalid author grant')
    const stable = this.stabilityCheckpointFor(operation) != null
    for (const entry of history) {
      const afterGrant = entry.authEpoch > grant.authEpoch || (entry.authEpoch === grant.authEpoch && (entry.authSequence ?? 0) > (grant.authSequence ?? 0))
      if (
        !stable &&
        entry.objectType === 'MEMBER_REVOKE' &&
        entry.targetDeviceId === operation.authorDeviceId &&
        afterGrant &&
        operation.sequence > (entry.revokeCutoffByActorLane?.[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0)
      ) return 'AUTH_REVOKED'
      if (
        ['OWNER_TRANSFER', 'OWNER_RECOVERY'].includes(entry.objectType) &&
        entry.authEpoch > operation.authEpoch! &&
        operation.sequence > (entry.previousEpochFinalAcceptedPrefixByActorLane[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0)
      ) return 'AUTH_EPOCH_CUT'
    }
    return null
  }

  private stabilityCheckpointFor(operation: Pick<SyncOperationEnvelope, 'syncSpaceId' | 'authGrantId' | 'replicationLaneId' | 'actorIncarnationId' | 'sequence'>): string | null {
    const history = this.runtime.listAuthObjects(operation.syncSpaceId)
    const grantIndex = history.findIndex((entry) => entry.authObjectId === operation.authGrantId)
    if (grantIndex < 0) return null
    let checkpointId: string | null = null
    for (const entry of history.slice(grantIndex + 1)) {
      if (entry.objectType !== 'AUTH_STABILITY_CHECKPOINT') continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(entry.payloadJson) as Record<string, unknown>
      } catch {
        continue
      }
      const accepted = payload.acceptedPrefixByActorLane
      if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) continue
      const coverage = accepted as Record<string, Record<string, number>>
      if ((coverage[operation.replicationLaneId]?.[operation.actorIncarnationId] ?? 0) >= operation.sequence) {
        checkpointId = entry.authObjectId
      }
    }
    return checkpointId
  }

  getCoverage(syncSpaceId: string): SyncCoverageVector {
    return this.state.getCoverage(syncSpaceId)
  }

  /**
   * 当收到针对成员的 MEMBER_REVOKE 授权对象时，执行已应用操作的追溯撤销与业务补偿回滚。
   *
   * @param syncSpaceId 同步空间 ID
   * @param targetDeviceId 被撤销的设备 ID
   * @param revokeCutoffByActorLane 各 Lane/Actor 的有效截止前缀（此之后的 sequence 均作废）
   * @param now 当前时间戳
   * @return 回滚影响的操作 ID 与字段列表
   */
  applyRevocationRollback(
    syncSpaceId: string,
    targetDeviceId: string,
    revokeCutoffByActorLane?: SyncCoverage | null,
    now = Date.now()
  ): SyncRevocationRollbackResult {
    return this.runtime.transaction(() => {
      const operations = this.state.listAppliedProvisionalInbox(syncSpaceId)
        .map((inbox) => this.runtime.findOperation(inbox.operationId))
        .filter((op): op is SyncOperationRecord => Boolean(op && op.authorDeviceId === targetDeviceId &&
          op.sequence > (revokeCutoffByActorLane?.[op.replicationLaneId]?.[op.actorIncarnationId] ?? 0)))
      if (!operations.length) return { revokedOperationIds: [], rolledBackFields: [] }
      if (!this.handler.rollbackField) throw new Error('REBASE_UNSAFE: rollback handler is unavailable')
      const affected = operations.flatMap((op) => {
        const fields = this.state.findFieldVersionsBySourceOperation(syncSpaceId, op.operationId)
        if (fields.length === 0 && op.operationType !== 'FIELD_SET') {
          throw new Error('REBASE_UNSAFE: ' + op.operationType + ' has no reconstructable field provenance')
        }
        return fields.map((field) => ({ field, operationId: op.operationId }))
      })
      // Exclude the entire revoked tail before resolving any replacement candidate.
      for (const op of operations) this.state.markRevoked(op.operationId, now)
      for (const { field, operationId } of affected) {
        this.handler.rollbackField(syncSpaceId, field.entityType, field.entitySyncId, field.fieldId, operationId)
      }
      for (const op of operations) this.state.recalculateAppliedCoverage(syncSpaceId, op.replicationLaneId, op.actorIncarnationId, now)
      return {
        revokedOperationIds: operations.map((op) => op.operationId),
        rolledBackFields: affected.map(({ field }) => `${field.entityType}:${field.entitySyncId}:${field.fieldId}`)
      }
    })
  }

  applyEpochTransitionRollback(
    syncSpaceId: string,
    previousEpochFinalAcceptedPrefixByActorLane: SyncCoverage,
    newAuthEpoch: number,
    now = Date.now()
  ): SyncRevocationRollbackResult {
    return this.runtime.transaction(() => {
      const operations = this.state.listAppliedProvisionalInbox(syncSpaceId)
        .map((inbox) => this.runtime.findOperation(inbox.operationId))
        .filter((op): op is SyncOperationRecord => Boolean(
          op &&
          (op.authEpoch ?? -1) < newAuthEpoch &&
          op.sequence > (previousEpochFinalAcceptedPrefixByActorLane[op.replicationLaneId]?.[op.actorIncarnationId] ?? 0)
        ))
      if (!operations.length) return { revokedOperationIds: [], rolledBackFields: [] }
      if (!this.handler.rollbackField) throw new Error('REBASE_UNSAFE: rollback handler is unavailable')
      const affected = operations.flatMap((op) => {
        const fields = this.state.findFieldVersionsBySourceOperation(syncSpaceId, op.operationId)
        if (fields.length === 0 && op.operationType !== 'FIELD_SET') {
          throw new Error('REBASE_UNSAFE: ' + op.operationType + ' has no reconstructable field provenance')
        }
        return fields.map((field) => ({ field, operationId: op.operationId }))
      })
      for (const op of operations) this.state.markRevoked(op.operationId, now)
      for (const { field, operationId } of affected) {
        this.handler.rollbackField(syncSpaceId, field.entityType, field.entitySyncId, field.fieldId, operationId)
      }
      for (const op of operations) {
        this.state.recalculateAppliedCoverage(syncSpaceId, op.replicationLaneId, op.actorIncarnationId, now)
      }
      return {
        revokedOperationIds: operations.map((op) => op.operationId),
        rolledBackFields: affected.map(({ field }) => `${field.entityType}:${field.entitySyncId}:${field.fieldId}`)
      }
    })
  }

  static noOp(): SyncApplyHandler {
    return { apply: () => undefined }
  }

  /** Adapter used by a session when it needs a response-shaped acknowledgement. */
  toBatchResult(report: SyncIngestReport, syncSpaceId: string): SyncOperationBatchResult {
    return {
      acceptedOperationIds: report.acceptedOperationIds,
      duplicateOperationIds: report.duplicateOperationIds,
      rejected: report.rejected,
      coverage: this.state.getCoverage(syncSpaceId),
      serverCursor: null
    }
  }

  private assertExistingOperationMatches(operation: SyncOperationRecord): void {
    const existing = this.runtime.findOperation(operation.operationId) ?? this.runtime.findOperationByDot(
      operation.actorIncarnationId,
      operation.replicationLaneId,
      operation.sequence
    )
    if (!existing || !sameImmutableOperation(existing, operation) || existing.authorSignature !== operation.authorSignature) {
      throw new SyncApplyRejection(
        'DOT_COLLISION',
        `Operation identity collision at ${operation.actorIncarnationId}/${operation.replicationLaneId}/${operation.sequence}`
      )
    }
  }
}

class SyncApplyRejection extends Error {
  constructor(readonly code: 'AUTH_FAILED' | 'AUTH_REVOKED' | 'DOT_COLLISION' | 'INVALID_OPERATION', message: string) {
    super(message)
  }
}

function canonicalOperationJson(envelope: SyncOperationEnvelope): string {
  const withoutTransportKey = { ...envelope }
  delete withoutTransportKey.authorPublicKeySpkiBase64
  return canonicalJson(JSON.stringify(withoutTransportKey))
}

function sameImmutableOperation(left: SyncOperationRecord, right: SyncOperationRecord): boolean {
  return left.operationId === right.operationId &&
    left.syncSpaceId === right.syncSpaceId &&
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
