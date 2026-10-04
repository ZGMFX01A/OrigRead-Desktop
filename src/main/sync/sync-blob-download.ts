import { createHash, type Hash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { prepareBlobDownload } from './sync-blob-download-retention'
import { writeDurableFile } from '../security/durable-file'
import type { SyncBlobManifest } from '../../shared/sync-protocol'

/** 前缀读取缓冲仅服务续传完整性核验，不载入完整对象。 */
const PREFIX_BUFFER_BYTES = 64 * 1024
interface Input { staging: string; space: string; manifest: SyncBlobManifest }
interface Checkpoint { space: string; hash: string; totalBytes: number; prefix: number; prefixHash: string }

/** 下载任务绑定空间、内容 hash 和长度；网络失败保留经过 flush 的可验证前缀。 */
export class BlobDownload {
  readonly path: string
  private readonly marker: string
  private readonly descriptor: number
  private readonly digest: Hash
  private position: number

  constructor(private readonly input: Input) {
    const identity = createHash('sha256').update(JSON.stringify([input.space, input.manifest.hash, input.manifest.totalBytes])).digest('hex')
    this.path = `${input.staging}-${identity}`
    this.marker = `${this.path}.checkpoint`
    prepareBlobDownload({ path: this.path, totalBytes: input.manifest.totalBytes })
    this.descriptor = openSync(this.path, existsSync(this.path) ? 'r+' : 'w+')
    this.digest = createHash('sha256')
    try {
      const checkpoint = existsSync(this.marker) ? JSON.parse(readFileSync(this.marker, 'utf8')) as Checkpoint : null
      this.position = this.restore(checkpoint)
      ftruncateSync(this.descriptor, this.position)
      this.append(new Uint8Array())
    } catch (error) {
      // 前缀损坏明确失败；删除无效任务后下一次请求才从零开始。
      closeSync(this.descriptor)
      rmSync(this.path, { force: true }); rmSync(this.marker, { force: true })
      throw error
    }
  }

  get offset(): number { return this.position }

  /** 先完整写入/flush，再提交前缀摘要；中止后忽略 marker 之外的未提交字节。 */
  append(bytes: Uint8Array): void {
    if (this.position + bytes.byteLength > this.input.manifest.totalBytes) throw new Error('Fetched Blob exceeds manifest size')
    const written = writeSync(this.descriptor, bytes, 0, bytes.byteLength, this.position)
    if (written !== bytes.byteLength) throw new Error('Fetched Blob file write was incomplete')
    this.digest.update(bytes)
    this.position += written
    fsyncSync(this.descriptor)
    writeDurableFile(this.marker, JSON.stringify({ space: this.input.space, hash: this.input.manifest.hash,
      totalBytes: this.input.manifest.totalBytes, prefix: this.position, prefixHash: this.digest.copy().digest('hex') } satisfies Checkpoint))
  }

  /** 完整对象必须匹配 manifest，marker 在原子安装成功后才释放。 */
  verify(): void {
    if (this.position !== this.input.manifest.totalBytes || this.digest.copy().digest('hex') !== this.input.manifest.hash) {
      rmSync(this.marker, { force: true })
      throw new Error('Fetched Blob content hash or size mismatch')
    }
    fsyncSync(this.descriptor)
  }

  close(): void { closeSync(this.descriptor) }
  complete(): void { rmSync(this.marker, { force: true }) }

  /** 恢复只读取已提交前缀一次，篡改、截断或身份变化不会拼成成功对象。 */
  private restore(checkpoint: Checkpoint | null): number {
    if (!checkpoint) return 0
    if (checkpoint.space !== this.input.space || checkpoint.hash !== this.input.manifest.hash ||
      checkpoint.totalBytes !== this.input.manifest.totalBytes || !Number.isSafeInteger(checkpoint.prefix) ||
      checkpoint.prefix < 0 || checkpoint.prefix > checkpoint.totalBytes || statSync(this.path).size < checkpoint.prefix) {
      throw new Error('BLOB_PARTIAL_CORRUPTED: invalid download checkpoint')
    }
    const buffer = Buffer.allocUnsafe(PREFIX_BUFFER_BYTES)
    let offset = 0
    while (offset < checkpoint.prefix) {
      const count = readSync(this.descriptor, buffer, 0, Math.min(buffer.length, checkpoint.prefix - offset), offset)
      if (count === 0) throw new Error('BLOB_PARTIAL_CORRUPTED: prefix truncated')
      this.digest.update(buffer.subarray(0, count)); offset += count
    }
    if (this.digest.copy().digest('hex') !== checkpoint.prefixHash) throw new Error('BLOB_PARTIAL_CORRUPTED: prefix checksum mismatch')
    return offset
  }
}
