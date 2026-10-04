import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline, Transform } from 'node:stream'

interface BlobFetchResponse {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly blobPath: string
  readonly authorize: () => void
  readonly onFailure: (error: Error) => void
}
interface BlobRange { readonly offset: number; readonly length: number; readonly ranged: boolean }

/** Range 始终指向真实文件字节；格式无效或越界时沿用显式 416 契约。 */
function readRange(header: string | undefined, total: number): BlobRange | null {
  if (!header) return { offset: 0, length: total, ranged: false }
  if (!header.startsWith('bytes=')) return null
  const parts = header.slice('bytes='.length).trim().split('-')
  const start = parts[0] ? Number(parts[0]) : Number.NaN
  const end = parts[1] ? Number(parts[1]) : total - 1
  if (parts.length !== 2 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || start >= total || end < start) return null
  return { offset: start, length: Math.min(end, total - 1) - start + 1, ranged: true }
}

/** 首字节和每个后续块都重新检查当前策略；pipeline 在拒绝或断线时关闭文件和响应。 */
export function sendBlobFile(input: BlobFetchResponse): void {
  input.authorize()
  const total = statSync(input.blobPath).size
  const range = readRange(input.request.headers.range, total)
  if (!range) {
    input.response.writeHead(416, { 'content-type': 'application/json', 'content-range': `bytes */${total}` })
    input.response.end(JSON.stringify({ error: 'RANGE_NOT_SATISFIABLE' }))
    return
  }
  const end = range.offset + range.length - 1
  input.response.writeHead(range.ranged ? 206 : 200, {
    'content-type': 'application/octet-stream', 'content-length': range.length,
    'x-sync-offset': range.offset, 'x-sync-total-bytes': total, 'accept-ranges': 'bytes',
    ...(range.ranged ? { 'content-range': `bytes ${range.offset}-${end}/${total}` } : {})
  })
  if (total === 0) { input.response.end(); return }
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { input.authorize(); callback(null, chunk) }
      catch (error) {
        // 已发送的字节不能追回；明确终止剩余字节，让接收端保留未完成状态。
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
  pipeline(createReadStream(input.blobPath, { start: range.offset, end }), guard, input.response, error => {
    if (error) input.onFailure(error)
  })
}
