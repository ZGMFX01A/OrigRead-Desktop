export const LLM_SKILL_TASKS = ['SUMMARY', 'TRANSLATION', 'CHAT', 'ARTICLE_ANALYSIS'] as const
export type LlmSkillTask = typeof LLM_SKILL_TASKS[number]

export interface LlmSkillResource {
  path: string
  content: string
}

export interface LlmSkillRecord {
  id: string
  description: string
  enabled: boolean
  instructions: string
  resources: LlmSkillResource[]
  license: string | null
  compatibility: string | null
  /** Agent Skills experimental declaration only. OrigRead never treats this as authorization. */
  allowedTools: string | null
  metadata: Record<string, string>
  hasScripts: boolean
  contentHash: string
  installedAt: number
  updatedAt: number
}

export interface LlmSkillBindings {
  summarySkillId: string | null
  translationSkillId: string | null
  chatSkillId: string | null
  articleAnalysisSkillId: string | null
}

export interface LlmSkillState {
  skills: LlmSkillRecord[]
  bindings: LlmSkillBindings
}

export interface LlmSkillImportResult {
  skill: LlmSkillRecord
  replaced: boolean
}

/** Renderer-facing metadata only. Full instructions/resources stay in Main. */
export interface LlmSkillManagementItem {
  id: string
  description: string
  enabled: boolean
  license: string | null
  compatibility: string | null
  allowedTools: string | null
  metadata: Record<string, string>
  hasScripts: boolean
  contentHash: string
  resourceCount: number
  installedAt: number
  updatedAt: number
}

export interface LlmSkillManagementSnapshot {
  skills: LlmSkillManagementItem[]
  bindings: LlmSkillBindings
}

export interface LlmSkillImportFileResult {
  ok: boolean
  cancelled: boolean
  replaced: boolean
  skillId: string | null
  snapshot: LlmSkillManagementSnapshot
  error: string | null
}

export interface LlmSkillCreateRequest {
  id: string
  description: string
  instructions: string
  triggers?: string
}

export interface LlmSkillPreview {
  id: string
  description: string
  instructions: string
  license: string | null
  compatibility: string | null
  allowedTools: string | null
  metadata: Record<string, string>
  hasScripts: boolean
  resourcePaths: string[]
}

export const EMPTY_LLM_SKILL_BINDINGS: LlmSkillBindings = Object.freeze({
  summarySkillId: null,
  translationSkillId: null,
  chatSkillId: null,
  articleAnalysisSkillId: null
})

export function emptyLlmSkillState(): LlmSkillState {
  return { skills: [], bindings: { ...EMPTY_LLM_SKILL_BINDINGS } }
}

export function llmSkillBindingId(bindings: LlmSkillBindings, task: LlmSkillTask): string | null {
  switch (task) {
    case 'SUMMARY': return bindings.summarySkillId
    case 'TRANSLATION': return bindings.translationSkillId
    case 'CHAT': return bindings.chatSkillId
    case 'ARTICLE_ANALYSIS': return bindings.articleAnalysisSkillId
  }
}

export function withLlmSkillBinding(
  bindings: LlmSkillBindings,
  task: LlmSkillTask,
  skillId: string | null
): LlmSkillBindings {
  switch (task) {
    case 'SUMMARY': return { ...bindings, summarySkillId: skillId }
    case 'TRANSLATION': return { ...bindings, translationSkillId: skillId }
    case 'CHAT': return { ...bindings, chatSkillId: skillId }
    case 'ARTICLE_ANALYSIS': return { ...bindings, articleAnalysisSkillId: skillId }
  }
}

export function llmSkillDisplayName(skill: LlmSkillRecord): string {
  return skill.metadata['origread-display-name']?.trim() || skill.id
}

/**
 * Progressive disclosure for Desktop v1: always include SKILL.md body, then only safe text resources
 * directly named by path or basename in that body. Imported scripts are never included or executed.
 */
export function buildLlmSkillInstructionBundle(skill: LlmSkillRecord): string {
  const body = skill.instructions.trim()
  const referenced = skill.resources.filter((resource) => {
    const basename = resource.path.split('/').at(-1) ?? resource.path
    return body.includes(resource.path) || body.includes(basename)
  })
  return [
    body,
    ...referenced.map((resource) => `---\nReferenced resource: ${resource.path}\n\n${resource.content.trim()}`)
  ].filter(Boolean).join('\n\n').trim()
}
