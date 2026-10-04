import { syncFile, syncDirectory, writeDurableFile, publishDurableFile } from '../security/durable-file'
import { BlobFileVerification } from './sync-blob-file-verification'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncPayloadBlobRef } from '../../shared/sync-protocol'

/** 文件摘要复用固定字节块，校验数千小正文时不按文件积累外部缓冲。 */
const FILE_HASH_BUFFER_BYTES = 64 * 1024

export class DesktopSyncLocalBlobStore {
  private readonly verification = new BlobFileVerification()
  private readonly hashBuffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)
  readonly storageGeneration: string

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
    const generationFile = join(root, '.storage-generation')
    if (!existsSync(generationFile)) writeDurableFile(generationFile, randomUUID())
    this.storageGeneration = readFileSync(generationFile, 'utf8').trim()
    if (!this.storageGeneration) throw new Error('Blob storage generation is corrupted')
  }

  putVerified(hash: string, bytes: Uint8Array): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    if (sha256Hex(bytes) !== hash) throw new Error('Blob bytes do not match declared hash')
    const target = join(this.root, hash)
    if (existsSync(target)) {
      if (statSync(target).size === bytes.byteLength && this.sha256FileHex(target) === hash) {
        // 已有对象也经过同一平台发布屏障，不能凭 hash 正确绕过 NTFS 能力核验。
        publishDurableFile(target, target)
        return
      }
    }
    const temp = join(this.root, `${hash}.tmp-${randomUUID()}`)
    try {
      writeDurableFile(temp, bytes)
      if (this.sha256FileHex(temp) !== hash) throw new Error('Persisted Blob verification failed')
      this.verification.invalidate(target)
      publishDurableFile(temp, target)
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true })
    }
  }

  putUtf8Text(reference: SyncPayloadBlobRef, text: string): void {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.byteLength !== reference.manifest.totalBytes) throw new Error('Blob text size does not match manifest')
    this.putVerified(reference.manifest.hash, bytes)
  }

  readVerified(hash: string): Uint8Array | null {
    const path = join(this.root, hash)
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    if (sha256Hex(bytes) !== hash) {
      rmSync(path, { force: true })
      return null
    }
    // readFileSync 已返回独立所有权的字节；保留 Uint8Array 接口，仅建立视图而不再复制全文。
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  getRoot(): string {
    return this.root
  }

  createStagingPath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    return join(this.root, `${hash}.fetch`)
  }

  /**
   * 获取 Blob 完整路径。
   * 修复 B34：严格校验 64 位十六进制 SHA-256 并验证解析路径在根目录内，彻底防止跨目录逃逸。
   */
  getBlobPath(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null
    const path = join(this.root, hash)
    // 确保规范化路径位于 root 之下
    const resolvedRoot = join(this.root, '')
    if (!path.startsWith(resolvedRoot)) return null
    return existsSync(path) ? path : null
  }

  verifyFile(hash: string, path = join(this.root, hash), force = false): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash) || !existsSync(path)) return false
    return this.verification.verify({ hash, path, force, digest: () => this.sha256FileHex(path) })
  }

  hashFile(path: string): string {
    if (!existsSync(path)) throw new Error('Blob file is missing')
    return this.sha256FileHex(path)
  }

  installVerifiedFile(hash: string, stagedPath: string): number {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    if (!existsSync(stagedPath)) throw new Error('Staged Blob file is missing')
    if (this.sha256FileHex(stagedPath) !== hash) throw new Error('Staged Blob bytes do not match declared hash')
    const target = join(this.root, hash)
    if (existsSync(target) && this.verifyFile(hash, target)) {
      publishDurableFile(target, target)
      if (stagedPath !== target) rmSync(stagedPath, { force: true })
      return Number(statSync(target).size)
    }
    syncFile(stagedPath)
    this.verification.invalidate(target)
    publishDurableFile(stagedPath, target)
    if (this.sha256FileHex(target) !== hash) throw new Error('Persisted Blob verification failed')
    return Number(statSync(target).size)
  }

  remove(hash: string): void {
    if (!/^[0-9a-f]{64}$/.test(hash)) return
    const path = join(this.root, hash)
    if (path.startsWith(join(this.root, ''))) {
      this.verification.invalidate(path)
      rmSync(path, { force: true })
      syncDirectory(this.root)
    }
  }

  /** 同步读取与摘要消费不跨 await；复用块只在实际读取长度内参与 hash。 */
  private sha256FileHex(path: string): string {
    const hash = createHash('sha256'), fd = openSync(path, 'r')
    try {
      while (true) {
        const read = readSync(fd, this.hashBuffer, 0, this.hashBuffer.length, null)
        if (read <= 0) break
        hash.update(this.hashBuffer.subarray(0, read))
      }
    } finally {
      // 摘要失败仍关闭文件句柄，原错误继续向上传播。
      closeSync(fd)
    }
    return hash.digest('hex')
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
