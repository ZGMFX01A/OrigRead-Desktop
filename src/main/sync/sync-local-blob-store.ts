import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncPayloadBlobRef } from '../../shared/sync-protocol'

export class DesktopSyncLocalBlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  putVerified(hash: string, bytes: Uint8Array): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    if (sha256Hex(bytes) !== hash) throw new Error('Blob bytes do not match declared hash')
    const target = join(this.root, hash)
    if (existsSync(target)) {
      if (statSync(target).size === bytes.byteLength && sha256FileHex(target) === hash) return
    }
    const temp = join(this.root, `${hash}.tmp-${randomUUID()}`)
    try {
      writeFileSync(temp, bytes)
      if (sha256FileHex(temp) !== hash) throw new Error('Persisted Blob verification failed')
      if (existsSync(target)) rmSync(target, { force: true })
      renameSync(temp, target)
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
    return new Uint8Array(bytes)
  }

  getRoot(): string {
    return this.root
  }

  createStagingPath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    return join(this.root, `${hash}.fetch-${randomUUID()}`)
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

  verifyFile(hash: string, path = join(this.root, hash)): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash) || !existsSync(path)) return false
    return sha256FileHex(path) === hash
  }

  hashFile(path: string): string {
    if (!existsSync(path)) throw new Error('Blob file is missing')
    return sha256FileHex(path)
  }

  installVerifiedFile(hash: string, stagedPath: string): number {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Blob hash must be SHA-256 hex')
    if (!existsSync(stagedPath)) throw new Error('Staged Blob file is missing')
    if (sha256FileHex(stagedPath) !== hash) throw new Error('Staged Blob bytes do not match declared hash')
    const target = join(this.root, hash)
    if (existsSync(target) && this.verifyFile(hash, target)) {
      if (stagedPath !== target) rmSync(stagedPath, { force: true })
      return Number(statSync(target).size)
    }
    if (existsSync(target)) rmSync(target, { force: true })
    renameSync(stagedPath, target)
    if (sha256FileHex(target) !== hash) throw new Error('Persisted Blob verification failed')
    return Number(statSync(target).size)
  }

  remove(hash: string): void {
    if (!/^[0-9a-f]{64}$/.test(hash)) return
    const path = join(this.root, hash)
    if (path.startsWith(join(this.root, ''))) {
      rmSync(path, { force: true })
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256FileHex(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
