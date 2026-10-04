import { randomUUID } from 'node:crypto'
import type { FeedRecord } from '../../../shared/library'
import type { JsonBindingProbe, JsonRule, JsonSourceProbeResult } from '../../../shared/json-source'
import type { LibraryRepository } from '../../database/library-repository'
import type { JsonSourceService } from './json-source-service'
import type { JsonSubscriptionService } from './json-subscription-service'

interface RepairSession {
  readonly feed: FeedRecord
  readonly rule: JsonRule | null
  readonly controller: AbortController
  readonly candidates: Map<string, JsonSourceProbeResult>
}

// 预览沿用少量标题展示，完整文章和规则保留在主进程确认会话。
const PREVIEW_TITLE_COUNT = 3

/** 来源探测不写数据，只有仍属于原账户的明确确认才能替换绑定。 */
export class JsonSourceRepairService {
  private readonly sessions = new Map<string, RepairSession>()

  constructor(
    private readonly repository: LibraryRepository,
    private readonly source: JsonSourceService,
    private readonly subscriptions: JsonSubscriptionService
  ) {}

  /** 捕获来源与规则版本；关闭、改输入及换来源时由对应 requestId 取消。 */
  async probe(input: { feedId: string; url: string; requestId: string }): Promise<JsonBindingProbe> {
    this.cancel(input.requestId)
    const feed = this.repository.getFeedById(input.feedId)
    if (!feed || feed.sourceType !== 'json') throw new Error('JSON 来源不存在')
    const session: RepairSession = {
      feed, rule: this.repository.getJsonFeedRule(feed.id), controller: new AbortController(), candidates: new Map()
    }
    this.sessions.set(input.requestId, session)
    try {
      const results = await this.source.probeAll(input.url, session.controller.signal)
      session.controller.signal.throwIfAborted()
      if (this.repository.getCurrentAccountId() !== feed.accountId) throw new Error('账户已切换，请重新探测来源')
      const candidates = results.map((result) => {
        const candidateId = randomUUID()
        session.candidates.set(candidateId, result)
        return { candidateId, name: result.rule.name, sourceKind: result.rule.sourceKind,
          endpointUrl: result.endpointUrl, articleCount: result.articles.length,
          sampleTitles: result.articles.slice(0, PREVIEW_TITLE_COUNT).map((article) => article.title) }
      })
      return { requestId: input.requestId, candidates }
    } catch (error) {
      // 取消与真实探测失败均保留原异常，不生成可确认的伪候选。
      if (this.sessions.get(input.requestId) === session) this.sessions.delete(input.requestId)
      throw error
    }
  }

  /** 候选仅从当前会话读取，不能接受渲染进程提交的规则或文章伪造预览。 */
  async confirm(input: { feedId: string; requestId: string; candidateId: string }): Promise<FeedRecord> {
    const session = this.sessions.get(input.requestId)
    if (!session || session.feed.id !== input.feedId) throw new Error('JSON 探测结果已失效，请重新探测')
    const probe = session.candidates.get(input.candidateId)
    if (!probe) throw new Error('JSON 探测候选不存在')
    const updated = await this.subscriptions.replaceBinding({
      base: session.feed, expectedRule: session.rule, probe, signal: session.controller.signal
    })
    this.sessions.delete(input.requestId)
    return updated
  }

  /** 取消同时中止真实 HTTP 请求并废弃未确认的规则快照。 */
  cancel(requestId: string): boolean {
    const session = this.sessions.get(requestId)
    if (!session) return false
    this.sessions.delete(requestId)
    session.controller.abort(new Error('JSON 来源探测已取消'))
    return true
  }
}
