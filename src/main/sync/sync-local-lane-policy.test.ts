import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { SyncLocalLanePolicy } from './sync-local-lane-policy'

describe('local lane policy persistence', () => {
  it('keeps pause and resume scoped to the selected Space', () => {
    const database = new DatabaseSync(':memory:')
    try {
      applyMigrations(database)
      new SyncLocalLanePolicy(database).set('first', 'AI_HISTORY', 'PAUSED')
      const reopened = new SyncLocalLanePolicy(database)
      expect(reopened.read('first')).toEqual({ AI_HISTORY: 'PAUSED' })
      expect(reopened.read('second')).toEqual({})
      reopened.set('first', 'AI_HISTORY', 'ENABLED')
      expect(new SyncLocalLanePolicy(database).read('first')).toEqual({ AI_HISTORY: 'ENABLED' })
    } finally { database.close() }
  })
})
