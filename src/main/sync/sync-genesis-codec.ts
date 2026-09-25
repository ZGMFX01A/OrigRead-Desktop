import type { SyncReplicationLane } from '../../shared/sync-runtime'
import { canonicalJson } from './sync-operation-canonicalizer'

export interface SyncGenesisFrontierRow {
  replicationLaneId: string
  actorFrontiers: Record<string, number>
}

/** Canonical frontier encoding shared with the Android Genesis Snapshot wire shape. */
export function encodeGenesisFrontiers(frontiers: Record<string, Record<string, number>>): string {
  const rows: SyncGenesisFrontierRow[] = Object.keys(frontiers).sort().map((replicationLaneId) => ({
    replicationLaneId,
    actorFrontiers: Object.fromEntries(Object.entries(frontiers[replicationLaneId] ?? {}).sort(([left], [right]) => compareUtf16(left, right)))
  }))
  return canonicalJson(JSON.stringify(rows))
}

export function decodeGenesisFrontiers(value: string): Record<SyncReplicationLane, Record<string, number>> {
  const parsed = JSON.parse(value) as unknown
  if (Array.isArray(parsed)) {
    const result: Record<string, Record<string, number>> = {}
    for (const row of parsed as SyncGenesisFrontierRow[]) {
      if (!row || typeof row.replicationLaneId !== 'string' || !row.actorFrontiers || typeof row.actorFrontiers !== 'object') {
        throw new Error('Invalid Genesis frontier row')
      }
      result[row.replicationLaneId] = validateActorFrontiers(row.actorFrontiers)
    }
    return result as Record<SyncReplicationLane, Record<string, number>>
  }

  // Accept the short-lived Desktop v16 object shape so an interrupted development build can resume.
  if (parsed && typeof parsed === 'object') {
    const result: Record<string, Record<string, number>> = {}
    for (const [lane, actors] of Object.entries(parsed as Record<string, unknown>)) {
      if (!actors || typeof actors !== 'object' || Array.isArray(actors)) throw new Error(`Invalid Genesis frontier for ${lane}`)
      result[lane] = validateActorFrontiers(actors as Record<string, unknown>)
    }
    return result as Record<SyncReplicationLane, Record<string, number>>
  }
  throw new Error('Invalid Genesis frontier encoding')
}

function validateActorFrontiers(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [actor, prefix] of Object.entries(value)) {
    if (typeof prefix !== 'number' || !Number.isSafeInteger(prefix) || prefix < 0) {
      throw new Error(`Invalid Genesis frontier prefix for ${actor}`)
    }
    result[actor] = prefix
  }
  return result
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
