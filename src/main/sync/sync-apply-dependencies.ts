import type { SyncCoverage } from '../../shared/sync-protocol'

/** Unrelated paused lanes in causal metadata must not block business application. */
export function dependenciesSatisfied(raw: string, applied: SyncCoverage): boolean {
  try {
    const dots: unknown = JSON.parse(raw)
    return Array.isArray(dots) && dots.every((dot: unknown) => {
      if (!dot || typeof dot !== 'object') return false
      const value = dot as Record<string, unknown>
      return typeof value.actorIncarnationId === 'string' && value.actorIncarnationId.trim().length > 0 &&
        typeof value.replicationLaneId === 'string' && value.replicationLaneId.trim().length > 0 &&
        typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
        (applied[value.replicationLaneId]?.[value.actorIncarnationId] ?? 0) >= value.sequence
    })
  } catch { return false }
}
