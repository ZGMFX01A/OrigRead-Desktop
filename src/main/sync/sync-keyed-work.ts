/** 相同对象串行执行持久化边界，不同对象的网络工作独立。 */
export class SyncKeyedWork {
  private readonly tails = new Map<string, Promise<void>>()
  /** 错误原样交给调用者；内部尾链仅用于释放队列，不替代任务结果。 */
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(action)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }
}
