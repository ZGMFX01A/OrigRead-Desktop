import type { OrigReadDesktopApi } from '../../shared/contracts'
import type { FeedRecord } from '../../shared/library'
import type { JsonBindingProbe } from '../../shared/json-source'

type RepairApi = Pick<OrigReadDesktopApi, 'probeJsonSourceBinding' | 'confirmJsonSourceBinding' | 'cancelJsonSourceBindingProbe'>
interface Publisher {
  readonly setBusy: (busy: boolean) => void
  readonly setError: (error: string | null) => void
}

/** 修复请求与界面生命周期绑定，网络和确认均只发布仍有效的来源结果。 */
export class JsonSourceRepairRequests {
  private requestId: string | null = null

  constructor(private readonly dependencies: { readonly api: RepairApi; readonly createRequestId: () => string }) {}

  /** 关闭或改输入会中止真正请求并废弃快照，取消通信失败保留明确日志。 */
  cancel(): void {
    const requestId = this.requestId
    this.requestId = null
    if (requestId) void this.dependencies.api.cancelJsonSourceBindingProbe(requestId)
      .catch((error) => console.error('取消 JSON 来源探测失败', error))
  }

  /** 展示全部真实成功候选，过期结果和过期异常均不能覆盖新的输入。 */
  async detect(input: { readonly feedId: string; readonly url: string; readonly publisher: Publisher; readonly onProbe: (probe: JsonBindingProbe) => void }): Promise<void> {
    this.cancel()
    const requestId = this.dependencies.createRequestId()
    this.requestId = requestId
    input.publisher.setBusy(true)
    input.publisher.setError(null)
    try {
      const probe = await this.dependencies.api.probeJsonSourceBinding(input.feedId, input.url, requestId)
      if (this.requestId === requestId) input.onProbe(probe)
    } catch (error) {
      // 当前探测保留具体失败原因，导航导致的过期错误只停止发布。
      if (this.requestId === requestId) input.publisher.setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (this.requestId === requestId) input.publisher.setBusy(false)
    }
  }

  /** 确认只提交主进程保存的候选身份，失败保留原来源和可重新选择的预览。 */
  async confirm(input: { readonly feedId: string; readonly probe: JsonBindingProbe; readonly candidateId: string; readonly publisher: Publisher; readonly onChanged: (feed: FeedRecord | null) => void }): Promise<void> {
    const requestId = input.probe.requestId
    if (requestId !== this.requestId) return
    input.publisher.setBusy(true)
    input.publisher.setError(null)
    try {
      const updated = await this.dependencies.api.confirmJsonSourceBinding(input.feedId, requestId, input.candidateId)
      if (this.requestId === requestId) input.onChanged(updated)
    } catch (error) {
      // 账户、绑定版本或存储失败通过现有错误出口报告，不伪装为替换成功。
      if (this.requestId === requestId) input.publisher.setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (this.requestId === requestId) input.publisher.setBusy(false)
    }
  }
}
