import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LlmChatRepository } from '../llm/chat-repository'
import { MemorySecretStore } from '../security/secret-store'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopLlmSyncMutationCapture } from './llm-sync-mutation-capture'
import { DesktopSyncOutboxAllocator } from './sync-outbox-allocator'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'

function fixture() {
  const database = new DesktopDatabase(':memory:')
  const runtime = new SyncRuntimeRepository(database.connection)
  const identity = new SyncIdentityRepository(database.connection)
  const witness = new DesktopSyncRollbackWitnessStore(new MemorySecretStore(), 'test-profile')
  const coordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
  const allocator = new DesktopSyncOutboxAllocator(runtime, witness)
  return { database, runtime, identity, witness, coordinator, allocator }
}

describe('R10 SYNC-1 runtime foundation', () => {
  it('captures mutations while the installed baseline is STAGING', () => {
    const { database, runtime, coordinator, allocator } = fixture()
    try {
      coordinator.prepareSpace(1, 'staging-space', 100)
      runtime.upsertBinding({ ...runtime.findBinding(1)!, lifecycleState: 'STAGING' })
      const context = coordinator.currentWritableContext(1)
      expect(context).not.toBeNull()
      runtime.transaction(() => allocator.allocate(context!, 'ARTICLE_STATE', {
        entityType: 'article', entitySyncId: 'article', mutationType: 'FIELD_SET', payloadJson: '{}'
      }))
      expect(runtime.listPendingOutbox('staging-space')).toHaveLength(1)
    } finally { database.close() }
  })

  it('freezes remote applied coverage at mutation time rather than builder time', () => {
    const { database, runtime, coordinator, allocator } = fixture()
    try {
      coordinator.prepareSpace(1, 'space-causal', 100)
      const context = coordinator.beginGenesisCapture(1, 'genesis-causal', 101)
      const state = new SyncStateRepository(database.connection)
      state.upsertCoverage('space-causal', 'ARTICLE_STATE', 'remote', { receivedPrefix: 9, appliedPrefix: 4 }, 102)
      const draft = { entityType: 'article', entitySyncId: 'article', mutationType: 'FIELD_SET' as const, payloadJson: '{"field":"isStarred","value":false}' }
      const first = runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', draft))
      state.upsertCoverage('space-causal', 'ARTICLE_STATE', 'remote', { appliedPrefix: 9 }, 103)
      const second = runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', draft))
      const observed = (raw: string) => JSON.parse(raw).lanes.find((lane: { replicationLaneId: string }) => lane.replicationLaneId === 'ARTICLE_STATE').actors.find((actor: { actorIncarnationId: string }) => actor.actorIncarnationId === 'remote').prefix
      expect(observed(first.causalContextJson)).toBe(4)
      expect(observed(second.causalContextJson)).toBe(9)
    } finally { database.close() }
  })

  it('reuses one Sync Space, clears the Genesis session on ACTIVE, and keeps one writable actor', () => {
    const { database, runtime, coordinator } = fixture()
    try {
      const prepared = coordinator.prepareSpace(1, undefined, 100)
      const preparedAgain = coordinator.prepareSpace(1, undefined, 101)
      expect(preparedAgain.syncSpaceId).toBe(prepared.syncSpaceId)
      expect(preparedAgain.actorIncarnationId).toBe(prepared.actorIncarnationId)

      const capturing = coordinator.beginGenesisCapture(1, 'genesis-1', 102)
      expect(capturing.actorIncarnationId).toBe(prepared.actorIncarnationId)
      expect(runtime.findBinding(1)).toMatchObject({
        lifecycleState: 'GENESIS_CAPTURING',
        genesisSessionId: 'genesis-1'
      })

      const active = coordinator.markActive(1, 103)
      expect(active.actorIncarnationId).toBe(prepared.actorIncarnationId)
      expect(runtime.findBinding(1)).toMatchObject({ lifecycleState: 'ACTIVE', genesisSessionId: null })
    } finally {
      database.close()
    }
  })

  it('allocates contiguous lane Dots, freezes causal context, and rotates after a rolled-back reservation', () => {
    const { database, runtime, coordinator, allocator } = fixture()
    try {
      coordinator.prepareSpace(1, 'space-runtime', 100)
      const context = coordinator.beginGenesisCapture(1, 'genesis-runtime', 101)
      const draft = {
        entityType: 'article',
        entitySyncId: 'sync-article-1',
        mutationType: 'FIELD_SET' as const,
        payloadJson: JSON.stringify({ field: 'isUnread', value: false })
      }

      const first = runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', draft, [], 110))
      const second = runtime.transaction(() => allocator.allocate(context, 'ARTICLE_STATE', draft, [], 111))
      expect([first.sequence, second.sequence]).toEqual([1, 2])
      expect(JSON.parse(first.causalContextJson)).toEqual({ schemaVersion: 1, lanes: [] })
      expect(JSON.parse(second.causalContextJson)).toEqual({
        schemaVersion: 1,
        lanes: [{
          replicationLaneId: 'ARTICLE_STATE',
          actors: [{ actorIncarnationId: context.actorIncarnationId, prefix: 1 }]
        }]
      })

      expect(() => runtime.transaction(() => {
        allocator.allocate(context, 'ARTICLE_STATE', draft, [], 112)
        throw new Error('simulate business rollback')
      })).toThrow('simulate business rollback')

      expect(runtime.listPendingOutbox('space-runtime').map((row) => row.sequence)).toEqual([1, 2])
      const rotated = coordinator.currentWritableContext(1, 113)
      expect(rotated?.actorIncarnationId).not.toBe(context.actorIncarnationId)
      const afterRotation = runtime.transaction(() => allocator.allocate(rotated!, 'ARTICLE_STATE', draft, [], 114))
      expect(afterRotation.sequence).toBe(1)
    } finally {
      database.close()
    }
  })

  it('captures only stable AI history and supports capture inside an existing chat transaction', () => {
    const { database, runtime, coordinator, allocator, witness } = fixture()
    try {
      coordinator.prepareSpace(1, 'space-ai', 100)
      coordinator.beginGenesisCapture(1, 'genesis-ai', 101)
      const capture = new DesktopLlmSyncMutationCapture(database.connection, runtime, coordinator, allocator)
      const repository = new LlmChatRepository(database.connection, capture)

      const conversation = repository.createConversation({ id: 'conversation-ai', now: 110 })
      const streaming = repository.appendMessage(conversation.id, {
        id: 'assistant-ai', role: 'ASSISTANT', status: 'STREAMING', content: '', now: 120
      })
      expect(runtime.listPendingOutbox('space-ai').map((row) => row.entityType)).toEqual(['conversation'])

      repository.updateMessage({ ...streaming, status: 'COMPLETE', content: 'done', updatedAt: 130 })
      repository.setMessagesHistoryActive([streaming.id], false, 140)
      const pending = runtime.listPendingOutbox('space-ai')
      expect(pending.map((row) => [row.replicationLaneId, row.entityType, row.mutationType])).toEqual([
        ['AI_HISTORY', 'conversation', 'UPSERT'],
        ['AI_HISTORY', 'message', 'UPSERT'],
        ['AI_HISTORY', 'message', 'FIELD_SET']
      ])
      expect(pending.map((row) => row.sequence)).toEqual([1, 2, 3])

      // Keep the witness referenced in this test: it must advance with the same actor/lane sequence.
      expect(witness.highWater(pending[0]!.actorIncarnationId, 'AI_HISTORY')).toBe(3)
    } finally {
      database.close()
    }
  })
})
