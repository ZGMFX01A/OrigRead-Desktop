import type { DatabaseSync } from 'node:sqlite'
import type { SyncEntityType } from '../../shared/sync-identity'
import type { SyncMutationType } from '../../shared/sync-runtime'
import { CURRENT_ACCOUNT_SETTING_KEY, DEFAULT_LOCAL_ACCOUNT_ID } from '../database/migrations'
import { adoptUuidOrNull, newSyncId } from './sync-canonical-identity'
import { syncPayloadBlobRefs } from './sync-blob-payload'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { DesktopSyncRuntimeCoordinator, SyncActorRollbackDetectedError } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'

export interface LlmSyncMutationCapture {
  capture<T>(
    entityType: SyncEntityType,
    localId: string,
    mutationType: SyncMutationType,
    payloadJson: string,
    mutate: () => T
  ): T

  captureMany<T>(drafts: readonly LlmSyncMutationDraft[], mutate: () => T): T
}

export interface LlmSyncMutationDraft {
  entityType: SyncEntityType
  localId: string
  mutationType: SyncMutationType
  payloadJson: string
}

/** Desktop single-SQLite AI_HISTORY mutation + Outbox transaction boundary. */
export class DesktopLlmSyncMutationCapture implements LlmSyncMutationCapture {
  private readonly identities: SyncIdentityRepository
  private readonly blobs: DesktopSyncBlobStateService

  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: SyncRuntimeRepository,
    private readonly coordinator: DesktopSyncRuntimeCoordinator,
    private readonly allocator: DesktopSyncOutboxAllocator,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.blobs = new DesktopSyncBlobStateService(database)
  }

  capture<T>(
    entityType: SyncEntityType,
    localId: string,
    mutationType: SyncMutationType,
    payloadJson: string,
    mutate: () => T
  ): T {
    return this.captureMany([{ entityType, localId, mutationType, payloadJson }], mutate)
  }

  captureMany<T>(drafts: readonly LlmSyncMutationDraft[], mutate: () => T): T {
    if (drafts.length === 0) return mutate()
    const accountId = this.currentAccountId()
    let context = this.coordinator.currentWritableContext(accountId)
    if (!context) return mutate()

    const attempt = (): T => this.runtime.transaction(() => {
      // First create every owner identity in the batch so relation payloads may safely reference
      // another new entity from the same terminal graph.
      for (const draft of drafts) {
        let mapping = this.identities.findByLocalId(context!.syncSpaceId, draft.entityType, draft.localId)
        if (!mapping) {
          const now = Date.now()
          mapping = {
            syncSpaceId: context!.syncSpaceId,
            entityType: draft.entityType,
            localId: draft.localId,
            syncId: adoptUuidOrNull(draft.localId) ?? newSyncId(),
            canonicalKey: null,
            generation: 0,
            createdAt: now,
            updatedAt: now
          }
          this.identities.insertMapping(mapping)
        }
      }

      for (const draft of drafts) {
        const mapping = this.identities.findByLocalId(context!.syncSpaceId, draft.entityType, draft.localId)
        if (!mapping) throw new Error(`Missing identity mapping for ${draft.entityType}/${draft.localId}`)
        const payloadJson = draft.mutationType === 'GLOBAL_DELETE'
          ? JSON.stringify({ deleted: true })
          : resolveLlmSyncPayloadReferences(this.identities, context!.syncSpaceId, draft.payloadJson)
        const blobRefs = syncPayloadBlobRefs(payloadJson)
        if (blobRefs.length > 0 && !this.localBlobStore) {
          throw new Error('Blob-backed AI_HISTORY mutation requires a local Blob store')
        }
        for (const ref of blobRefs) {
          const bytes = this.localBlobStore!.readVerified(ref.manifest.hash)
          if (!bytes || bytes.byteLength !== ref.manifest.totalBytes) {
            throw new Error(`Local Blob ${ref.manifest.hash} is missing or does not match its manifest`)
          }
          this.blobs.registerManifest(ref.manifest, 'READY')
          this.blobs.replaceOwnerReference(
            context!.syncSpaceId,
            'AI_HISTORY',
            draft.entityType,
            mapping.syncId,
            mapping.generation,
            ref.referenceKind,
            ref.manifest.hash
          )
        }
        if (draft.mutationType === 'GLOBAL_DELETE') {
          this.blobs.removeOwnerReferences(
            context!.syncSpaceId,
            'AI_HISTORY',
            draft.entityType,
            mapping.syncId,
            mapping.generation
          )
        }
        this.allocator.allocate(context!, 'AI_HISTORY', {
          entityType: draft.entityType,
          entitySyncId: mapping.syncId,
          entityGeneration: mapping.generation,
          mutationType: draft.mutationType,
          payloadJson
        })
      }
      return mutate()
    })

    try {
      return attempt()
    } catch (error) {
      if (!(error instanceof SyncActorRollbackDetectedError)) throw error
      context = this.coordinator.rotateActor(accountId, 'ai-history-outbox-witness-mismatch')
      return attempt()
    }
  }

  private currentAccountId(): number {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?')
      .get(CURRENT_ACCOUNT_SETTING_KEY) as { value?: string } | undefined
    const value = Number(row?.value ?? DEFAULT_LOCAL_ACCOUNT_ID)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LOCAL_ACCOUNT_ID
  }

}

export function resolveLlmSyncPayloadReferences(
  identities: SyncIdentityRepository,
  syncSpaceId: string,
  payloadJson: string
): string {
  const root = JSON.parse(payloadJson) as unknown
  const resolve = (value: unknown, isRoot = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => resolve(item))
    if (!value || typeof value !== 'object') return value
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isRoot && key === 'id') continue
      const entityType = localReferenceType(key)
      if (entityType && typeof child === 'string') {
        const mapping = identities.findByLocalId(syncSpaceId, entityType, child)
        if (!mapping) throw new Error(`Missing ${entityType} Sync ID for local reference ${child}`)
        result[syncReferenceKey(key)] = mapping.syncId
      } else {
        result[key] = resolve(child)
      }
    }
    return result
  }
  return JSON.stringify(resolve(root, true))
}

function localReferenceType(key: string): SyncEntityType | null {
  switch (key) {
    case 'conversationLocalId': return 'conversation'
    case 'assistantMessageLocalId': return 'message'
    case 'contextRefLocalId': return 'context_ref'
    case 'evidenceBlockLocalId': return 'evidence_block'
    case 'annotationLocalId': return 'citation_annotation'
    case 'citationRefLocalId': return 'citation_ref'
    case 'articleLocalId': return 'article'
    case 'toolCallLocalId': return 'tool_call'
    default: return null
  }
}

function syncReferenceKey(localKey: string): string {
  return localKey.replace(/LocalId$/, 'SyncId')
}
