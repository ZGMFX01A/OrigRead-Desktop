import { describe, expect, it } from 'vitest'
import { llmSkillContentHash, LlmSkillFormatError, parseLlmSkillMarkdown } from './skill-parser'

describe('LlmSkillParser', () => {
  it('parses Agent Skills frontmatter, metadata, multiline scalars and allowed-tools', () => {
    const parsed = parseLlmSkillMarkdown(`---
name: evidence-review
description: >
  Review article evidence and
  explain weak support.
license: Apache-2.0
compatibility: "OrigRead Desktop"
allowed-tools: Read Bash(git:*)
metadata:
  version: "1.2"
  origread-display-name: Evidence Review
---
# Workflow

Read references/GUIDE.md before reviewing claims.
`)

    expect(parsed).toEqual({
      name: 'evidence-review',
      description: 'Review article evidence and explain weak support.',
      instructions: '# Workflow\n\nRead references/GUIDE.md before reviewing claims.',
      license: 'Apache-2.0',
      compatibility: 'OrigRead Desktop',
      allowedTools: 'Read Bash(git:*)',
      metadata: { version: '1.2', 'origread-display-name': 'Evidence Review' }
    })
  })

  it('rejects names outside the open Agent Skills naming contract', () => {
    for (const name of ['Upper', '-bad', 'bad-', 'bad--name']) {
      expect(() => parseLlmSkillMarkdown(`---\nname: ${name}\ndescription: valid description\n---\nDo work.`))
        .toThrow(LlmSkillFormatError)
    }
  })

  it('hashes exact markdown plus resources in stable path order', () => {
    const markdown = '---\nname: demo\ndescription: Demo\n---\nUse B.md'
    const left = llmSkillContentHash(markdown, [
      { path: 'B.md', content: 'b' },
      { path: 'A.md', content: 'a' }
    ])
    const right = llmSkillContentHash(markdown, [
      { path: 'A.md', content: 'a' },
      { path: 'B.md', content: 'b' }
    ])
    expect(left).toBe(right)
    expect(left).toMatch(/^[a-f0-9]{64}$/)
  })
})


describe('YAML scalar and indentation boundaries', () => {
  it('decodes double quoted escapes exactly once and preserves single quoted backslashes', () => {
    const parse = (description: string) => parseLlmSkillMarkdown(`---\nname: demo\ndescription: ${description}\n---\nWork.`).description
    expect(parse(String.raw`"literal \\n and newline \n end"`)).toBe('literal \\n and newline \n end')
    expect(parse(String.raw`'literal \n and it''s fine'`)).toBe(String.raw`literal \n and it's fine`)
  })
  it('does not promote nested keys into top level or metadata triggers', () => {
    const parsed = parseLlmSkillMarkdown('---\nname: good\ndescription: Good skill\nextra:\n  name: evil\nmetadata:\n  nested:\n    origread-triggers: everything\n---\nWork.')
    expect(parsed.name).toBe('good')
    expect(parsed.metadata['origread-triggers']).toBeUndefined()
  })
})
