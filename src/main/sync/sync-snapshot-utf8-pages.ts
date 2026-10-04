import { snapshotCheckpoint } from './sync-snapshot-execution'

export interface SnapshotTextBuffer { bytes: Uint8Array; length: number }
export interface SnapshotTextEncoder { encoder: TextEncoder; scratch: Uint8Array }
/** 每次编码最多这些 UTF-16 码元，四字节字符仍由原始字节连续切页。 */
const TEXT_CHARS = 8 * 1024
/** 每个码元至多三个字节，额外空间容纳边界上的完整代理对。 */
const ENCODING_BYTES = 4 * TEXT_CHARS

/** 一个执行器共用小型编码缓冲，不为每条记录分配完整 UTF-8 数组。 */
export function snapshotTextEncoder(): SnapshotTextEncoder { return { encoder: new TextEncoder(), scratch: new Uint8Array(ENCODING_BYTES) } }

/** 保持既有固定字节页边界，包括 UTF-8 字符跨页；大单条逐块响应取消。 */
export function appendSnapshotText(input: { text: string; encoding: SnapshotTextEncoder; buffer: SnapshotTextBuffer }, flush: () => void): void {
  let offset = 0
  while (offset < input.text.length) {
    snapshotCheckpoint()
    let end = Math.min(input.text.length, offset + TEXT_CHARS)
    const unit = input.text.charCodeAt(end - 1)
    if (end < input.text.length && unit >= 0xd800 && unit <= 0xdbff) end--
    const chunk = input.text.slice(offset, end)
    const result = input.encoding.encoder.encodeInto(chunk, input.encoding.scratch)
    if (result.read !== chunk.length) throw new Error('SNAPSHOT_ENCODING_FAILED: bounded encoder did not consume the complete chunk')
    offset = end
    let read = 0
    while (read < result.written) {
      const take = Math.min(result.written - read, input.buffer.bytes.length - input.buffer.length)
      input.buffer.bytes.set(input.encoding.scratch.subarray(read, read + take), input.buffer.length)
      input.buffer.length += take; read += take
      if (input.buffer.length === input.buffer.bytes.length) flush()
    }
  }
}
