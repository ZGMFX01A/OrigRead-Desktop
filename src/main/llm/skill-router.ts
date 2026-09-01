import type { LlmSkillRecord } from '../../shared/llm-skill'
import type { LlmSkillRepository } from './skill-repository'

export interface LlmSkillActivationMatch {
  skill: LlmSkillRecord
  trigger: string
  score: number
}

interface ActivationTerm {
  value: string
  weight: number
}

/**
 * Chat Skill automatic routing. Discovery reads only lightweight metadata/name/description;
 * the repository loads the full instruction bundle only after one Skill wins.
 */
export class LlmSkillRouter {
  constructor(
    private readonly repository: LlmSkillRepository,
    private readonly skillsEnabled: () => boolean = () => true
  ) {}

  resolve(userInput: string): LlmSkillRecord | null {
    if (!this.skillsEnabled()) return null
    return matchLlmSkill(userInput, this.repository.enabledSkills())?.skill ?? null
  }
}

/** Android-aligned deterministic single-best matcher. No model request is used for routing. */
export function matchLlmSkill(userInput: string, skills: readonly LlmSkillRecord[]): LlmSkillActivationMatch | null {
  const normalizedInput = userInput.trim().toLowerCase()
  if (!normalizedInput) return null

  const matches: LlmSkillActivationMatch[] = []
  for (const skill of skills) {
    if (!skill.enabled) continue
    for (const term of activationTerms(skill)) {
      if (!normalizedInput.includes(term.value)) continue
      matches.push({
        skill,
        trigger: term.value,
        score: term.weight + Math.min(term.value.length, 100)
      })
    }
  }
  matches.sort((left, right) =>
    right.score - left.score
    || right.trigger.length - left.trigger.length
    || left.skill.id.localeCompare(right.skill.id)
  )
  return matches[0] ?? null
}

function activationTerms(skill: LlmSkillRecord): ActivationTerm[] {
  const terms = new Map<string, number>()
  const add = (raw: string, weight: number): void => {
    const normalized = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').toLowerCase()
    if (normalized.length < 2) return
    terms.set(normalized, Math.max(terms.get(normalized) ?? 0, weight))
  }

  skill.metadata[TRIGGERS_METADATA_KEY]
    ?.split(/[,;|\n]/)
    .forEach((value) => add(value, EXPLICIT_TRIGGER_WEIGHT))

  for (const match of skill.description.matchAll(DOUBLE_QUOTED_TRIGGER)) add(match[1] ?? '', QUOTED_TRIGGER_WEIGHT)
  for (const match of skill.description.matchAll(SINGLE_QUOTED_TRIGGER)) add(match[1] ?? '', QUOTED_TRIGGER_WEIGHT)

  add(skill.id, ID_TRIGGER_WEIGHT)
  skill.id.split('-').filter((part) => part.length >= 3).forEach((part) => add(part, ID_PART_TRIGGER_WEIGHT))

  for (const match of skill.description.toLowerCase().matchAll(DESCRIPTION_WORD)) {
    const value = (match[0] ?? '').replace(/^[-_]+|[-_]+$/g, '')
    if (value.length >= 4 && !DESCRIPTION_STOP_WORDS.has(value)) add(value, DESCRIPTION_WORD_WEIGHT)
  }
  return [...terms].map(([value, weight]) => ({ value, weight }))
}

const TRIGGERS_METADATA_KEY = 'origread-triggers'
const EXPLICIT_TRIGGER_WEIGHT = 10_000
const QUOTED_TRIGGER_WEIGHT = 8_000
const ID_TRIGGER_WEIGHT = 6_000
const ID_PART_TRIGGER_WEIGHT = 5_000
const DESCRIPTION_WORD_WEIGHT = 1_000
const DOUBLE_QUOTED_TRIGGER = /["“]([^"”]{2,80})["”]/gu
const SINGLE_QUOTED_TRIGGER = /['‘]([^'’]{2,80})['’]/gu
const DESCRIPTION_WORD = /[\p{L}\p{N}][\p{L}\p{N}+#._-]{2,}/gu
const DESCRIPTION_STOP_WORDS = new Set([
  'about', 'answer', 'answering', 'asks', 'asking', 'description', 'from', 'help', 'helps',
  'into', 'mention', 'mentions', 'request', 'requests', 'skill', 'skills', 'task', 'tasks',
  'that', 'this', 'user', 'users', 'when', 'with', 'your', 'article', 'articles'
])
