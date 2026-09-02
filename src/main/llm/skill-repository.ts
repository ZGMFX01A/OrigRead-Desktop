import type { DatabaseSync } from 'node:sqlite'
import * as unzipper from 'unzipper'
import {
  buildLlmSkillInstructionBundle,
  emptyLlmSkillState,
  llmSkillBindingId,
  withLlmSkillBinding,
  type LlmSkillImportResult,
  type LlmSkillRecord,
  type LlmSkillResource,
  type LlmSkillState,
  type LlmSkillTask
} from '../../shared/llm-skill'
import { llmSkillContentHash, LlmSkillFormatError, parseLlmSkillMarkdown, type ParsedLlmSkill } from './skill-parser'

const SKILL_STATE_KEY = 'llm.skills'
const SKILL_STATE_BACKUP_KEY = 'llm.skills.backup'
const STATE_VERSION = 1

export const MAX_LLM_SKILLS = 100
export const MAX_LLM_SKILL_IMPORT_BYTES = 6_000_000
export const MAX_LLM_SKILL_ARCHIVE_BYTES = 12_000_000
export const MAX_LLM_SKILL_ARCHIVE_ENTRIES = 256
export const MAX_LLM_SKILL_RESOURCE_CHARACTERS = 300_000
export const MAX_LLM_SKILL_TOTAL_RESOURCE_CHARACTERS = 1_200_000
const MAX_BACKUP_INSTRUCTION_CHARACTERS = 500_000
const SAFE_TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml'] as const
const VALID_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface ImportedLlmSkill {
  parsed: ParsedLlmSkill
  markdown: string
  resources: LlmSkillResource[]
  hasScripts: boolean
}

interface StoredLlmSkillState {
  version: number
  skills: LlmSkillRecord[]
  bindings: LlmSkillState['bindings']
}

/**
 * Main-process Agent Skill repository.
 *
 * ZIP archives are never extracted to disk. Entry paths and sizes are validated by OrigRead before any
 * eligible text resource is buffered, so third-party archive path handling is not part of the trust boundary.
 */
