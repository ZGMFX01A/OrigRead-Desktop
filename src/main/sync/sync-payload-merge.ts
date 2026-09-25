import type { SyncOperationRecord } from '../../shared/sync-runtime'
import type { SyncCoverage } from '../../shared/sync-protocol'
import { canonicalJson } from './sync-operation-canonicalizer'
import { SyncVersionResolver, SyncVersionToken, type SyncFieldCandidate } from './sync-version-token'

export function payloadFieldCandidates(operations: SyncOperationRecord[]): Map<string, SyncFieldCandidate[]> {
  const fields = new Map<string, SyncFieldCandidate[]>()
  for (const operation of operations) {
    const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>
    const values = operation.operationType === 'FIELD_SET'
      ? { [String(payload.field)]: payload.value }
      : ['UPSERT', 'RELATION_SET'].includes(operation.operationType)
        ? (payload.fields ?? payload) as Record<string, unknown> : {}
    const context = JSON.parse(operation.causalContextJson) as {
      lanes?: Array<{ replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }>
      observedGenesisBaselinesByLane?: Record<string, string[]>
    }
    const coverage: SyncCoverage = {}
    for (const lane of context.lanes ?? []) coverage[lane.replicationLaneId] = Object.fromEntries(
      lane.actors.map((actor) => [actor.actorIncarnationId, actor.prefix]))
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) throw new Error('Missing field value')
      const candidates = fields.get(field) ?? []
      candidates.push({ versionToken: SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence),
        valueJson: canonicalJson(JSON.stringify(value)), causalContext: coverage, logicalClock: operation.logicalClock,
        observedGenesisBaselinesByLane: context.observedGenesisBaselinesByLane })
      fields.set(field, candidates)
    }
  }
  return fields
}

export function resolvePayloadFields(operations: SyncOperationRecord[], retained = new Map<string, SyncFieldCandidate[]>()): Map<string, SyncFieldCandidate> {
  const fields = payloadFieldCandidates(operations)
  for (const [field, values] of retained) fields.set(field, [...(fields.get(field) ?? []), ...values])
  return new Map([...fields].map(([field, candidates]) => [field, SyncVersionResolver.resolve(candidates, 'DETERMINISTIC')]))
}
