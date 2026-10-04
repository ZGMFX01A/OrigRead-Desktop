import type { SyncFieldCandidate } from './sync-version-token'

type Context = Pick<SyncFieldCandidate, 'causalContext' | 'observedGenesisBaselinesByLane'>
export interface SnapshotCausalFacts {
  readonly context: Readonly<Context>
  readonly prefixes: readonly { readonly key: string; readonly prefix: number }[]
  readonly baselines: ReadonlySet<string>
}

/** 同一因果向量只展开一次；当前读取器仅保留最近一份完整轻量事实。 */
export class SyncSnapshotCausalFactsReader {
  private recent?: { readonly raw: string; readonly facts: SnapshotCausalFacts }

  /** 文本必须逐字相同才能复用，原 JSON/签名仍由记录和来源验证器检查。 */
  read(raw: string | null): SnapshotCausalFacts | undefined {
    if (raw === null) return undefined
    if (this.recent?.raw === raw) return this.recent.facts
    const context = JSON.parse(raw)
    const causalContext = Object.fromEntries((context.lanes ?? []).map((lane: {
      replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }>
    }) => [lane.replicationLaneId, Object.fromEntries(lane.actors.map(actor => [actor.actorIncarnationId, actor.prefix]))]))
    const facts = snapshotCausalFacts({ causalContext, observedGenesisBaselinesByLane: context.observedGenesisBaselinesByLane })
    this.recent = { raw, facts }
    return facts
  }
}

/** 预先生成观察键及基线集合，字段索引借用不可变事实而不重复创建几十个字符串。 */
export function snapshotCausalFacts(input: Context): SnapshotCausalFacts {
  const causalContext = Object.fromEntries(Object.entries(input.causalContext ?? {}).map(([lane, actors]) =>
    [lane, Object.freeze({ ...actors })]))
  const observedGenesisBaselinesByLane = Object.fromEntries(Object.entries(input.observedGenesisBaselinesByLane ?? {}).map(([lane, ids]) => {
    const copy = [...ids]
    Object.freeze(copy)
    return [lane, copy]
  }))
  const prefixes = Object.entries(causalContext).flatMap(([lane, actors]) => Object.entries(actors)
    .map(([actor, prefix]) => Object.freeze({ key: `${lane}\n${actor}`, prefix })))
  const baselines = new Set(Object.entries(observedGenesisBaselinesByLane).flatMap(([lane, ids]) => ids.map(id => `${lane}\n${id}`)))
  return Object.freeze({ context: Object.freeze({ causalContext: Object.freeze(causalContext),
    observedGenesisBaselinesByLane: Object.freeze(observedGenesisBaselinesByLane) }), prefixes: Object.freeze(prefixes), baselines })
}
