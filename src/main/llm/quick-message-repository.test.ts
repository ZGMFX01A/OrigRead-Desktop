import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { resolveQuickMessageTemplate } from '../../shared/llm-quick-message'
import { LlmQuickMessageRepository } from './quick-message-repository'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  return { database, repository: new LlmQuickMessageRepository(database) }
}

describe('LlmQuickMessageRepository', () => {
  it('keeps builtin IDs stable while resolving current locale dynamically', () => {
    const { database, repository } = setup()
    try {
      const explain = repository.current()[0]!
      expect(explain).toMatchObject({ id: 'builtin:explain', builtin: 'explain', title: '', content: '' })
      expect(repository.resolveText(explain, 'zh-CN')).toMatchObject({ title: '解释难点' })
      expect(repository.resolveText(explain, 'en-US')).toMatchObject({ title: 'Explain it' })
    } finally { database.close() }
  })

  it('converts an edited builtin into custom content and preserves it across locale changes', () => {
    const { database, repository } = setup()
    try {
      repository.update('builtin:explain', '我的解释', '只解释术语。')
      const edited = repository.current()[0]!
      expect(edited.builtin).toBeNull()
      expect(repository.resolveText(edited, 'en-US')).toEqual({ title: '我的解释', content: '只解释术语。' })
    } finally { database.close() }
  })

  it('supports create, enable, move, delete and portable backup', () => {
    const { database, repository } = setup()
    const target = setup()
    try {
      const created = repository.create('选区解释', '解释：{{selection}}')
      repository.setEnabled(created.id, false)
      repository.move(created.id, -1)
      const backup = repository.exportBackupState()
      target.repository.restoreBackupState(backup)
      expect(target.repository.current().find((message) => message.id === created.id)).toMatchObject({ enabled: false, builtin: null })
      target.repository.delete(created.id)
      expect(target.repository.current().some((message) => message.id === created.id)).toBe(false)
    } finally { database.close(); target.database.close() }
  })

  it('never returns a literal template when required or unknown variables are unavailable', () => {
    const missing = resolveQuickMessageTemplate('Explain {{selection}} for {{article_title}}.', {
      articleTitle: 'Article', articleUrl: null, selection: null, summary: null
    })
    expect(missing).toEqual({ content: null, unavailableVariables: ['selection'], unsupportedVariables: [], ready: false })
    const unknown = resolveQuickMessageTemplate('Use {{mystery}}.', {
      articleTitle: 'Article', articleUrl: null, selection: 'text', summary: null
    })
    expect(unknown.content).toBeNull()
    expect(unknown.unsupportedVariables).toEqual(['mystery'])
    expect(JSON.stringify(unknown)).not.toContain('{{selection}}')
  })

  it('falls back to the last valid snapshot without overwriting a corrupt primary value', () => {
    const { database, repository } = setup()
    try {
      repository.create('One', 'First custom')
      repository.create('Two', 'Second custom')
      database.prepare('UPDATE app_settings SET value=? WHERE key=?').run('{bad', 'llm.quick-messages')
      expect(repository.current().some((message) => message.title === 'One')).toBe(true)
      expect(repository.current().some((message) => message.title === 'Two')).toBe(false)
      expect((database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.quick-messages') as { value: string }).value).toBe('{bad')
    } finally { database.close() }
  })
})
