import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonRule } from '../../../shared/json-source'
import { JsonRuleRepository } from './json-rule-repository'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('JsonRuleRepository', () => {
  it('imports, merges by id and matches subdomains like Android', () => {
    const { repository } = createRepository()
    expect(repository.importRules(JSON.stringify({ schemaVersion: 1, rules: [rule()] }))).toBe(1)
    expect(repository.findRules('https://news.example.com/posts')).toHaveLength(1)
    expect(repository.findRules('https://other.test/posts')).toHaveLength(0)

    repository.importRules(JSON.stringify({
      schemaVersion: 1,
      rules: [{ ...rule(), name: 'Updated' }]
    }))
    expect(repository.listRules()).toHaveLength(1)
    expect(repository.listRules()[0]!.name).toBe('Updated')
  })

  it('rejects unsafe host and unsupported JSONPath', () => {
    const { repository } = createRepository()
    expect(() => repository.saveRule({ ...rule(), hosts: ['https://example.com'] })).toThrow()
    expect(() => repository.saveRule({ ...rule(), itemsPath: '$..items' })).toThrow()
  })

  it('writes an Android-compatible schemaVersion 1 bundle', () => {
    const { repository, file } = createRepository()
    repository.saveRule(rule())
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.rules[0].sourceKind).toBe('API')
  })

  it('accepts omitted schemaVersion as Android default 1 and rejects invalid sourceKind', () => {
    const { repository } = createRepository()
    expect(repository.importRules(JSON.stringify({ rules: [rule()] }))).toBe(1)
    expect(() => repository.importRules(JSON.stringify({
      schemaVersion: 1,
      rules: [{ ...rule(), sourceKind: 'UNKNOWN' }]
    }))).toThrow(/来源类型/)
  })
})

function createRepository(): { repository: JsonRuleRepository; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'origread-json-rules-'))
  tempDirs.push(directory)
  const file = join(directory, 'json-source-rules.json')
  return { repository: new JsonRuleRepository(file), file }
}

function rule(): JsonRule {
  return {
    id: 'example',
    name: 'Example',
    version: 1,
    enabled: true,
    hosts: ['example.com'],
    sourceKind: 'API',
    endpoint: '/api/posts',
    itemsPath: '$.items[*]',
    titlePath: '$.title',
    linkPath: '$.url',
    datePath: null,
    authorPath: null,
    descriptionPath: null,
    imagePath: null,
    idPath: null,
    dateFormat: null,
    maxItems: 50
  }
}
