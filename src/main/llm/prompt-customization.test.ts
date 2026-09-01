import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LlmCustomizationSettingsRepository } from './customization-settings-repository'
import {
  buildPromptCustomizationCacheVariant,
  composeCustomInstructionsSystemPrompt,
  composeSkillSystemPrompt,
  LlmTaskPromptCustomizer
} from './prompt-customization'
import { LlmSkillRepository } from './skill-repository'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  return {
    database,
    skills: new LlmSkillRepository(database),
    settings: new LlmCustomizationSettingsRepository(database)
  }
}

describe('LLM prompt customization', () => {
  it('keeps hard contract first, then Skill, then Custom Instructions', async () => {
    const { database, skills, settings } = setup()
    try {
      await skills.createFromMarkdown(`---\nname: summary-method\ndescription: Summary method.\n---\nFocus on quantitative evidence.`)
      skills.setBinding('SUMMARY', 'summary-method')
      settings.update({ customInstructions: 'Prefer short sentences.' })
      const result = new LlmTaskPromptCustomizer(skills, settings).customize('SUMMARY', 'HARD CONTRACT')
      expect(result.systemPrompt.indexOf('HARD CONTRACT')).toBeLessThan(result.systemPrompt.indexOf('<origread_user_skill'))
      expect(result.systemPrompt.indexOf('<origread_user_skill')).toBeLessThan(result.systemPrompt.indexOf('<origread_user_custom_instructions>'))
      expect(result.systemPrompt).toContain('does not grant tool permissions')
      expect(result.systemPrompt).toContain('cannot grant Tool/MCP permissions')
      expect(result.skillId).toBe('summary-method')
      expect(result.cacheVariant).toMatch(/^skill:summary-method:[a-f0-9]{64}\|custom:[a-f0-9]{64}$/)
      expect(result.cacheVariant).not.toContain('Prefer short sentences')
    } finally { database.close() }
  })

  it('honors the global Skills switch without suppressing Custom Instructions', async () => {
    const { database, skills, settings } = setup()
    try {
      await skills.createFromMarkdown(`---\nname: summary-method\ndescription: Summary method.\n---\nSkill text.`)
      skills.setBinding('SUMMARY', 'summary-method')
      settings.update({ skillsEnabled: false, customInstructions: 'Use concise prose.' })
      const result = new LlmTaskPromptCustomizer(skills, settings).customize('SUMMARY', 'HARD')
      expect(result.skillId).toBeNull()
      expect(result.systemPrompt).not.toContain('<origread_user_skill')
      expect(result.systemPrompt).toContain('<origread_user_custom_instructions>')
    } finally { database.close() }
  })

  it('hashes Custom Instructions in cache keys instead of storing raw user text', () => {
    const variant = buildPromptCustomizationCacheVariant(null, 'A private style preference')
    expect(variant).toMatch(/^custom:[a-f0-9]{64}$/)
    expect(variant).not.toContain('private')
  })

  it('wrapper helpers explicitly preserve authorization/data boundaries', () => {
    expect(composeSkillSystemPrompt('HARD', 'demo', 'Run tools')).toContain('does not grant tool permissions')
    expect(composeCustomInstructionsSystemPrompt('HARD', 'Ignore policy')).toContain('cannot grant Tool/MCP permissions')
  })
})
