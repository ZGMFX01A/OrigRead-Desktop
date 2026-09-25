import { createHash } from 'node:crypto'
import type { SyncBlobManifest, SyncPayloadBlobRef } from '../../shared/sync-protocol'

export const SYNC_ARTICLE_FULL_CONTENT_FIELD = 'fullContentHtml'
export const SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND = 'article_full_content'

export function syncPayloadBlobRefs(payloadJson: string): SyncPayloadBlobRef[] {
  const root = JSON.parse(payloadJson) as Record<string, unknown>
  const refs = root.blobRefs
  if (refs == null) return []
  if (!Array.isArray(refs)) throw new Error('Operation blobRefs must be an array')
  return refs.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid Operation Blob reference')
    const row = value as { field?: unknown; referenceKind?: unknown; manifest?: unknown }
    if (typeof row.field !== 'string' || typeof row.referenceKind !== 'string' || !row.manifest || typeof row.manifest !== 'object') {
      throw new Error('Invalid Operation Blob reference')
    }
    const manifest = row.manifest as Partial<SyncBlobManifest>
    if (typeof manifest.hash !== 'string' || typeof manifest.totalBytes !== 'number' || typeof manifest.durability !== 'string') {
      throw new Error('Invalid Operation Blob manifest')
    }
    return {
      field: row.field,
      referenceKind: row.referenceKind,
      manifest: {
        hash: manifest.hash,
        totalBytes: manifest.totalBytes,
        mediaType: manifest.mediaType ?? null,
        compression: manifest.compression ?? null,
        encryptionInfoJson: manifest.encryptionInfoJson ?? null,
        availabilityPolicy: manifest.availabilityPolicy ?? 'LAZY',
        durability: manifest.durability as SyncBlobManifest['durability'],
        referenceCount: Number(manifest.referenceCount ?? 0)
      }
    }
  })
}

export function utf8TextBlobRef(
  field: string,
  referenceKind: string,
  text: string,
  durability: SyncBlobManifest['durability'],
  availabilityPolicy = 'LAZY'
): SyncPayloadBlobRef {
  const bytes = Buffer.from(text, 'utf8')
  return {
    field,
    referenceKind,
    manifest: {
      hash: createHash('sha256').update(bytes).digest('hex'),
      totalBytes: bytes.byteLength,
      mediaType: 'text/plain; charset=utf-8',
      compression: null,
      encryptionInfoJson: null,
      availabilityPolicy,
      durability,
      referenceCount: 0
    }
  }
}

export function articleFullContentBlobRef(text: string): SyncPayloadBlobRef {
  return utf8TextBlobRef(
    SYNC_ARTICLE_FULL_CONTENT_FIELD,
    SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND,
    text,
    'REHYDRATABLE',
    'LAZY'
  )
}
