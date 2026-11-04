import { describe, expect, it } from 'vitest'
import {
  MAX_HTML_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  MAX_RSS_RESPONSE_BYTES,
  readResponseBytes,
  readResponseJson,
  readResponseText,
  ResponsePayloadLimitExceededError
} from './safe-response-reader'

function createStreamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!)
        index += 1
      } else {
        controller.close()
      }
    }
  })
  return new Response(stream, { headers })
}

describe('safe-response-reader', () => {
  it('exposes centralized limit constants of 20MB for RSS and 10MB for JSON and HTML', () => {
    expect(MAX_RSS_RESPONSE_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_JSON_RESPONSE_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_HTML_RESPONSE_BYTES).toBe(10 * 1024 * 1024)
  })

  it('reads normal response with multiple chunks correctly and releases lock', async () => {
    const chunk1 = new TextEncoder().encode('Hello, ')
    const chunk2 = new TextEncoder().encode('OrigRead World!')
    let lockReleased = false

    const stream = new ReadableStream<Uint8Array>({
      start() {},
      pull(controller) {
        controller.enqueue(chunk1)
        controller.enqueue(chunk2)
        controller.close()
      }
    })
    const response = new Response(stream)

    const text = await readResponseText(response, 1024)
    expect(text).toBe('Hello, OrigRead World!')

    // 验证 reader.releaseLock() 已在 finally 中执行（stream.locked 应为 false）
    expect(stream.locked).toBe(false)
  })

  it('reads JSON response correctly', async () => {
    const payload = { articles: [{ id: '1', title: 'Test Article' }] }
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    const response = createStreamResponse([bytes], { 'content-type': 'application/json' })

    const result = await readResponseJson<typeof payload>(response, 1024)
    expect(result).toEqual(payload)
  })

  it('handles empty response body gracefully', async () => {
    const response = new Response(null)
    const bytes = await readResponseBytes(response, 1024)
    expect(bytes.length).toBe(0)
  })

  it('rejects early if Content-Length header exceeds maxBytes', async () => {
    let streamRead = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        streamRead = true
        controller.enqueue(new Uint8Array(100))
        controller.close()
      }
    })
    const response = new Response(stream, {
      headers: { 'content-length': String(25 * 1024 * 1024) }
    })

    await expect(readResponseBytes(response, MAX_RSS_RESPONSE_BYTES)).rejects.toThrow(ResponsePayloadLimitExceededError)
    expect(streamRead).toBe(false)
  })

  it('aborts and rejects during streaming if body exceeds maxBytes even without or with misleading Content-Length', async () => {
    let pullCount = 0
    let streamCancelled = false
    const chunkSize = 1024 * 1024 // 1MB chunks
    const chunk = new Uint8Array(chunkSize)

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1
        controller.enqueue(chunk)
      },
      cancel() {
        streamCancelled = true
      }
    })

    const response = new Response(stream, {
      headers: { 'content-length': '100' } // 具有误导性的小 Content-Length
    })

    const limit = 3 * 1024 * 1024 // 3MB limit
    await expect(readResponseBytes(response, limit)).rejects.toThrow(ResponsePayloadLimitExceededError)

    // 应在读取到第 4 个 chunk（即累计 4MB > 3MB）时立即终止，不会无限读取
    expect(pullCount).toBeLessThanOrEqual(4)
    expect(streamCancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('rejects immediately when signal is already aborted before reading starts', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(10))
      },
      cancel() {
        cancelled = true
      }
    })
    const response = new Response(stream)
    const abortReason = new DOMException('Pre-aborted request', 'AbortError')

    await expect(readResponseBytes(response, 1024, AbortSignal.abort(abortReason))).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Pre-aborted request'
    })
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('aborts reading when external signal is aborted in flight', async () => {
    const controller = new AbortController()
    let streamCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(50))
      },
      cancel() {
        streamCancelled = true
      }
    })

    const response = new Response(stream)
    const promise = readResponseBytes(response, 1024 * 1024, controller.signal)

    controller.abort(new DOMException('User cancelled fetch', 'AbortError'))
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(streamCancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('propagates underlying stream read error and releases lock', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('Connection reset by peer')
      }
    })
    const response = new Response(stream)

    await expect(readResponseBytes(response, 1024 * 1024)).rejects.toThrow('Connection reset by peer')
    expect(stream.locked).toBe(false)
  })

  it('safely handles stream cancel failure without unhandled rejection or masking error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        throw new Error('Cancel failed')
      }
    })
    const response = new Response(stream)

    // 上限 500KB，读取第一个 1MB chunk 触发超限取消，cancel 抛错不应掩盖超限错误
    await expect(readResponseBytes(response, 500 * 1024)).rejects.toThrow(ResponsePayloadLimitExceededError)
    expect(stream.locked).toBe(false)
  })
})
