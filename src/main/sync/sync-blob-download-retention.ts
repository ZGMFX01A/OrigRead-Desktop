import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 沿用 LAN 暂存 24 小时的续传保留期。 */
const RETENTION_MS = 24 * 60 * 60 * 1000
/** 单对象沿用单 Peer 暂存容量，全部续传任务共享全局容量。 */
const OBJECT_BYTES = 512 * 1024 * 1024
const TOTAL_BYTES = 1024 * 1024 * 1024

/** 只清理过期的下载前缀；正式 Blob 文件和上传暂存不受影响。 */
export function prepareBlobDownload(input: { path: string; totalBytes: number }): void {
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > OBJECT_BYTES) {
    throw new Error('BLOB_STAGING_LIMIT: download exceeds temporary object capacity')
  }
  const root = dirname(input.path)
  let used = 0
  for (const name of readdirSync(root)) {
    if (!/^[a-f0-9]{64}\.fetch-[a-f0-9]{64}$/.test(name)) continue
    const path = join(root, name)
    const marker = `${path}.checkpoint`
    const modified = existsSync(marker) ? statSync(marker).mtimeMs : statSync(path).mtimeMs
    if (path !== input.path && modified < Date.now() - RETENTION_MS) {
      rmSync(path); rmSync(marker, { force: true })
    } else if (path !== input.path) {
      const reserved = existsSync(marker) ? Number(JSON.parse(readFileSync(marker, 'utf8')).totalBytes) : statSync(path).size
      if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error('BLOB_PARTIAL_CORRUPTED: invalid reserved download size')
      used += reserved
    }
  }
  if (used + input.totalBytes > TOTAL_BYTES) throw new Error('BLOB_STAGING_LIMIT: partial downloads exceed temporary capacity')
}
