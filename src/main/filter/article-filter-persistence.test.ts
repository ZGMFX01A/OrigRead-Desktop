import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../database/migrations'
import { ArticleFilterRepository } from './article-filter-repository'

describe('transactional CONFIG rule persistence', () => {
  it('imports legacy rules once and recovers committed state after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'origread-config-'))
    let db = new DatabaseSync(join(dir, 'reader.db'))
    try {
      const file = join(dir, 'rules.json')
      new ArticleFilterRepository(file).add('legacy')
      applyMigrations(db)
      const repository = new ArticleFilterRepository(file, db)
      expect(repository.getAll().map((rule) => rule.keyword)).toEqual(['legacy'])
      db.exec('BEGIN IMMEDIATE')
      repository.add('committed')
      db.exec('COMMIT')
      db.close()
      new ArticleFilterRepository(file).add('obsolete-file-change')
      db = new DatabaseSync(join(dir, 'reader.db'))
      expect(new ArticleFilterRepository(file, db).getAll().map((rule) => rule.keyword)).toEqual(['legacy', 'committed'])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls back rule visibility with the surrounding Outbox transaction', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applyMigrations(db)
      // A missing legacy file is valid; SQLite is the authoritative store after construction.
      const repository = new ArticleFilterRepository(join(tmpdir(), 'absent-origread-rules-fixture.json'), db)
      repository.replaceRules([])
      db.exec('BEGIN IMMEDIATE')
      repository.add('uncommitted')
      expect(repository.getAll()).toHaveLength(1)
      db.exec('ROLLBACK')
      expect(repository.getAll()).toEqual([])
    } finally { db.close() }
  })
})
