import { parseOperationVersionToken, type SyncFieldCandidate } from './sync-version-token'
import { snapshotCausalFacts, type SnapshotCausalFacts } from './sync-snapshot-causal-facts'

/** 排除当前候选自身后，仍保留最高的一份独立观察证明。 */
const INDEPENDENT_OBSERVERS = 2

/** 仅索引因果证明的最大两位观察者，排除候选自身且不保留正文历史。 */
export class SyncFieldCausalIndex {
  private readonly prefixes = new Map<string, Array<{ token: string; prefix: number }>>()
  private baselines: ReadonlySet<string> = new Set<string>()
  private combinedBaselines?: Set<string>

  /** 同 actor 后继的隐式观察与冻结向量共同组成覆盖证据。 */
  add(candidate: SyncFieldCandidate, prepared?: SnapshotCausalFacts): void {
    const dot = parseOperationVersionToken(candidate.versionToken)
    if (!dot) return
    this.observe(`${dot.replicationLaneId}\n${dot.actorIncarnationId}`, candidate.versionToken, dot.sequence - 1)
    const facts = prepared ?? snapshotCausalFacts(candidate)
    for (const { key, prefix } of facts.prefixes) this.observe(key, candidate.versionToken, prefix)
    this.addBaselines(facts.baselines)
  }

  /** 一个观察者直接借用原集合；只有不同向量同时参与此字段时才建立独立并集。 */
  private addBaselines(values: ReadonlySet<string>): void {
    if (!values.size || this.baselines === values) return
    if (!this.baselines.size) { this.baselines = values; return }
    const combined = this.combinedBaselines ??= new Set(this.baselines)
    for (const value of values) combined.add(value)
    this.baselines = combined
  }

  /** 每个候选只查询自身 Dot；不再对全部历史候选逐对比较。 */
  dominated(candidate: SyncFieldCandidate): boolean {
    const dot = parseOperationVersionToken(candidate.versionToken)
    if (!dot) {
      const parts = candidate.versionToken.split('|')
      return this.baselines.has(`${parts[2]}\n${parts[1]}`)
    }
    return (this.prefixes.get(`${dot.replicationLaneId}\n${dot.actorIncarnationId}`) ?? [])
      .some(observer => observer.token !== candidate.versionToken && observer.prefix >= dot.sequence)
  }

  /** 保留不同观察者的两大 prefix，第一位是自身时仍能判断其他观察者。 */
  private observe(key: string, token: string, prefix: number): void {
    const previous = this.prefixes.get(key) ?? []
    const rows = previous.filter(row => row.token !== token)
    rows.push({ token, prefix: Math.max(prefix, previous.find(row => row.token === token)?.prefix ?? prefix) })
    this.prefixes.set(key, rows.sort((left, right) => right.prefix - left.prefix).slice(0, INDEPENDENT_OBSERVERS))
  }
}
