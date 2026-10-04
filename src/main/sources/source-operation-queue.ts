/** 同一来源的刷新与规则确认依次提交；不同来源仍可并发抓取。 */
export class SourceOperationQueue {
  private readonly pending = new Map<string, Promise<unknown>>()

  /** 原失败交回原调用者，只让后续操作能够继续执行，不把失败转换为成功结果。 */
  run<T>(feedId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(feedId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.pending.set(feedId, current)
    void current.finally(() => {
      if (this.pending.get(feedId) === current) this.pending.delete(feedId)
    }).catch(() => undefined)
    return current
  }
}