export class LlmSkillRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(): LlmSkillState {
    const primary = this.readSetting(SKILL_STATE_KEY)
    if (primary) {
      const decoded = tryDecodeState(primary)
      if (decoded) return cloneState(decoded)
    }
    const backup = this.readSetting(SKILL_STATE_BACKUP_KEY)
    const recovered = backup ? tryDecodeState(backup) : null
    return recovered ? cloneState(recovered) : emptyLlmSkillState()
  }

  enabledSkills(): LlmSkillRecord[] {
    return this.current().skills.filter((skill) => skill.enabled)
  }

  skill(id: string | null | undefined): LlmSkillRecord | null {
    const normalized = id?.trim()
    if (!normalized) return null
    return this.current().skills.find((skill) => skill.id === normalized) ?? null
  }

  activeSkill(id: string | null | undefined): LlmSkillRecord | null {
    const skill = this.skill(id)
    return skill?.enabled ? skill : null
  }

  boundSkill(task: LlmSkillTask): LlmSkillRecord | null {
    const state = this.current()
    const id = llmSkillBindingId(state.bindings, task)
    return state.skills.find((skill) => skill.id === id && skill.enabled) ?? null
  }

  /** Structural implementation of LlmSkillInstructionResolver used by LlmRuntime. */
  resolve(skillId: string): { id: string; instructions: string } | null {
    const skill = this.activeSkill(skillId)
    if (!skill) return null
    const instructions = buildLlmSkillInstructionBundle(skill)
    return instructions ? { id: skill.id, instructions } : null
  }

  instructionFor(skillId: string | null | undefined): string | null {
    const skill = this.activeSkill(skillId)
    return skill ? buildLlmSkillInstructionBundle(skill) || null : null
  }

  async importBytes(bytes: Uint8Array, displayName = 'SKILL.md'): Promise<LlmSkillImportResult> {
    if (bytes.byteLength === 0) throw new LlmSkillFormatError('Skill 文件为空')
    if (bytes.byteLength > MAX_LLM_SKILL_IMPORT_BYTES) {
      throw new LlmSkillFormatError(`Skill 文件超过 ${MAX_LLM_SKILL_IMPORT_BYTES / 1_000_000} MB`)
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const imported = isZip(buffer) || displayName.toLowerCase().endsWith('.zip')
      ? await parseSkillZip(buffer)
      : parseStandaloneSkill(buffer)
    return this.install(imported)
  }

  async createFromMarkdown(markdown: string): Promise<LlmSkillImportResult> {
    const bytes = Buffer.from(markdown, 'utf8')
    if (bytes.byteLength > MAX_LLM_SKILL_IMPORT_BYTES) {
      throw new LlmSkillFormatError(`Skill 文件超过 ${MAX_LLM_SKILL_IMPORT_BYTES / 1_000_000} MB`)
    }
    return this.install(parseStandaloneSkill(bytes))
  }

  setEnabled(skillId: string, enabled: boolean): LlmSkillState {
    const current = this.current()
    if (!current.skills.some((skill) => skill.id === skillId)) return current
    return this.save({
      ...current,
      skills: current.skills.map((skill) => skill.id === skillId ? { ...skill, enabled } : skill)
    })
  }

  delete(skillId: string): LlmSkillState {
    const current = this.current()
    if (!current.skills.some((skill) => skill.id === skillId)) return current
    let bindings = current.bindings
    for (const task of ['SUMMARY', 'TRANSLATION', 'CHAT', 'ARTICLE_ANALYSIS'] as const) {
      if (llmSkillBindingId(bindings, task) === skillId) bindings = withLlmSkillBinding(bindings, task, null)
    }
    return this.save({
      skills: current.skills.filter((skill) => skill.id !== skillId),
      bindings
    })
  }

  setBinding(task: LlmSkillTask, skillId: string | null): LlmSkillState {
    const current = this.current()
    const normalized = skillId?.trim() || null
    if (normalized && !current.skills.some((skill) => skill.id === normalized && skill.enabled)) {
      throw new Error('Skill 不存在或未启用')
    }
    return this.save({ ...current, bindings: withLlmSkillBinding(current.bindings, task, normalized) })
  }

  exportBackupState(): string {
    return encodeState(this.current())
  }

  validateBackupState(raw: string): void {
    decodeState(raw)
  }

  restoreBackupState(raw: string): LlmSkillState {
    return this.save(decodeState(raw))
  }

  private install(imported: ImportedLlmSkill): LlmSkillImportResult {
    const current = this.current()
    const previous = current.skills.find((skill) => skill.id === imported.parsed.name)
    if (!previous && current.skills.length >= MAX_LLM_SKILLS) throw new LlmSkillFormatError(`Skill 数量超过上限 ${MAX_LLM_SKILLS}`)
    const now = Date.now()
    const skill: LlmSkillRecord = {
      id: imported.parsed.name,
      description: imported.parsed.description,
      enabled: previous?.enabled ?? true,
      instructions: imported.parsed.instructions,
      resources: imported.resources.map((resource) => ({ ...resource })),
      license: imported.parsed.license,
      compatibility: imported.parsed.compatibility,
      allowedTools: imported.parsed.allowedTools,
      metadata: { ...imported.parsed.metadata },
      hasScripts: imported.hasScripts,
      contentHash: llmSkillContentHash(imported.markdown, imported.resources),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now
    }
    const next = this.save({
      ...current,
      skills: [...current.skills.filter((item) => item.id !== skill.id), skill].sort((a, b) => a.id.localeCompare(b.id))
    })
    return { skill: next.skills.find((item) => item.id === skill.id)!, replaced: Boolean(previous) }
  }

  private save(state: LlmSkillState): LlmSkillState {
    validateState(state)
    const encoded = encodeState(state)
    const previous = this.readSetting(SKILL_STATE_KEY)
    // SAVEPOINT works both as a standalone transaction and nested inside the
    // D8.4 configuration-restore transaction. BEGIN IMMEDIATE cannot nest.
    this.database.exec('SAVEPOINT llm_skill_state_save')
    try {
      if (previous && tryDecodeState(previous)) this.writeSetting(SKILL_STATE_BACKUP_KEY, previous)
      this.writeSetting(SKILL_STATE_KEY, encoded)
      this.database.exec('RELEASE SAVEPOINT llm_skill_state_save')
    } catch (error) {
      this.database.exec('ROLLBACK TO SAVEPOINT llm_skill_state_save')
      this.database.exec('RELEASE SAVEPOINT llm_skill_state_save')
      throw error
    }
    return cloneState(state)
  }

  private readSetting(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private writeSetting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(key, value, Date.now())
  }
}

