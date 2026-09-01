import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildLlmSkillInstructionBundle } from '../../shared/llm-skill'
import { LlmSkillFormatError } from './skill-parser'
import { LlmSkillRepository } from './skill-repository'

function createRepository(): { database: DatabaseSync; repository: LlmSkillRepository } {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  return { database, repository: new LlmSkillRepository(database) }
}

function markdown(name = 'evidence-review', body = 'Use references/GUIDE.md when evidence is weak.'): string {
  return `---
name: ${name}
description: Review evidence quality when the user asks about support for claims.
allowed-tools: Bash(git:*) Read
metadata:
  version: "1.0"
---
${body}
`
}

describe('LlmSkillRepository', () => {
  it('persists standalone skills and preserves enabled/install identity on replacement', async () => {
    const { database, repository } = createRepository()
    try {
      const first = await repository.createFromMarkdown(markdown())
      expect(first.replaced).toBe(false)
      expect(first.skill).toMatchObject({ id: 'evidence-review', enabled: true, allowedTools: 'Bash(git:*) Read' })
      expect(repository.resolve('evidence-review')?.instructions).toContain('Use references/GUIDE.md')

      repository.setEnabled('evidence-review', false)
      const replaced = await repository.createFromMarkdown(markdown('evidence-review', 'Updated workflow.'))
      expect(replaced.replaced).toBe(true)
      expect(replaced.skill.enabled).toBe(false)
      expect(replaced.skill.installedAt).toBe(first.skill.installedAt)
      expect(replaced.skill.contentHash).not.toBe(first.skill.contentHash)
      expect(repository.resolve('evidence-review')).toBeNull()
    } finally {
      database.close()
    }
  })

  it('imports a ZIP in memory, ignores scripts/binary assets, and loads only referenced safe text', async () => {
    const { database, repository } = createRepository()
    try {
      const zip = makeZip({
        'evidence-review/SKILL.md': markdown(),
        'evidence-review/references/GUIDE.md': 'Detailed evidence rubric.',
        'evidence-review/references/UNUSED.md': 'Should not enter the instruction bundle.',
        'evidence-review/scripts/check.py': 'print("never execute")',
        'evidence-review/assets/image.png': Buffer.from([0, 1, 2, 3])
      })
      const result = await repository.importBytes(zip, 'evidence-review.zip')
      expect(result.skill.hasScripts).toBe(true)
      expect(result.skill.resources.map((item) => item.path)).toEqual([
        'references/GUIDE.md',
        'references/UNUSED.md'
      ])
      const bundle = buildLlmSkillInstructionBundle(result.skill)
      expect(bundle).toContain('Detailed evidence rubric.')
      expect(bundle).not.toContain('Should not enter the instruction bundle.')
      expect(bundle).not.toContain('never execute')
      expect(repository.resolve(result.skill.id)).toEqual({ id: result.skill.id, instructions: bundle })
    } finally {
      database.close()
    }
  })

  it('rejects unsafe archive paths before buffering resources', async () => {
    const { database, repository } = createRepository()
    try {
      const zip = makeZip({
        'evidence-review/SKILL.md': markdown(),
        '../escaped.txt': 'nope'
      })
      await expect(repository.importBytes(zip, 'unsafe.zip')).rejects.toThrow(LlmSkillFormatError)
    } finally {
      database.close()
    }
  })

  it('requires enabled bindings and clears them when the skill is deleted', async () => {
    const { database, repository } = createRepository()
    try {
      await repository.createFromMarkdown(markdown())
      repository.setBinding('SUMMARY', 'evidence-review')
      expect(repository.boundSkill('SUMMARY')?.id).toBe('evidence-review')
      repository.setEnabled('evidence-review', false)
      expect(repository.boundSkill('SUMMARY')).toBeNull()
      expect(() => repository.setBinding('TRANSLATION', 'evidence-review')).toThrow('Skill 不存在或未启用')
      repository.delete('evidence-review')
      expect(repository.current().bindings.summarySkillId).toBeNull()
    } finally {
      database.close()
    }
  })

  it('falls back to the last valid state without overwriting a corrupt primary row', async () => {
    const { database, repository } = createRepository()
    try {
      await repository.createFromMarkdown(markdown('first-skill'))
      await repository.createFromMarkdown(markdown('second-skill'))
      database.prepare('UPDATE app_settings SET value=? WHERE key=?').run('{broken', 'llm.skills')

      // The backup is the valid snapshot immediately before second-skill was installed.
      expect(repository.current().skills.map((skill) => skill.id)).toEqual(['first-skill'])
      const primary = database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.skills') as { value: string }
      expect(primary.value).toBe('{broken')
    } finally {
      database.close()
    }
  })

  it('round-trips portable backup state with bindings', async () => {
    const { database, repository } = createRepository()
    const target = createRepository()
    try {
      await repository.createFromMarkdown(markdown())
      repository.setBinding('ARTICLE_ANALYSIS', 'evidence-review')
      const backup = repository.exportBackupState()
      target.repository.validateBackupState(backup)
      target.repository.restoreBackupState(backup)
      expect(target.repository.boundSkill('ARTICLE_ANALYSIS')?.id).toBe('evidence-review')
    } finally {
      database.close()
      target.database.close()
    }
  })
})

/** Minimal deterministic ZIP writer for test fixtures; supports stored/deflated ordinary files only. */
function makeZip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, input] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)
    offset += local.length + compressed.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
