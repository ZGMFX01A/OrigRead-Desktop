/** 用同一个请求 deadline 覆盖响应头、正文读取、取消；消费结束才释放计时器。 */
export function responseWithDeadline(options: {
  response: Response
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  onComplete: () => void
}): Response {
  const { response, controller, timer } = options
  if (!response.body) {
    clearTimeout(timer)
    options.onComplete()
    return response
  }
  const reader = response.body.getReader()
  const cleanup = (): void => {
    clearTimeout(timer)
    options.onComplete()
    controller.signal.removeEventListener('abort', abort)
  }
  let streamController: ReadableStreamDefaultController<Uint8Array>
  const abort = (): void => {
    streamController.error(new Error('Sync response body timed out or was cancelled'))
    void reader.cancel(controller.signal.reason).catch(() => {}) // 取消已失败的底层流，无需覆盖原始超时错误。
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      streamController = value
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
    },
    async pull(value) {
      try {
        const next = await reader.read()
        if (!next.done) { value.enqueue(next.value); return }
        cleanup()
        value.close()
      } catch (error) {
        // 半包、断网与 deadline 必须传给业务调用者，不能变成空正文。
        cleanup()
        if (!controller.signal.aborted) value.error(error)
      }
    },
    async cancel(reason) {
      cleanup()
      await reader.cancel(reason)
    }
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
