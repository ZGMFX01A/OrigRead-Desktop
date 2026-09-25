import { createHash } from 'node:crypto'
import type { SyncReplicationLane } from '../../shared/sync-runtime'

import type { SyncCoverage } from '../../shared/sync-protocol'

export type SyncVersionSource = 'GENESIS' | 'OPERATION'
export type SyncGenesisMergePolicy = 'DETERMINISTIC' | 'READ_WINS' | 'STARRED_WINS' | 'SET_WINS'

export interface SyncFieldCandidate {
  versionToken: string
  valueJson: string
  source?: SyncVersionSource
  causalContext?: SyncCoverage
  observedGenesisBaselinesByLane?: Record<string, string[]>
  logicalClock?: number
}

export class SyncGenesisVersionCollisionError extends Error {}

export function parseOperationVersionToken(token: string): { actorIncarnationId: string; replicationLaneId: string; sequence: number } | null {
  if (!token.startsWith('OPERATION_V1|')) return null
  const parts = token.split('|')
  if (parts.length !== 4) return null
  const actorIncarnationId = parts[1]!
  const replicationLaneId = parts[2]!
  const sequence = Number(parts[3])
  if (!actorIncarnationId.trim() || !replicationLaneId.trim() || !/^[0-9]+$/.test(parts[3]!) || !Number.isSafeInteger(sequence) || sequence <= 0) return null
  return { actorIncarnationId, replicationLaneId, sequence }
}

/**
 * 判断 candidateA 是否因果上严格先于 candidateB (A happens-before B)
 */
export function happensBefore(candidateA: SyncFieldCandidate, candidateB: SyncFieldCandidate): boolean {
  const sourceA = candidateA.source ?? SyncVersionToken.source(candidateA.versionToken)
  const sourceB = candidateB.source ?? SyncVersionToken.source(candidateB.versionToken)

  // Operation precedence does not imply observation of a late Genesis baseline.
  if (sourceA === 'GENESIS' && sourceB === 'OPERATION') {
    const parts = candidateA.versionToken.split('|')
    return parts.length === 6 && (candidateB.observedGenesisBaselinesByLane?.[parts[2]!] ?? []).includes(parts[1]!)
  }
  if (sourceA === 'OPERATION' && sourceB === 'GENESIS') return false

  // 都是 OPERATION 时，比对 candidateB 的因果上下文是否覆盖了 candidateA 的 Dot
  if (sourceA === 'OPERATION' && sourceB === 'OPERATION') {
    const dotA = parseOperationVersionToken(candidateA.versionToken)
    if (!dotA) return false
    const dotB = parseOperationVersionToken(candidateB.versionToken)
    if (dotB && dotA.actorIncarnationId === dotB.actorIncarnationId && dotA.replicationLaneId === dotB.replicationLaneId && dotA.sequence < dotB.sequence) return true
    if (candidateB.causalContext) {
      const observedSeq = candidateB.causalContext[dotA.replicationLaneId]?.[dotA.actorIncarnationId] ?? 0
      if (observedSeq >= dotA.sequence) {
        return true
      }
    }
  }
  return false
}

export const SyncVersionToken = {
  genesis(
    baselineId: string,
    lane: SyncReplicationLane,
    entitySyncId: string,
    field: string
  ): string {
    if (!baselineId.trim()) throw new Error('genesisBaselineId must not be blank')
    if (!lane.trim()) throw new Error('replicationLaneId must not be blank')
    if (!entitySyncId.trim()) throw new Error('entitySyncId must not be blank')
    if (!field.trim()) throw new Error('fieldId must not be blank')
    const digest = sha256Hex(frame([
      ['genesisBaselineId', baselineId],
      ['replicationLaneId', lane],
      ['entitySyncId', entitySyncId],
      ['fieldId', field]
    ]))
    return `GENESIS_V1|${baselineId}|${lane}|${entitySyncId}|${field}|${digest}`
  },

  operation(actorIncarnationId: string, lane: SyncReplicationLane, sequence: number): string {
    if (!actorIncarnationId.trim()) throw new Error('actorIncarnationId must not be blank')
    if (!lane.trim()) throw new Error('replicationLaneId must not be blank')
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('sequence must be a positive safe integer')
    return `OPERATION_V1|${actorIncarnationId}|${lane}|${sequence}`
  },

  source(versionToken: string): SyncVersionSource {
    if (versionToken.startsWith('GENESIS_V1|')) return 'GENESIS'
    if (versionToken.startsWith('OPERATION_V1|')) return 'OPERATION'
    throw new Error(`Unknown Sync VersionToken: ${versionToken}`)
  }
}

export const SyncVersionResolver = {
  resolve(candidates: SyncFieldCandidate[], policy: SyncGenesisMergePolicy): SyncFieldCandidate {
    if (candidates.length === 0) throw new Error('At least one field candidate is required')
    const byToken = new Map<string, SyncFieldCandidate>()
    for (const candidate of candidates) {
      const source = candidate.source ?? SyncVersionToken.source(candidate.versionToken)
      const normalized = { ...candidate, source }
      const previous = byToken.get(candidate.versionToken)
      if (previous && previous.valueJson !== candidate.valueJson) {
        throw new SyncGenesisVersionCollisionError(`GENESIS_VERSION_COLLISION for ${candidate.versionToken}`)
      }
      byToken.set(candidate.versionToken, normalized)
    }

    const unique = [...byToken.values()]

    // 1. 因果消解：过滤掉被因果覆盖的陈旧候选（A happens-before B 则 A 被裁决淘汰）
    const causalMaximal = unique.filter((candidate) =>
      !unique.some((other) => other !== candidate && happensBefore(candidate, other))
    )

    if (causalMaximal.length === 1) {
      return causalMaximal[0]!
    }

    // 2. 并发候选之间执行业务偏好决胜
    if (causalMaximal.every((candidate) => candidate.source === 'GENESIS') && policy === 'READ_WINS') {
      const unread = causalMaximal.filter((candidate) => candidate.valueJson === 'false').sort(compareToken).at(-1)
      if (unread) return unread
    } else if (causalMaximal.every((candidate) => candidate.source === 'GENESIS') && (policy === 'STARRED_WINS' || policy === 'SET_WINS')) {
      const starred = causalMaximal.filter((candidate) => candidate.valueJson === 'true').sort(compareToken).at(-1)
      if (starred) return starred
    }

    // 3. 确定性字典序全序兜底
    return [...causalMaximal].sort(compareToken).at(-1)!
  }
}

function compareToken(left: SyncFieldCandidate, right: SyncFieldCandidate): number {
  const a = parseOperationVersionToken(left.versionToken)
  const b = parseOperationVersionToken(right.versionToken)
  if (a && b) {
    const text = (x: string, y: string): number => x < y ? -1 : x > y ? 1 : 0
    return (left.logicalClock ?? 0) - (right.logicalClock ?? 0) || text(a.actorIncarnationId, b.actorIncarnationId) || text(a.replicationLaneId, b.replicationLaneId) || a.sequence - b.sequence
  }
  return left.versionToken < right.versionToken ? -1 : left.versionToken > right.versionToken ? 1 : 0
}

function frame(fields: Array<[string, string]>): string {
  return fields.map(([name, value]) => `${name}=${Buffer.byteLength(value, 'utf8')}:${value}\n`).join('')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
