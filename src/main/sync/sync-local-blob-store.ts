import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
      const existing = readFileSync(target)
      if (existing.byteLength === bytes.byteLength && sha256Hex(existing) === hash) return
    }
    const temp = join(this.root, `${hash}.tmp-${randomUUID()}`)
    try {
      writeFileSync(temp, bytes)
      if (sha256Hex(readFileSync(temp)) !== hash) throw new Error('Persisted Blob verification failed')
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

  remove(hash: string): void {
    rmSync(join(this.root, hash), { force: true })
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
