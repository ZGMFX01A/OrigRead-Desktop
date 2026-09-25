import { createHash } from 'node:crypto'
import type {
  SyncBlobChunk,
  SyncBlobManifest,
  SyncBlobPersistedAck,
  SyncEndpointSession,
  SyncPolicyByLane
} from '../../shared/sync-protocol'
import { DesktopSyncBlobStateService } from './sync-blob-state'

export class DesktopSyncBlobTransferCoordinator {
  constructor(private readonly blobState: DesktopSyncBlobStateService) {}

  async upload(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    bytes: Uint8Array,
    session: SyncEndpointSession,
    policyByLane: SyncPolicyByLane,
    chunkBytes = 1024 * 1024,
    now = Date.now()
  ): Promise<SyncBlobPersistedAck | null> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Blob chunk size must be positive')
    if (bytes.byteLength !== manifest.totalBytes) throw new Error('Blob size does not match manifest')
    if (sha256Hex(bytes) !== manifest.hash) throw new Error('Blob content hash does not match manifest')
    this.blobState.registerManifest(manifest, 'READY', now)
    this.blobState.markReadyVerified(manifest.hash, manifest.totalBytes, now)
    if (!this.blobState.transferAllowed(syncSpaceId, manifest.hash, policyByLane)) {
      throw new Error('Blob transfer is blocked by replication lane policy')
    }
    if (!session.pushBlob) throw new Error('Remote endpoint does not support Blob upload')

    const remoteStatus = session.getBlobStatus ? await session.getBlobStatus(manifest.hash) : null
    let offset = 0
    let restart = false
    if (remoteStatus) {
      if (remoteStatus.hash !== manifest.hash || remoteStatus.totalBytes !== manifest.totalBytes) {
        throw new Error('Remote Blob status does not match manifest')
      }
      if (!Number.isSafeInteger(remoteStatus.receivedBytes) || remoteStatus.receivedBytes < 0 ||
        remoteStatus.receivedBytes > manifest.totalBytes) {
        throw new Error('Remote Blob status has an invalid durable prefix')
      }
      if (remoteStatus.complete) {
        if (remoteStatus.receivedBytes !== manifest.totalBytes || remoteStatus.receivedPrefixSha256 !== manifest.hash ||
          !remoteStatus.replicaId || remoteStatus.persistedAt == null) {
          throw new Error('Remote completed Blob status is inconsistent')
        }
        const existingAck: SyncBlobPersistedAck = {
          protocolVersion: 1,
          syncSpaceId,
          hash: manifest.hash,
          replicaId: remoteStatus.replicaId,
          totalBytes: manifest.totalBytes,
          persistedAt: remoteStatus.persistedAt
        }
        this.blobState.recordPersistedAck(existingAck)
        return existingAck
      }
      const localPrefixHash = sha256Hex(bytes.slice(0, remoteStatus.receivedBytes))
      if (localPrefixHash === remoteStatus.receivedPrefixSha256) {
        offset = remoteStatus.receivedBytes
      } else {
        restart = true
      }
    }

    let finalAck: SyncBlobPersistedAck | null = null
    let firstChunk = true
    do {
      const end = Math.min(bytes.byteLength, offset + chunkBytes)
      const isFinal = end === bytes.byteLength
      const chunk: SyncBlobChunk = {
        hash: manifest.hash,
        offset,
        totalBytes: bytes.byteLength,
        bytes: bytes.slice(offset, end),
        isFinal,
        restart: restart && firstChunk
      }
      const ack = await session.pushBlob(chunk)
      if (!isFinal && ack) throw new Error('BlobPersistedAck arrived before the final chunk')
      if (isFinal) finalAck = ack
      offset = end
      firstChunk = false
    } while (offset < bytes.byteLength)

    if (manifest.durability === 'SYNC_DURABLE' && !finalAck) {
      throw new Error('SYNC_DURABLE Blob requires a durable replica acknowledgement')
    }
    if (finalAck) {
      if (finalAck.syncSpaceId !== syncSpaceId || finalAck.hash !== manifest.hash) {
        throw new Error('BlobPersistedAck identity does not match upload')
      }
      this.blobState.recordPersistedAck(finalAck)
    }
    return finalAck
  }

  async fetch(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    session: SyncEndpointSession,
    policyByLane: SyncPolicyByLane,
    persistVerified: (bytes: Uint8Array) => Promise<void> | void,
    chunkBytes = 1024 * 1024,
    now = Date.now()
  ): Promise<Uint8Array> {
    this.blobState.registerManifest(manifest, 'BLOB_MISSING', now)
    if (!this.blobState.transferAllowed(syncSpaceId, manifest.hash, policyByLane)) {
      throw new Error('Blob transfer is blocked by replication lane policy')
    }
    this.blobState.markFetching(manifest.hash, now)
    try {
      const chunks: Uint8Array[] = []
      let offset = 0
      while (true) {
        const chunk = await session.fetchBlob(manifest.hash, { offset, length: chunkBytes })
        if (chunk.hash !== manifest.hash) throw new Error('Fetched Blob hash identity mismatch')
        if (chunk.offset !== offset) throw new Error('Fetched Blob offset is not contiguous')
        if (chunk.totalBytes !== manifest.totalBytes) throw new Error('Fetched Blob size does not match manifest')
        if (chunk.bytes.byteLength === 0 && !chunk.isFinal) throw new Error('Blob fetch made no progress')
        chunks.push(chunk.bytes)
        offset += chunk.bytes.byteLength
        if (offset > manifest.totalBytes) throw new Error('Fetched Blob exceeds manifest size')
        if (chunk.isFinal) {
          if (offset !== manifest.totalBytes) throw new Error('Final Blob chunk is incomplete')
          break
        }
      }
      const bytes = concatChunks(chunks, manifest.totalBytes)
      if (sha256Hex(bytes) !== manifest.hash) throw new Error('Fetched Blob content hash mismatch')
      await persistVerified(bytes)
      this.blobState.markReadyVerified(manifest.hash, manifest.totalBytes, now)
      return bytes
    } catch (error) {
      this.blobState.markFailed(manifest.hash, error instanceof Error ? error.message : String(error), now)
      throw error
    }
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
