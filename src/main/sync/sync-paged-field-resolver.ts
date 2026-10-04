import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { createHash } from 'node:crypto'
import { SyncVersionResolver, SyncVersionToken, type SyncFieldCandidate, type SyncGenesisMergePolicy } from './sync-version-token'
import { SyncFieldCausalIndex } from './sync-field-causal-index'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import type { SnapshotCausalFacts } from './sync-snapshot-causal-facts'

interface FieldDecision<T> { candidate: SyncFieldCandidate; digest: string; location: T; facts?: SnapshotCausalFacts }

/** 第一遍只保留轻量因果 metadata，第二遍仅取胜者的完整大字段。 */
export function resolvePagedField(input: { records(): Iterable<SyncSnapshotRecord>; fieldId: string }): SyncSnapshotRecord {
  const entries = function* () {
    for (const record of input.records()) {
      const candidate = fieldCandidate(record)
      yield { candidate, digest: createHash('sha256').update(candidate.valueJson).digest('hex'), location: candidate.versionToken }
    }
  }
  const token = selectFieldWinner(input.fieldId, entries())
  for (const record of input.records()) if (record.value.versionToken === token) return record
  throw new Error('SNAPSHOT_CORRUPTED: winner disappeared from immutable snapshot')
}

/** 页库调用只输入 P3 轻量承诺，因果胜者确定后按精确记录键取一次实际值。 */
export function resolveIndexedPagedField(input: { candidates(): Iterable<SnapshotFieldMetadata>; fieldId: string;
  readWinner(field: SnapshotFieldMetadata): SyncSnapshotRecord }): SyncSnapshotRecord {
  const fields = function* () {
    for (const field of input.candidates()) yield { candidate: fieldCandidate({ kind: 'FIELD_VERSION', key: field.key,
      value: { fieldId: field.fieldId, versionToken: field.versionToken, valueJson: field.preferenceValueJson,
        logicalClock: field.logicalClock, causalContextJson: field.causalContextJson } }, field.causalFacts),
      digest: field.valueDigest, location: field, facts: field.causalFacts }
  }
  return input.readWinner(selectFieldWinner(input.fieldId, fields()))
}

/** 两种正式输入沿用同一因果裁决器；相同 token 的不同承诺仍显式拒绝。 */
function selectFieldWinner<T>(fieldId: string, entries: Iterable<FieldDecision<T>>): T {
  const candidates = new Map<string, SyncFieldCandidate>()
  const digests = new Map<string, string>()
  const locations = new Map<string, T>()
  const index = new SyncFieldCausalIndex()
  for (const { candidate, digest, location, facts } of entries) {
    if (digests.has(candidate.versionToken) && digests.get(candidate.versionToken) !== digest) {
      throw new Error('GENESIS_VERSION_COLLISION: one token has different field values')
    }
    digests.set(candidate.versionToken, digest)
    if (!locations.has(candidate.versionToken)) locations.set(candidate.versionToken, location)
    const light = { ...candidate, valueJson: ['true', 'false'].includes(candidate.valueJson) ? candidate.valueJson : '' }
    candidates.set(light.versionToken, light)
    index.add(light, facts)
  }
  const maximal = [...candidates.values()].filter(candidate => !index.dominated(candidate))
  const policy = maximal.every(candidate => SyncVersionToken.source(candidate.versionToken) === 'GENESIS') ? fieldPolicy(fieldId) : 'DETERMINISTIC'
  let winner: SyncFieldCandidate | undefined
  for (const candidate of maximal) winner = winner ? SyncVersionResolver.resolve([winner, candidate], policy) : candidate
  if (!winner) throw new Error('SNAPSHOT_CORRUPTED: field has no causally maximal candidate')
  return locations.get(winner.versionToken)!
}

/** wire 候选只恢复作者已承诺的因果证据，不添加推测的 observation。 */
function fieldCandidate(record: SyncSnapshotRecord, facts?: SnapshotCausalFacts): SyncFieldCandidate {
  const row = record.value
  if (facts || row.causalContextJson == null) return { versionToken: String(row.versionToken), valueJson: String(row.valueJson),
    logicalClock: Number(row.logicalClock ?? 0), ...facts?.context }
  const context = JSON.parse(String(row.causalContextJson ?? '{}'))
  return { versionToken: String(row.versionToken), valueJson: String(row.valueJson), logicalClock: Number(row.logicalClock ?? 0),
    observedGenesisBaselinesByLane: context.observedGenesisBaselinesByLane,
    causalContext: Object.fromEntries((context.lanes ?? []).map((lane: { replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }) =>
      [lane.replicationLaneId, Object.fromEntries(lane.actors.map(actor => [actor.actorIncarnationId, actor.prefix]))])) }
}

/** 已读/收藏的 Genesis 并发值使用产品偏好，其余字段使用确定性全序。 */
function fieldPolicy(field: string): SyncGenesisMergePolicy { return field === 'isUnread' ? 'READ_WINS' : field === 'isStarred' ? 'STARRED_WINS' : 'DETERMINISTIC' }
