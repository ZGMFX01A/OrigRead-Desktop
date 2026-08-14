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
    expect(JSON.parse(repository.exportRules()).schemaVersion).toBe(1)
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

