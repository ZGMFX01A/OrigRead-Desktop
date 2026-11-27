import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { WebsiteRuleRepository } from './website-rule-repository'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('WebsiteRuleRepository', () => {
  it('ships the same IT之家 built-in rule and matches subdomains', () => {
    const repository = createRepository()
    const rule = repository.findRule('https://www.ithome.com/')
    expect(rule?.id).toBe('ithome-home')
    expect(rule?.cleanupMode).toBe('URL_ID_RANGE')
    expect(rule?.dateRules.map((item) => item.pattern)).toEqual(['HH:mm', 'MM-dd'])
  })

  it('imports, exports and validates custom rules with Android defaults', () => {
    const repository = createRepository()
    const content = JSON.stringify({ rules: [{
      id: 'sample', name: 'Sample', hosts: ['news.example.com'],
      articleSelectors: ['article.item'], titleSelector: 'a.title'
    }] })
    expect(repository.importRules(content)).toBe(1)
    const rule = repository.findRule('https://m.news.example.com/')
    expect(rule?.linkSelector).toBe('a.title')
    expect(rule?.maxItems).toBe(50)
    const exported = JSON.parse(repository.exportRules())
    expect(exported.schemaVersion).toBe(1)
    expect(exported.rules.some((item: { id: string }) => item.id === 'ithome-home')).toBe(false)
  })

  it('allows a built-in rule to be disabled without exporting its internal marker', () => {
    const repository = createRepository()
    repository.setEnabled('ithome-home', false)
    expect(repository.findConfiguredRules('https://www.ithome.com/')[0]?.enabled).toBe(false)
    expect(repository.findRules('https://www.ithome.com/')).toHaveLength(0)
    expect(JSON.parse(repository.exportRules()).rules.some((item: { id: string }) => item.id === 'ithome-home')).toBe(false)
  })

  it('ignores built-in rules when importing a shared rule file', () => {
    const repository = createRepository()
    expect(repository.importRules(JSON.stringify({ rules: [{ id: 'ithome-home', name: 'spoof', hosts: ['evil.example.com'], articleSelectors: ['article'], titleSelector: 'a' }] }))).toBe(0)
    expect(repository.findConfiguredRules('https://evil.example.com/')).toHaveLength(0)
  })

  it('keeps disabled matching rules visible while excluding them from active parsing', () => {
    const repository = createRepository()
    repository.importRules(JSON.stringify({ rules: [{
      id: 'disabled-sample', name: 'Disabled sample', enabled: false, hosts: ['news.example.com'], articleSelectors: ['article'], titleSelector: 'a'
    }] }))
    expect(repository.findConfiguredRules('https://news.example.com/')).toHaveLength(1)
    expect(repository.findConfiguredRules('https://news.example.com/')[0]?.enabled).toBe(false)
    expect(repository.findRules('https://news.example.com/')).toHaveLength(0)
  })

  it('rejects protocol/path hosts and invalid Android regex syntax', () => {
    const repository = createRepository()
    expect(() => repository.importRules(JSON.stringify({ rules: [{
      id: 'bad', name: 'Bad', hosts: ['https://example.com/path'], articleSelectors: ['article'], titleSelector: 'a'
    }] }))).toThrow(/纯域名/)
    expect(() => repository.importRules(JSON.stringify({ rules: [{
      id: 'bad-regex', name: 'Bad Regex', hosts: ['example.com'], articleSelectors: ['article'], titleSelector: 'a', includeUrlRegex: '['
    }] }))).toThrow()
  })
})

function createRepository(): WebsiteRuleRepository {
  const dir = mkdtempSync(join(tmpdir(), 'origread-website-rules-'))
  dirs.push(dir)
  return new WebsiteRuleRepository(join(dir, 'website-rules.json'))
}


it('preserves corrupt JSON and invalid schema and prevents subsequent overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch2b-rules-'))
  dirs.push(dir)
  const file = join(dir, 'rules.json')
  const repository = new WebsiteRuleRepository(file)
  expect(() => repository.exportRules()).not.toThrow()
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, rules: [] }))
  expect(() => repository.exportRules()).not.toThrow()
  for (const raw of ['{broken', '{}', 'null', '{"rules":[{}],"items":[{}]}']) {
    writeFileSync(file, raw)
    expect(() => repository.exportRules()).toThrow(/损坏.*corrupt-/)
    expect(() => repository.setEnabled('ithome-home', false)).toThrow(/损坏/)
    expect(readFileSync(file, 'utf8')).toBe(raw)
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-')).some((name) => readFileSync(join(dir, name), 'utf8') === raw)).toBe(true)
  }
})

it.each(['false', null, 0])('rejects and preserves rules with non-boolean enabled: %s', (enabled) => {
  const dir = mkdtempSync(join(tmpdir(), 'batch2b-schema-'))
  dirs.push(dir)
  const file = join(dir, 'rules.json')
  const repository = new WebsiteRuleRepository(file)
  const bundle = JSON.parse(repository.exportTemplate())
  bundle.rules[0].enabled = enabled
  const raw = JSON.stringify(bundle)
  writeFileSync(file, raw)
  expect(() => repository.exportRules()).toThrow(/损坏.*enabled/)
  expect(readFileSync(file, 'utf8')).toBe(raw)
  const backup = readdirSync(dir).find((name) => name.includes('.corrupt-'))!
  expect(readFileSync(join(dir, backup), 'utf8')).toBe(raw)
})
