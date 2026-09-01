import { createHash } from 'node:crypto'
import type { LlmSkillResource } from '../../shared/llm-skill'

const VALID_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_INSTRUCTION_CHARACTERS = 500_000

export class LlmSkillFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmSkillFormatError'
  }
}

export interface ParsedLlmSkill {
  name: string
  description: string
  instructions: string
  license: string | null
  compatibility: string | null
  allowedTools: string | null
  metadata: Record<string, string>
}

/** Parses the safe YAML subset used by Agent Skills and the Android LLM edition. */
export function parseLlmSkillMarkdown(markdown: string): ParsedLlmSkill {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') throw new LlmSkillFormatError('SKILL.md 必须以 YAML frontmatter 开始')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) throw new LlmSkillFormatError('SKILL.md frontmatter 缺少结束分隔符')

  const top = new Map<string, string>()
  const metadata: Record<string, string> = {}
  let index = 1
  let inMetadata = false
  while (index < end) {
    const raw = lines[index]!
    if (!raw.trim() || raw.trimStart().startsWith('#')) { index += 1; continue }
    const indent = raw.match(/^\s*/)?.[0].length ?? 0
    const trimmed = raw.trim()
    const separator = trimmed.indexOf(':')
    if (separator <= 0) throw new LlmSkillFormatError(`无法解析 frontmatter：${trimmed.slice(0, 80)}`)
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()

    if (indent === 0 && key === 'metadata' && !value) {
      inMetadata = true
      index += 1
      continue
    }
    if (indent === 0) inMetadata = false

    if (value === '|' || value === '>') {
      const folded = value === '>'
      const chunks: string[] = []
      index += 1
      while (index < end) {
        const continuation = lines[index]!
        const continuationIndent = continuation.match(/^\s*/)?.[0].length ?? 0
        if (continuation.trim() && continuationIndent <= indent) break
        chunks.push(continuation.slice(Math.min(indent + 2, continuation.length)))
        index += 1
      }
      value = (folded ? chunks.join(' ') : chunks.join('\n')).trim()
    } else {
      value = unquoteYamlScalar(value)
      index += 1
    }
    if (inMetadata && indent > 0) metadata[key] = value
    else top.set(key, value)
  }

  const name = (top.get('name') ?? '').trim()
  const description = (top.get('description') ?? '').trim()
  if (!name || name.length > 64 || !VALID_SKILL_NAME.test(name)) {
    throw new LlmSkillFormatError('Skill name 必须为 1-64 位小写字母/数字/连字符，且不能首尾或连续使用连字符')
  }
  if (!description || description.length > 1024) {
    throw new LlmSkillFormatError('Skill description 必须为 1-1024 个字符')
  }
  const compatibility = nullable(top.get('compatibility'))
  if (compatibility && compatibility.length > 500) throw new LlmSkillFormatError('Skill compatibility 不能超过 500 个字符')
  const instructions = lines.slice(end + 1).join('\n').trim()
  if (!instructions) throw new LlmSkillFormatError('SKILL.md 必须包含正文指令')
  if (instructions.length > MAX_SKILL_INSTRUCTION_CHARACTERS) {
    throw new LlmSkillFormatError(`SKILL.md 正文过大，最多 ${MAX_SKILL_INSTRUCTION_CHARACTERS / 1000}K 字符`)
  }

  return {
    name,
    description,
    instructions,
    license: nullable(top.get('license')),
    compatibility,
    allowedTools: nullable(top.get('allowed-tools')),
    metadata
  }
}

export function llmSkillContentHash(markdown: string, resources: readonly LlmSkillResource[]): string {
  const hash = createHash('sha256')
  hash.update(markdown)
  for (const resource of [...resources].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(Buffer.from([0]))
    hash.update(resource.path)
    hash.update(Buffer.from([0]))
    hash.update(resource.content)
  }
  return hash.digest('hex')
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed || null
}

function unquoteYamlScalar(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return raw.split(' #', 1)[0]!.trim()
}
