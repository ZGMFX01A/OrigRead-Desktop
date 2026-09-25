import { expect, it } from 'vitest'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { resolvePayloadFields } from './sync-payload-merge'

function op(actor: string, clock: number, title: string, context = '{}'): SyncOperationRecord {
  return { operationId: actor, syncSpaceId: 'space', authorDeviceId: actor, actorIncarnationId: actor,
    replicationLaneId: 'AI_HISTORY', sequence: 1, logicalClock: clock, causalContextJson: context,
    dependencyDotsJson: '[]', entityType: 'conversation', entitySyncId: 'chat', entityGeneration: 0,
    operationType: 'UPSERT', payloadSchemaVersion: 1, payloadJson: JSON.stringify({ title }),
    schemaVersion: 1, authGrantId: null, authEpoch: null, createdWallClock: 1,
    payloadHash: '', signingDigest: '', authorSignature: null, buildStatus: 'SIGNED', createdAt: 1, updatedAt: 1 }
}

it('converges on the same AI field after a future causal successor in every arrival order', () => {
  const a = op('a', 9, 'A')
  const b = op('b', 8, 'B')
  const c = op('c', 1, 'C', '{"lanes":[{"replicationLaneId":"AI_HISTORY","actors":[{"actorIncarnationId":"a","prefix":1}]}]}')
  for (const order of [[a,b,c], [a,c,b], [b,a,c], [b,c,a], [c,a,b], [c,b,a]]) {
    expect(resolvePayloadFields(order).get('title')?.valueJson).toBe('"B"')
  }
})

it('merges editable fields independently and keeps explicit null clears', () => {
  const first = { ...op('a', 1, 'Original'), payloadJson: '{"title":"Original","model":"old"}' }
  const second = { ...op('a', 2, 'unused'), sequence: 2, operationType: 'FIELD_SET' as const,
    payloadJson: '{"field":"model","value":null}' }
  const result = resolvePayloadFields([second, first])
  expect(result.get('title')?.valueJson).toBe('"Original"')
  expect(result.get('model')?.valueJson).toBe('null')
})
