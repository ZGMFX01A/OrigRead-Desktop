import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import type {
  SyncBlobChunk,
  SyncBlobManifest,
  SyncBlobPersistedAck,
  SyncEndpointSession,
  SyncPolicyByLane
} from '../../shared/sync-protocol'
import { DesktopSyncBlobStateService } from './sync-blob-state'

const MAX_IN_MEMORY_BLOB_BYTES = 16 * 1024 * 1024

export class DesktopSyncBlobTransferCoordinator {
  constructor(private readonly blobState: DesktopSyncBlobStateService) {}

  async upload(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    bytes: Uint8Array,
    session: SyncEndpointSession,
    policyByLane: SyncPolicyByLane,
    chunkBytes = 1024 * 1024,
    now = Date.now(),
    onChunkSent: (bytes: number) => Promise<void> | void = () => {}
  ): Promise<SyncBlobPersistedAck | null> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Blob chunk size must be positive')
    if (manifest.totalBytes > MAX_IN_MEMORY_BLOB_BYTES) {
      throw new Error('Blob exceeds the in-memory upload limit; use uploadFile')
    }
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
      await onChunkSent(end - offset)
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

  async uploadFile(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    path: string,
    session: SyncEndpointSession,
    policyByLane: SyncPolicyByLane,
    chunkBytes = 1024 * 1024,
    now = Date.now(),
    onChunkSent: (bytes: number) => Promise<void> | void = () => {}
  ): Promise<SyncBlobPersistedAck | null> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Blob chunk size must be positive')
    const stat = statSync(path)
    if (stat.size !== manifest.totalBytes) throw new Error('Blob size does not match manifest')
    if (sha256FileHex(path) !== manifest.hash) throw new Error('Blob content hash does not match manifest')
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
      if (sha256FileHex(path, remoteStatus.receivedBytes) === remoteStatus.receivedPrefixSha256) {
        offset = remoteStatus.receivedBytes
      } else {
        restart = true
      }
    }

    let finalAck: SyncBlobPersistedAck | null = null
    let firstChunk = true
    const fd = openSync(path, 'r')
    try {
      do {
        const size = Math.min(chunkBytes, manifest.totalBytes - offset)
        const bytes = Buffer.allocUnsafe(size)
        if (size > 0) {
          const read = readSync(fd, bytes, 0, size, offset)
          if (read !== size) throw new Error('Local Blob file ended before expected chunk boundary')
        }
        const end = offset + size
        const isFinal = end === manifest.totalBytes
        const ack = await session.pushBlob({
          hash: manifest.hash,
          offset,
          totalBytes: manifest.totalBytes,
          bytes: new Uint8Array(bytes),
          isFinal,
          restart: restart && firstChunk
        })
        await onChunkSent(size)
        if (!isFinal && ack) throw new Error('BlobPersistedAck arrived before the final chunk')
        if (isFinal) finalAck = ack
        offset = end
        firstChunk = false
      } while (offset < manifest.totalBytes)
    } finally {
      closeSync(fd)
    }
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
    now = Date.now(),
    onChunkReceived: (bytes: number) => Promise<void> | void = () => {}
  ): Promise<Uint8Array> {
    if (manifest.totalBytes > MAX_IN_MEMORY_BLOB_BYTES) {
      throw new Error('Blob exceeds the in-memory fetch limit; use fetchToFile')
    }
    this.blobState.registerManifest(manifest, 'BLOB_MISSING', now)
    if (!this.blobState.transferAllowed(syncSpaceId, manifest.hash, policyByLane)) {
      throw new Error('Blob transfer is blocked by replication lane policy')
    }
    this.blobState.markFetching(manifest.hash, now)
    try {
      if (manifest.totalBytes === 0) {
        const empty = new Uint8Array(0)
        if (sha256Hex(empty) !== manifest.hash) throw new Error('Fetched empty Blob hash mismatch')
        await persistVerified(empty)
        this.blobState.markReadyVerified(manifest.hash, 0, now)
        return empty
      }
      const chunks: Uint8Array[] = []
      let offset = 0
      while (true) {
        const chunk = await session.fetchBlob(manifest.hash, { offset, length: chunkBytes })
        if (chunk.hash !== manifest.hash) throw new Error('Fetched Blob hash identity mismatch')
        if (chunk.offset !== offset) throw new Error('Fetched Blob offset is not contiguous')
        if (chunk.totalBytes !== manifest.totalBytes) throw new Error('Fetched Blob size does not match manifest')
        if (chunk.bytes.byteLength === 0 && !chunk.isFinal) throw new Error('Blob fetch made no progress')
        chunks.push(chunk.bytes)
        await onChunkReceived(chunk.bytes.byteLength)
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

  async fetchToFile(
    syncSpaceId: string,
    manifest: SyncBlobManifest,
    session: SyncEndpointSession,
    policyByLane: SyncPolicyByLane,
    stagedPath: string,
    persistVerified: (path: string) => Promise<void> | void,
    chunkBytes = 1024 * 1024,
    now = Date.now(),
    onChunkReceived: (bytes: number) => Promise<void> | void = () => {}
  ): Promise<void> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Blob chunk size must be positive')
    this.blobState.registerManifest(manifest, 'BLOB_MISSING', now)
    if (!this.blobState.transferAllowed(syncSpaceId, manifest.hash, policyByLane)) {
      throw new Error('Blob transfer is blocked by replication lane policy')
    }
    this.blobState.markFetching(manifest.hash, now)
    if (manifest.totalBytes === 0) {
      try {
        if (sha256Hex(new Uint8Array(0)) !== manifest.hash) throw new Error('Fetched empty Blob hash mismatch')
        const emptyFd = openSync(stagedPath, 'w+')
        closeSync(emptyFd)
        await persistVerified(stagedPath)
        this.blobState.markReadyVerified(manifest.hash, 0, now)
        return
      } catch (error) {
        rmSync(stagedPath, { force: true })
        this.blobState.markFailed(manifest.hash, error instanceof Error ? error.message : String(error), now)
        throw error
      }
    }
    const hash = createHash('sha256')
    let offset = 0
    const fd = openSync(stagedPath, 'w+')
    try {
      while (true) {
        const chunk = await session.fetchBlob(manifest.hash, { offset, length: chunkBytes })
        if (chunk.hash !== manifest.hash) throw new Error('Fetched Blob hash identity mismatch')
        if (chunk.offset !== offset) throw new Error('Fetched Blob offset is not contiguous')
        if (chunk.totalBytes !== manifest.totalBytes) throw new Error('Fetched Blob size does not match manifest')
        if (chunk.bytes.byteLength === 0 && !chunk.isFinal) throw new Error('Blob fetch made no progress')
        if (chunk.bytes.byteLength > 0) {
          const bytes = Buffer.from(chunk.bytes)
          const written = writeSync(fd, bytes, 0, bytes.byteLength, offset)
          if (written !== bytes.byteLength) throw new Error('Fetched Blob file write was incomplete')
          hash.update(bytes)
        }
        await onChunkReceived(chunk.bytes.byteLength)
        offset += chunk.bytes.byteLength
        if (offset > manifest.totalBytes) throw new Error('Fetched Blob exceeds manifest size')
        if (chunk.isFinal) {
          if (offset !== manifest.totalBytes) throw new Error('Final Blob chunk is incomplete')
          break
        }
      }
    } catch (error) {
      closeSync(fd)
      rmSync(stagedPath, { force: true })
      this.blobState.markFailed(manifest.hash, error instanceof Error ? error.message : String(error), now)
      throw error
    }
    closeSync(fd)
    if (statSync(stagedPath).size !== manifest.totalBytes) {
      rmSync(stagedPath, { force: true })
      const error = new Error('Fetched Blob file size mismatch')
      this.blobState.markFailed(manifest.hash, error.message, now)
      throw error
    }
    if (hash.digest('hex') !== manifest.hash) {
      rmSync(stagedPath, { force: true })
      const error = new Error('Fetched Blob content hash mismatch')
      this.blobState.markFailed(manifest.hash, error.message, now)
      throw error
    }
    try {
      await persistVerified(stagedPath)
      this.blobState.markReadyVerified(manifest.hash, manifest.totalBytes, now)
    } catch (error) {
      rmSync(stagedPath, { force: true })
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

function sha256FileHex(path: string, limit = statSync(path).size): string {
  const total = statSync(path).size
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > total) throw new Error('Blob hash prefix is outside the file')
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < limit) {
      const size = Math.min(buffer.length, limit - offset)
      const read = readSync(fd, buffer, 0, size, offset)
      if (read <= 0) throw new Error('Blob file ended before requested hash prefix')
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