function parseStandaloneSkill(bytes: Buffer): ImportedLlmSkill {
  const markdown = decodeUtf8(bytes, 'SKILL.md')
  return { parsed: parseLlmSkillMarkdown(markdown), markdown, resources: [], hasScripts: false }
}

async function parseSkillZip(bytes: Buffer): Promise<ImportedLlmSkill> {
  let directory: unzipper.CentralDirectory
  try {
    directory = await unzipper.Open.buffer(bytes)
  } catch {
    throw new LlmSkillFormatError('无法读取 Skill ZIP 文件')
  }
  const files = directory.files.filter((entry) => entry.type === 'File')
  if (files.length > MAX_LLM_SKILL_ARCHIVE_ENTRIES) throw new LlmSkillFormatError('Skill 包文件数量过多')
  const normalized = new Map<string, unzipper.File>()
  let declaredBytes = 0
  for (const entry of files) {
    const path = normalizeArchivePath(entry.path)
    if (normalized.has(path)) throw new LlmSkillFormatError(`Skill 包存在重复路径：${path}`)
    declaredBytes += Math.max(0, Number(entry.uncompressedSize) || 0)
    if (declaredBytes > MAX_LLM_SKILL_ARCHIVE_BYTES) {
      throw new LlmSkillFormatError(`Skill 包解压后超过 ${MAX_LLM_SKILL_ARCHIVE_BYTES / 1_000_000} MB`)
    }
    normalized.set(path, entry)
  }

  const skillPaths = [...normalized.keys()].filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (skillPaths.length !== 1) throw new LlmSkillFormatError('Skill 包必须且只能包含一个 SKILL.md')
  const skillPath = skillPaths[0]!
  const root = skillPath.slice(0, -'SKILL.md'.length).replace(/\/$/, '')
  const markdown = decodeUtf8(await boundedEntryBuffer(normalized.get(skillPath)!, MAX_LLM_SKILL_ARCHIVE_BYTES), skillPath)
  const parsed = parseLlmSkillMarkdown(markdown)
  if (root && root.split('/').at(-1) !== parsed.name) throw new LlmSkillFormatError('SKILL.md name 必须与所在目录名一致')

  const resources: LlmSkillResource[] = []
  let resourceCharacters = 0
  let actualBytes = Buffer.byteLength(markdown)
  let hasScripts = false
  for (const [path, entry] of normalized) {
    if (path === skillPath) continue
    const relative = root ? path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null : path
    if (relative === null) continue
    if (relative.startsWith('scripts/')) { hasScripts = true; continue }
    if (!isSafeTextResource(relative)) continue
    const buffer = await boundedEntryBuffer(entry, MAX_LLM_SKILL_ARCHIVE_BYTES - actualBytes)
    actualBytes += buffer.byteLength
    if (actualBytes > MAX_LLM_SKILL_ARCHIVE_BYTES) throw new LlmSkillFormatError('Skill 包实际解压内容过大')
    const content = decodeUtf8(buffer, relative)
    resourceCharacters += content.length
    if (content.length > MAX_LLM_SKILL_RESOURCE_CHARACTERS || resourceCharacters > MAX_LLM_SKILL_TOTAL_RESOURCE_CHARACTERS) {
      throw new LlmSkillFormatError('Skill 文本资源过大')
    }
    resources.push({ path: relative, content })
  }
  resources.sort((a, b) => a.path.localeCompare(b.path))
  return { parsed, markdown, resources, hasScripts }
}

async function boundedEntryBuffer(entry: unzipper.File, remaining: number): Promise<Buffer> {
  if (remaining <= 0 || entry.uncompressedSize > remaining) throw new LlmSkillFormatError('Skill 包解压内容超过安全上限')
  const buffer = await entry.buffer()
  if (buffer.byteLength > remaining) throw new LlmSkillFormatError('Skill 包解压内容超过安全上限')
  return buffer
}

function normalizeArchivePath(raw: string): string {
  if (!raw || /[\u0000-\u001f]/.test(raw)) throw new LlmSkillFormatError('Skill 包包含不安全路径')
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) throw new LlmSkillFormatError('Skill 包包含绝对路径')
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new LlmSkillFormatError('Skill 包包含不安全路径')
  }
  return segments.join('/')
}

