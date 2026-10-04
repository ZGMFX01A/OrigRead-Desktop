import { randomUUID } from 'node:crypto'
import {
  SYNC_REPLICATION_LANES,
  type SyncGenesisSessionRecord,
  type SyncReplicationLane,
  type SyncSpaceLifecycleState,
  type SyncWritableActorContext
} from '../../shared/sync-runtime'
import { SyncIdentityRepository } from './sync-identity-repository'
import { SyncRuntimeRepository, type SyncDeviceIdentityRecord } from './sync-runtime-repository'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { decodeGenesisFrontiers, encodeGenesisFrontiers } from './sync-genesis-codec'
import { SyncStateRepository } from './sync-state-repository'

export class SyncActorRollbackDetectedError extends Error {}

export interface DesktopGenesisCut {
  genesisSessionId: string
  syncSpaceId: string
  genesisBaselineId: string
  crossDbCutId: string
  capturedAt: number
  laneFrontiers: Record<SyncReplicationLane, Record<string, number>>
}

export class DesktopSyncRuntimeCoordinator {
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly identity: SyncIdentityRepository,
    private readonly witness: DesktopSyncRollbackWitnessStore,
    private readonly isAccountSyncEligible: (localAccountId: number) => boolean = () => true
  ) {}

  prepareSpace(localAccountId: number, syncSpaceId?: string, now = Date.now()): SyncWritableActorContext {
    return this.runtime.transaction(() => {
      this.purgeOrphanBindingsLocked(now)
      this.requirePhaseAAccount(localAccountId)
      const existing = this.runtime.findBinding(localAccountId)
      const effectiveSyncSpaceId = existing?.syncSpaceId ?? syncSpaceId ?? randomUUID()
      if (existing && syncSpaceId && existing.syncSpaceId !== syncSpaceId) {
        throw new Error(`Local account ${localAccountId} is already bound to another Sync Space`)
      }
      this.identity.insertSpaceIgnore({ syncSpaceId: effectiveSyncSpaceId, createdAt: now, updatedAt: now })
      // 准备阶段可能执行文件 I/O；既有可写空间不能提前降为不捕获 Outbox 的 PREPARING。
      const lifecycleState = existing?.lifecycleState ?? 'PREPARING'
      this.runtime.upsertBinding({
        localAccountId,
        syncSpaceId: effectiveSyncSpaceId,
        lifecycleState,
        genesisSessionId: existing?.genesisSessionId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
      return this.ensureWritableActor(localAccountId, effectiveSyncSpaceId, lifecycleState, now)
    })
  }

  beginGenesisCapture(localAccountId: number, genesisSessionId: string = randomUUID(), now = Date.now()): SyncWritableActorContext {
    const context = this.updateLifecycle(localAccountId, 'GENESIS_CAPTURING', genesisSessionId, now)
    this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding?.genesisSessionId) throw new Error(`No Genesis session for account ${localAccountId}`)
      const existing = this.runtime.findGenesisSession(binding.genesisSessionId)
      if (existing) {
        this.runtime.upsertGenesisSession({
          ...existing,
          stage: existing.stage === 'FAILED' ? 'CAPTURING' : existing.stage,
          errorMessage: null,
          updatedAt: now
        })
        return
      }
      const session: SyncGenesisSessionRecord = {
        genesisSessionId: binding.genesisSessionId,
        syncSpaceId: binding.syncSpaceId,
        genesisBaselineId: randomUUID(),
        crossDbCutId: randomUUID(),
        stage: 'CAPTURING',
        capturedAt: null,
        laneFrontiersJson: '{}',
        errorMessage: null,
        createdAt: now,
        updatedAt: now
      }
      this.runtime.upsertGenesisSession(session)
    })
    return context
  }

  captureGenesisCut(localAccountId: number, now = Date.now()): DesktopGenesisCut {
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding || binding.lifecycleState !== 'GENESIS_CAPTURING') {
        throw new Error(`Genesis cut requires GENESIS_CAPTURING for account ${localAccountId}`)
      }
      const sessionId = binding.genesisSessionId
      if (!sessionId) throw new Error(`Genesis session is missing for account ${localAccountId}`)
      const existing = this.runtime.findGenesisSession(sessionId)
      if (!existing) throw new Error(`Genesis session ${sessionId} is not persisted`)
      if (existing.stage !== 'CAPTURING' && existing.stage !== 'FAILED') {
        return toGenesisCut(existing)
      }
      if (existing.crossDbCutId && existing.laneFrontiersJson !== '{}') {
        const resumed = { ...existing, stage: 'CUT_CAPTURED' as const, errorMessage: null, updatedAt: now }
        this.runtime.upsertGenesisSession(resumed)
        return toGenesisCut(resumed)
      }

      if (!this.runtime.findActiveActor(binding.syncSpaceId)) throw new Error(`No active actor for ${binding.syncSpaceId}`)
      const actors = this.runtime.listActors(binding.syncSpaceId)
      const appliedCoverage = new SyncStateRepository(this.runtime.databaseHandle()).getCoverage(binding.syncSpaceId).applied
      const laneFrontiers = Object.fromEntries(SYNC_REPLICATION_LANES.map((lane) => {
        const frontier: Record<string, number> = { ...(appliedCoverage[lane] ?? {}) }
        for (const actor of actors) {
          const writerSequence =
            this.runtime.findWriterState(binding.syncSpaceId, actor.actorIncarnationId, lane)?.lastSequence ?? 0
          frontier[actor.actorIncarnationId] = Math.max(frontier[actor.actorIncarnationId] ?? 0, writerSequence)
        }
        return [lane, Object.fromEntries(Object.entries(frontier).filter(([, prefix]) => prefix > 0))]
      })) as Record<SyncReplicationLane, Record<string, number>>
      const captured: SyncGenesisSessionRecord = {
        ...existing,
        stage: 'CUT_CAPTURED',
        capturedAt: now,
        laneFrontiersJson: encodeGenesisFrontiers(laneFrontiers),
        errorMessage: null,
        updatedAt: now
      }
      this.runtime.upsertGenesisSession(captured)
      return toGenesisCut(captured)
    })
  }

  withGenesisBarrier<T>(localAccountId: number, work: (session: SyncGenesisSessionRecord) => T): T {
    const binding = this.runtime.findBinding(localAccountId)
    if (!binding || binding.lifecycleState !== 'GENESIS_CAPTURING') {
      throw new Error(`Genesis barrier requires GENESIS_CAPTURING for account ${localAccountId}`)
    }
    if (!binding.genesisSessionId) throw new Error(`Genesis session is missing for account ${localAccountId}`)
    const session = this.runtime.findGenesisSession(binding.genesisSessionId)
    if (!session || !['CUT_CAPTURED', 'SNAPSHOT_BUILT', 'TAIL_REPLAY', 'ACTIVE'].includes(session.stage)) {
      throw new Error(`Genesis session ${binding.genesisSessionId} is not ready for the barrier`)
    }
    return work(session)
  }

  markActive(localAccountId: number, now = Date.now()): SyncWritableActorContext {
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding) throw new Error(`No Sync Space binding for account ${localAccountId}`)
      this.runtime.upsertBinding({ ...binding, lifecycleState: 'ACTIVE', genesisSessionId: null, updatedAt: now })
      return this.ensureWritableActor(localAccountId, binding.syncSpaceId, 'ACTIVE', now)
    })
  }

  completeGenesisActivation(
    localAccountId: number,
    genesisSessionId: string,
    now = Date.now()
  ): SyncWritableActorContext {
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding) throw new Error(`No Sync Space binding for account ${localAccountId}`)
      const session = this.runtime.findGenesisSession(genesisSessionId)
      if (!session || session.syncSpaceId !== binding.syncSpaceId) {
        throw new Error(`Genesis session ${genesisSessionId} is missing or belongs to another Sync Space`)
      }
      const context = this.ensureWritableActor(localAccountId, binding.syncSpaceId, 'ACTIVE', now)
      this.runtime.upsertBinding({ ...binding, lifecycleState: 'ACTIVE', genesisSessionId: null, updatedAt: now })
      this.runtime.upsertGenesisSession({ ...session, stage: 'ACTIVE', updatedAt: now })
      return context
    })
  }

  currentWritableContext(localAccountId: number, now = Date.now()): SyncWritableActorContext | null {
    return this.runtime.transaction(() => {
      if (!this.isAccountSyncEligible(localAccountId)) return null
      const binding = this.runtime.findBinding(localAccountId)
      if (binding?.lifecycleState === 'REBASE_PREPARE') throw new Error('SYNC_INSTALLING_RETRYABLE: Snapshot installation is unfinished')
      if (!binding || !['GENESIS_CAPTURING', 'STAGING', 'ACTIVE'].includes(binding.lifecycleState)) return null
      return this.ensureWritableActor(localAccountId, binding.syncSpaceId, binding.lifecycleState, now)
    })
  }

  /**
   * Detach only this installation's Local Account from its Sync Space.
   *
   * Deleting an account is a local purge, not a Space-wide GLOBAL_DELETE. Historical Sync
   * metadata remains available for protocol recovery, while the current local Actor is retired so
   * a future account cannot accidentally continue the old writer sequence.
   */
  detachLocalAccount<T>(localAccountId: number, work: () => T, now = Date.now()): T {
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (binding) {
        const active = this.runtime.findActiveActor(binding.syncSpaceId)
        if (active) this.runtime.retireActor(active.actorIncarnationId, now)
        this.runtime.deleteBinding(localAccountId)
      }
      return work()
    })
  }

  /**
   * Repairs Local Account bindings left by builds that deleted the Account row before the R10
   * detach flow existed. Even though Desktop account ids are AUTOINCREMENT, sync_space_id is
   * UNIQUE, so a hidden orphan would otherwise block a later re-join to that historical Space.
   */
  purgeOrphanBindings(now = Date.now()): number {
    return this.runtime.transaction(() => this.purgeOrphanBindingsLocked(now))
  }

  rotateActor(localAccountId: number, reason: string, now = Date.now()): SyncWritableActorContext {
    if (!reason.trim()) throw new Error('Actor rotation reason is required')
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding) throw new Error(`No Sync Space binding for account ${localAccountId}`)
      const active = this.runtime.findActiveActor(binding.syncSpaceId)
      if (active) this.runtime.retireActor(active.actorIncarnationId, now)
      return {
        ...this.createActor(localAccountId, binding.syncSpaceId, binding.lifecycleState, this.ensureDeviceIdentity(now), now),
        observedGenesisBaselinesByLane: this.observedGenesisBaselines(binding.syncSpaceId)
      }
    })
  }

  private updateLifecycle(
    localAccountId: number,
    lifecycleState: SyncSpaceLifecycleState,
    genesisSessionId: string | null,
    now: number
  ): SyncWritableActorContext {
    return this.runtime.transaction(() => {
      const binding = this.runtime.findBinding(localAccountId)
      if (!binding) throw new Error(`No Sync Space binding for account ${localAccountId}`)
      this.runtime.upsertBinding({
        ...binding,
        lifecycleState,
        genesisSessionId: genesisSessionId ?? binding.genesisSessionId,
        updatedAt: now
      })
      return this.ensureWritableActor(localAccountId, binding.syncSpaceId, lifecycleState, now)
    })
  }

  private purgeOrphanBindingsLocked(now: number): number {
    const orphans = this.runtime.listOrphanBindings()
    for (const binding of orphans) {
      const active = this.runtime.findActiveActor(binding.syncSpaceId)
      if (active) this.runtime.retireActor(active.actorIncarnationId, now)
      this.runtime.deleteBinding(binding.localAccountId)
    }
    return orphans.length
  }

  private ensureWritableActor(
    localAccountId: number,
    syncSpaceId: string,
    lifecycleState: SyncSpaceLifecycleState,
    now: number
  ): SyncWritableActorContext {
    this.requirePhaseAAccount(localAccountId)
    const device = this.ensureDeviceIdentity(now)
    const observedGenesisBaselinesByLane = this.observedGenesisBaselines(syncSpaceId)
    const active = this.runtime.findActiveActor(syncSpaceId)
    const mismatch = active ? this.actorWitnessMismatch(active.actorIncarnationId, syncSpaceId) : false
    if (!active || active.deviceId !== device.deviceId || mismatch) {
      if (active) this.runtime.retireActor(active.actorIncarnationId, now)
      return {
        ...this.createActor(localAccountId, syncSpaceId, lifecycleState, device, now),
        observedGenesisBaselinesByLane
      }
    }
    return {
      localAccountId,
      syncSpaceId,
      deviceId: device.deviceId,
      actorIncarnationId: active.actorIncarnationId,
      lifecycleState,
      observedGenesisBaselinesByLane
    }
  }

  private requirePhaseAAccount(localAccountId: number): void {
    if (!this.isAccountSyncEligible(localAccountId)) {
      throw new Error('R10 Phase A only supports Local Account')
    }
  }

  private observedGenesisBaselines(syncSpaceId: string): Record<string, string[]> {
    return this.runtime.observedGenesisBaselinesByLane(syncSpaceId)
  }

  private ensureDeviceIdentity(now: number): SyncDeviceIdentityRecord {
    const stored = this.runtime.findDeviceIdentity()
    const witness = this.witness.snapshot()
    if (stored && witness.deviceId === stored.deviceId && witness.deviceWitnessId === stored.witnessId) return stored

    if (witness.deviceId && witness.deviceWitnessId) {
      const recovered: SyncDeviceIdentityRecord = {
        deviceId: witness.deviceId,
        witnessId: witness.deviceWitnessId,
        createdAt: stored?.createdAt ?? now,
        updatedAt: now
      }
      this.runtime.replaceDeviceIdentity(recovered)
      return recovered
    }

    const replacement: SyncDeviceIdentityRecord = {
      deviceId: randomUUID(),
      witnessId: randomUUID(),
      createdAt: now,
      updatedAt: now
    }
    this.witness.replaceDevice(replacement.deviceId, replacement.witnessId)
    this.runtime.replaceDeviceIdentity(replacement)
    return replacement
  }

  private actorWitnessMismatch(actorIncarnationId: string, syncSpaceId: string): boolean {
    const writerByLane = new Map<string, number>(
      this.runtime.listWriterStates(syncSpaceId, actorIncarnationId)
        .map((state) => [state.replicationLaneId, state.lastSequence] as const)
    )
    const witnessByLane = this.witness.laneHighWater(actorIncarnationId)
    const lanes = new Set([...writerByLane.keys(), ...Object.keys(witnessByLane)])
    return [...lanes].some((lane) => writerByLane.get(lane) !== witnessByLane[lane])
  }

  private createActor(
    localAccountId: number,
    syncSpaceId: string,
    lifecycleState: SyncSpaceLifecycleState,
    device: SyncDeviceIdentityRecord,
    now: number
  ): SyncWritableActorContext {
    const actorIncarnationId = randomUUID()
    this.runtime.insertActor({
      actorIncarnationId,
      syncSpaceId,
      deviceId: device.deviceId,
      status: 'ACTIVE',
      createdAt: now,
      retiredAt: null
    })
    return { localAccountId, syncSpaceId, deviceId: device.deviceId, actorIncarnationId, lifecycleState }
  }
}

function toGenesisCut(session: SyncGenesisSessionRecord): DesktopGenesisCut {
  const laneFrontiers = decodeGenesisFrontiers(session.laneFrontiersJson)
  return {
    genesisSessionId: session.genesisSessionId,
    syncSpaceId: session.syncSpaceId,
    genesisBaselineId: session.genesisBaselineId,
    crossDbCutId: session.crossDbCutId,
    capturedAt: session.capturedAt ?? session.updatedAt,
    laneFrontiers
  }
}
