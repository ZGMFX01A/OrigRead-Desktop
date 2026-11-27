import { describe, expect, it } from 'vitest'
import type { LlmSkillRecord } from '../../shared/llm-skill'
import { matchLlmSkill } from './skill-router'

function skill(id: string, description: string, metadata: Record<string, string> = {}): LlmSkillRecord {
  return {
    id,
    description,
    enabled: true,
    instructions: 'Do the task.',
    resources: [],
    license: null,
    compatibility: null,
    allowedTools: null,
    metadata,
    hasScripts: false,
    contentHash: 'a'.repeat(64),
    installedAt: 1,
    updatedAt: 1
  }
}

describe('matchLlmSkill', () => {
  it('prefers explicit OrigRead triggers and handles Chinese text without another model call', () => {
    const programming = skill(
      'programming-assistant',
      'Use for programming, Kotlin, Java, Gradle, and code debugging requests.',
      { 'origread-triggers': 'kotlin,java,gradle,编程,代码' }
    )
    const cooking = skill('cooking-helper', 'Use for recipes and cooking questions.')
    const match = matchLlmSkill('这个 Kotlin 协程为什么会死锁？', [cooking, programming])
    expect(match).toMatchObject({ skill: { id: 'programming-assistant' }, trigger: 'kotlin' })
  })

  it('does not activate unrelated skills', () => {
    const programming = skill(
      'programming-assistant',
      'Use for programming and code debugging requests.',
      { 'origread-triggers': 'kotlin,java,gradle,编程,代码' }
    )
    expect(matchLlmSkill('这篇文章的作者主要观点是什么？', [programming])).toBeNull()
  })

  it('uses explicit trigger > quoted phrase > id > description words and deterministic tie breaking', () => {
    const explicit = skill('z-skill', 'Use for "special review".', { 'origread-triggers': 'review' })
    const quoted = skill('a-skill', 'Use for "special review" requests.')
    expect(matchLlmSkill('Please review this with a special review.', [quoted, explicit])?.skill.id).toBe('z-skill')

    const a = skill('alpha-helper', 'Use for diagnostics.')
    const b = skill('beta-helper', 'Use for diagnostics.')
    expect(matchLlmSkill('Need diagnostics.', [b, a])?.skill.id).toBe('alpha-helper')
  })

  it('ignores disabled skills', () => {
    const disabled = { ...skill('kotlin-helper', 'Use for Kotlin.'), enabled: false }
    expect(matchLlmSkill('Kotlin help', [disabled])).toBeNull()
  })
})


describe('routing boundaries', () => {
  it('does not match English substrings', () => {
    expect(matchLlmSkill('javascript compilation', [skill('java-helper', 'Java tasks', { 'origread-triggers': 'java' })])).toBeNull()
  })
  it('filters generic Chinese custom triggers', () => {
    expect(matchLlmSkill('请帮我分析这个问题', [skill('evil', 'Unrelated', { 'origread-triggers': '帮我,分析,这个,问题' })])).toBeNull()
  })
  it('keeps a specific skill id above a generic custom trigger', () => {
    expect(matchLlmSkill('java-helper please review', [skill('evil', 'Other', { 'origread-triggers': 'review' }), skill('java-helper', 'Java tasks')])?.skill.id).toBe('java-helper')
  })
})
