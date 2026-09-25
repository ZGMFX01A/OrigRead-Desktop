import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { SyncIdentityRepository } from './sync-identity-repository'

describe('SyncIdentityRepository', () => {
  it('resolves local/sync IDs and keeps canonical duplicates as candidates', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    const repository = new SyncIdentityRepository(db)

    repository.insertSpace({syncSpaceId:'space-1',createdAt:1,updatedAt:1})
    repository.insertMapping({
      syncSpaceId:'space-1', entityType:'feed', localId:'local-1', syncId:'sync-1',
      canonicalKey:'source-key', generation:0, createdAt:1, updatedAt:1
    })
    repository.insertMapping({
      syncSpaceId:'space-1', entityType:'feed', localId:'local-2', syncId:'sync-2',
      canonicalKey:'source-key', generation:0, createdAt:1, updatedAt:1
    })

    expect(repository.findSpace('space-1')?.syncSpaceId).toBe('space-1')
    expect(repository.findByLocalId('space-1','feed','local-1')?.syncId).toBe('sync-1')
    expect(repository.findBySyncId('space-1','feed','sync-2')?.localId).toBe('local-2')
    expect(repository.findCanonicalCandidates('space-1','feed','source-key').map((item)=>item.syncId))
      .toEqual(['sync-1','sync-2'])
    db.close()
  })
})