function isSafeTextResource(path: string): boolean {
  const lower = path.toLowerCase()
  return SAFE_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function isZip(bytes: Buffer): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new LlmSkillFormatError(`${label} 不是有效 UTF-8 文本`)
  }
}

function encodeState(state: LlmSkillState): string {
  validateState(state)
  return JSON.stringify({ version: STATE_VERSION, skills: state.skills, bindings: state.bindings } satisfies StoredLlmSkillState)
}

function decodeState(raw: string): LlmSkillState {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Skill 状态不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object') throw new Error('Skill 状态无效')
  const record = parsed as Partial<StoredLlmSkillState>
  if (record.version !== STATE_VERSION || !Array.isArray(record.skills) || !record.bindings) throw new Error('Skill 状态版本或结构无效')
  const state = { skills: record.skills, bindings: record.bindings } as LlmSkillState
  validateState(state)
  return state
}

function tryDecodeState(raw: string): LlmSkillState | null {
  try { return decodeState(raw) } catch { return null }
}

function validateState(state: LlmSkillState): void {
  if (!Array.isArray(state.skills) || state.skills.length > MAX_LLM_SKILLS) throw new Error(`Skill 数量超过上限 ${MAX_LLM_SKILLS}`)
  const ids = new Set<string>()
  for (const skill of state.skills) {
    if (!skill || typeof skill !== 'object' || !VALID_SKILL_ID.test(skill.id) || skill.id.length > 64) throw new Error('Skill ID 无效')
    if (ids.has(skill.id)) throw new Error('Skill 状态包含重复 ID')
    ids.add(skill.id)
    if (typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 1024) throw new Error(`Skill description 无效：${skill.id}`)
    if (typeof skill.instructions !== 'string' || !skill.instructions.trim() || skill.instructions.length > MAX_BACKUP_INSTRUCTION_CHARACTERS) throw new Error(`Skill 指令大小无效：${skill.id}`)
    if (typeof skill.enabled !== 'boolean' || typeof skill.hasScripts !== 'boolean') throw new Error(`Skill 状态无效：${skill.id}`)
    if (!Array.isArray(skill.resources) || skill.resources.length > MAX_LLM_SKILL_ARCHIVE_ENTRIES) throw new Error(`Skill 文本资源数量过多：${skill.id}`)
    if (skill.resources.some((resource) => !resource?.path || typeof resource.content !== 'string' || resource.content.length > MAX_LLM_SKILL_RESOURCE_CHARACTERS)) throw new Error(`Skill 文本资源无效：${skill.id}`)
    if (skill.resources.reduce((sum, resource) => sum + resource.content.length, 0) > MAX_LLM_SKILL_TOTAL_RESOURCE_CHARACTERS) throw new Error(`Skill 文本资源过大：${skill.id}`)
    if (typeof skill.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(skill.contentHash)) throw new Error(`Skill contentHash 无效：${skill.id}`)
    if (!Number.isFinite(skill.installedAt) || !Number.isFinite(skill.updatedAt)) throw new Error(`Skill 时间戳无效：${skill.id}`)
    if (!skill.metadata || typeof skill.metadata !== 'object' || Array.isArray(skill.metadata) || Object.values(skill.metadata).some((value) => typeof value !== 'string')) throw new Error(`Skill metadata 无效：${skill.id}`)
    for (const optional of [skill.license, skill.compatibility, skill.allowedTools]) if (optional !== null && typeof optional !== 'string') throw new Error(`Skill metadata 字段无效：${skill.id}`)
  }
  const bindings = state.bindings
  if (!bindings || typeof bindings !== 'object') throw new Error('Skill bindings 无效')
  for (const id of [bindings.summarySkillId, bindings.translationSkillId, bindings.chatSkillId, bindings.articleAnalysisSkillId]) {
    if (id !== null && (typeof id !== 'string' || !ids.has(id))) throw new Error(`Skill binding 指向不存在的 Skill：${String(id)}`)
  }
}

function cloneState(state: LlmSkillState): LlmSkillState {
  return {
    skills: state.skills.map((skill) => ({
      ...skill,
      resources: skill.resources.map((resource) => ({ ...resource })),
      metadata: { ...skill.metadata }
    })),
    bindings: { ...state.bindings }
  }
}
