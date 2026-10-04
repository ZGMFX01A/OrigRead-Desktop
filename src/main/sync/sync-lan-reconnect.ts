// LAN 地址会随进程/网络变化；失败退避后重新发现，避免不断重试已失效的固定端点。
const RETRY_INITIAL_MS = 5_000
const RETRY_MAX_MS = 60_000
const REFRESH_INTERVAL_MS = 30_000

/** 持续启用期间有界发现并同步；停止/换网使旧一轮失效，不会从过期发现启动业务会话。 */
export class SyncLanReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private retryMs = RETRY_INITIAL_MS
  private controller: AbortController | null = null

  constructor(private readonly actions: {
    discover: (signal: AbortSignal) => Promise<void>
    sync: (signal: AbortSignal) => Promise<void>
    onError: (error: unknown) => void
  }) {}

  /** 每次 listener 重建后立即发现，后续成功定期刷新，失败指数退避。 */
  start(): void {
    this.stop()
    this.retryMs = RETRY_INITIAL_MS
    this.controller = new AbortController()
    void this.refresh(this.generation, this.controller)
  }

  stop(): void {
    this.generation++
    this.controller?.abort(new Error('LAN runtime stopped'))
    this.controller = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 一个轮次串行执行发现和 Anti-Entropy；错误保留日志，再使用有界退避。 */
  private async refresh(generation: number, controller: AbortController): Promise<void> {
    let delayMs = REFRESH_INTERVAL_MS
    try {
      await this.actions.discover(controller.signal)
      if (generation !== this.generation) return
      await this.actions.sync(controller.signal)
      this.retryMs = RETRY_INITIAL_MS
    } catch (error) {
      // 生命周期取消结束本轮；实际网络/业务失败仍记录并退避。
      if (controller.signal.aborted) return
      this.actions.onError(error)
      delayMs = this.retryMs
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2)
    }
    if (generation !== this.generation) return
    this.timer = setTimeout(() => { void this.refresh(generation, controller) }, delayMs)
    this.timer.unref?.()
  }
}
