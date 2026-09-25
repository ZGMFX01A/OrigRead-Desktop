import type {
  SyncOutboxDraft,
  SyncOutboxRecord,
  SyncReplicationLane,
  SyncWritableActorContext
} from '../../shared/sync-runtime'
import { SyncActorRollbackDetectedError } from './sync-runtime-coordinator'
import { SyncRuntimeRepository, type SyncAppliedFrontierRecord } from './sync-runtime-repository'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'

export class DesktopSyncOutboxAllocator {
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly witness: DesktopSyncRollbackWitnessStore
  ) {}

  allocate(
    context: SyncWritableActorContext,
    lane: SyncReplicationLane,
    draft: SyncOutboxDraft,
    additionalObservedFrontiers: SyncAppliedFrontierRecord[] = [],
    now = Date.now()
  ): SyncOutboxRecord {
    if (!['GENESIS_CAPTURING', 'REBASE_PREPARE', 'STAGING', 'ACTIVE'].includes(context.lifecycleState)) {
      throw new Error(`Outbox allocation is not allowed in ${context.lifecycleState}`)
    }

    const writerStates = this.runtime.listWriterStates(context.syncSpaceId, context.actorIncarnationId)
    const laneState = writerStates.find((state) => state.replicationLaneId === lane)
    const databaseHighWater = laneState?.lastSequence ?? 0
    const witnessHighWater = this.witness.highWater(context.actorIncarnationId, lane)
    if (databaseHighWater === 0 && witnessHighWater != null) {
      throw new SyncActorRollbackDetectedError(`Rollback witness is ahead for ${context.actorIncarnationId}/${lane}`)
    }
    if (databaseHighWater > 0 && witnessHighWater !== databaseHighWater) {
      throw new SyncActorRollbackDetectedError(
        `Actor/lane high-water mismatch for ${context.actorIncarnationId}/${lane}: db=${databaseHighWater} witness=${witnessHighWater}`
      )
    }

    const nextSequence = databaseHighWater + 1
    const causalContextJson = freezeCausalContext(
      writerStates,
      [...this.runtime.listAppliedFrontiers(context.syncSpaceId), ...additionalObservedFrontiers],
      context.observedGenesisBaselinesByLane ?? {}
    )
    this.witness.reserveSequence(context.actorIncarnationId, lane, nextSequence)
    this.runtime.upsertWriterState({
      syncSpaceId: context.syncSpaceId,
      actorIncarnationId: context.actorIncarnationId,
      replicationLaneId: lane,
      lastSequence: nextSequence,
      updatedAt: now
    })

    const outbox: SyncOutboxRecord = {
      outboxId: `${context.actorIncarnationId}:${lane}:${nextSequence}`,
      syncSpaceId: context.syncSpaceId,
      actorIncarnationId: context.actorIncarnationId,
      replicationLaneId: lane,
      sequence: nextSequence,
      entityType: draft.entityType,
      entitySyncId: draft.entitySyncId,
      entityGeneration: draft.entityGeneration ?? 0,
      mutationType: draft.mutationType,
      payloadSchemaVersion: draft.payloadSchemaVersion ?? 1,
      payloadJson: draft.payloadJson,
      causalContextJson,
      observedEntityVersionJson: draft.observedEntityVersionJson ?? null,
      status: 'PENDING_BUILD',
      createdAt: now,
      updatedAt: now,
      genesisIncludedAt: null
    }
    this.runtime.insertOutbox(outbox)
    return outbox
  }
}

function freezeCausalContext(
  writerStates: ReturnType<SyncRuntimeRepository['listWriterStates']>,
  applied: SyncAppliedFrontierRecord[],
  observedGenesisBaselinesByLane: Record<string, string[]>
): string {
  const prefixes = new Map<string, number>()
  const merge = (lane: string, actor: string, prefix: number): void => {
    if (prefix <= 0) return
    const key = `${lane}\u0000${actor}`
    prefixes.set(key, Math.max(prefixes.get(key) ?? 0, prefix))
  }
  writerStates.forEach((state) => merge(state.replicationLaneId, state.actorIncarnationId, state.lastSequence))
  applied.forEach((state) => merge(state.replicationLaneId, state.actorIncarnationId, state.appliedPrefix))

  const lanes = new Map<string, Array<{ actorIncarnationId: string; prefix: number }>>()
  for (const [key, prefix] of [...prefixes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const separator = key.indexOf('\u0000')
    if (separator <= 0 || separator >= key.length - 1) throw new Error(`Invalid causal frontier key: ${key}`)
    const lane = key.slice(0, separator)
    const actor = key.slice(separator + 1)
    const values = lanes.get(lane) ?? []
    values.push({ actorIncarnationId: actor, prefix })
    lanes.set(lane, values)
  }
  const result: { schemaVersion: number; lanes: Array<{ replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }>; observedGenesisBaselinesByLane?: Record<string, string[]> } = {
    schemaVersion: 1,
    lanes: [...lanes.entries()].map(([replicationLaneId, actors]) => ({ replicationLaneId, actors }))
  }
  const observed = Object.fromEntries(Object.entries(observedGenesisBaselinesByLane)
    .filter(([, baselines]) => baselines.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lane, baselines]) => [lane, [...new Set(baselines)].sort()]))
  if (Object.keys(observed).length > 0) result.observedGenesisBaselinesByLane = observed
  return JSON.stringify(result)
}
