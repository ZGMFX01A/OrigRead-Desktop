/**
 * 网络响应安全流式读取器
 *
 * 集中管理抓取响应的体积上限，防止超大响应、畸形流或压缩炸弹耗尽主进程内存。
 * 支持在流式阶段根据实际接收字节数（解压后体积）累加检查并提前 abort/cancel，
 * 避免一次性调用 response.arrayBuffer() / response.text() 导致内存暴涨。
 */

// RSS / Atom / XML 上限：20 MB
// 理由：既有正常本地大列表 RSS fixture（1200 篇携带 content:encoded 完整正文）实际解压后体积约为 13.2 MB。
// 设定为有界的 20 MB，既能安全包容正常正规的大规模 Feed 同步，又能有效拦截超大畸形流或 Gzip 压缩炸弹。
export const MAX_RSS_RESPONSE_BYTES = 20 * 1024 * 1024

// JSON 抓取上限：10 MB
// 理由：REST API 与内嵌 Next/Nuxt JSON 数据通常在几百 KB 到数 MB，10 MB 足以覆盖正规业务响应并防止无界内存占用。
export const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024

// 网页 HTML 上限：10 MB
// 理由：正常静态网页文章 HTML 经提取清洗后通常在几十 KB 到 2 MB，10 MB 提供了充裕安全边界。
export const MAX_HTML_RESPONSE_BYTES = 10 * 1024 * 1024

/**
 * 响应体大小超限错误
 */
export class ResponsePayloadLimitExceededError extends Error {
  readonly maxBytes: number
  readonly actualBytes?: number

  constructor(maxBytes: number, actualBytes?: number) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(0)
    const detail = actualBytes ? `（当前已读取超过 ${maxMb} MB）` : `（最大允许 ${maxMb} MB）`
    super(`响应体大小超过限制${detail}`)
    this.name = 'ResponsePayloadLimitExceededError'
    this.maxBytes = maxBytes
    this.actualBytes = actualBytes
  }
}

/**
 * 安全地流式读取 Response 字节流，超过 maxBytes 时立即中止并释放资源
 */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  // 1. 检查调用前是否已经 abort
  if (signal?.aborted) {
    if (response.body) {
      try {
        await response.body.cancel(signal.reason)
      } catch {
        // 忽略流取消异常
      }
    }
    signal.throwIfAborted()
  }

  // 2. 检查 Content-Length 头部（若声明的大小已超过上限，尽早终止请求）
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      if (response.body) {
        try {
          await response.body.cancel()
        } catch {
          // 忽略底层流取消异常
        }
      }
      throw new ResponsePayloadLimitExceededError(maxBytes, contentLength)
    }
  }

  // 3. 若无 body，直接返回空字节数组
  if (!response.body) {
    return new Uint8Array()
  }

  // 4. 逐 chunk 读取实际流式字节（解压后体积），累计超限立即 cancel
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  let abortListener: (() => void) | null = null
  if (signal) {
    abortListener = () => {
      reader.cancel(signal.reason).catch(() => {})
    }
    signal.addEventListener('abort', abortListener, { once: true })
  }

  try {
    if (signal?.aborted) {
      try {
        await reader.cancel(signal.reason)
      } catch {
        // 忽略流取消异常
      }
      signal.throwIfAborted()
    }

    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        break
      }
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            // 忽略流取消异常
          }
          throw new ResponsePayloadLimitExceededError(maxBytes, totalBytes)
        }
        chunks.push(value)
      }
    }
    signal?.throwIfAborted()
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener)
    }
    try {
      reader.releaseLock()
    } catch {
      // 忽略已被释放或关闭时的 releaseLock 异常
    }
  }

  // 5. 拼接并返回完整字节
  if (chunks.length === 0) {
    return new Uint8Array()
  }
  if (chunks.length === 1) {
    return chunks[0]!
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

/**
 * 安全地流式读取 Response 文本内容，超过 maxBytes 时立即中止
 */
export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  encoding = 'utf-8'
): Promise<string> {
  const bytes = await readResponseBytes(response, maxBytes, signal)
  return new TextDecoder(encoding).decode(bytes)
}

/**
 * 安全地流式读取 Response JSON，超过 maxBytes 时立即中止
 */
export async function readResponseJson<T = unknown>(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<T> {
  const text = await readResponseText(response, maxBytes, signal)
  return JSON.parse(text) as T
}
