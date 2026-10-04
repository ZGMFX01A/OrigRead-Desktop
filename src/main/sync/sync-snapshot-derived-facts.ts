import type { SQLInputValue } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { pagedEntityDependencies } from './sync-paged-entity-dependencies'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import type { SnapshotCausalFacts } from './sync-snapshot-causal-facts'

export interface SnapshotFieldMetadata {
  bundle: string; lane: string; key: string; fieldId: string; versionToken: string; logicalClock: number
  causalContextJson: string | null; valueDigest: string; preferenceValueJson: string
  entityType: string; entitySyncId: string; generation: number
  readonly causalFacts?: SnapshotCausalFacts
}
export interface SnapshotEntityMetadata {
  bundle: string; lane: string; key: string; entityType: string; entitySyncId: string; generation: number
  context: Readonly<Record<string, unknown>>
  parents: readonly { entityType: string; entitySyncId: string; generation?: number }[]
}
export interface PreparedSnapshotFacts { field?: readonly SQLInputValue[]; entity?: readonly SQLInputValue[]; edges: readonly (readonly SQLInputValue[])[] }

/** 复合外键只需要这些共享身份，正文和其他字段不进入关系索引。 */
const CONTEXT_FIELDS = ['conversationSyncId', 'assistantMessageSyncId', 'contextRefSyncId'] as const
/** 旧 Genesis 未提供逻辑时钟时沿用协议的零时钟。 */
const GENESIS_CLOCK = 0

/** 解码记录时一次提取派生事实；摘要和关系转换都在批次事务之外完成。 */
export function prepareSnapshotFacts(input: { bundle: string; lane: string; record: SyncSnapshotRecord }): PreparedSnapshotFacts {
  const { bundle, lane, record } = input, identity = [bundle, lane, record.key]
  if (record.kind === 'FIELD_VERSION') {
    const value = record.value, raw = String(value.valueJson)
    return { field: [...identity, String(value.versionToken), Number(value.logicalClock ?? GENESIS_CLOCK),
      value.causalContextJson == null ? null : String(value.causalContextJson), sha256Hex(raw),
      raw === 'true' || raw === 'false' ? raw : ''], edges: [] }
  }
  if (record.kind !== 'ENTITY') return { edges: [] }
  const fields = record.value.fields as Readonly<Record<string, unknown>>
  const context = Object.fromEntries(CONTEXT_FIELDS.filter(field => fields[field] != null).map(field => [field, fields[field]]))
  const parents = pagedEntityDependencies(String(record.value.entityType), fields)
  return { entity: [...identity, canonicalJson(JSON.stringify(context))],
    edges: parents.map((parent, ordinal) => [...identity, ordinal, parent.entityType, parent.entitySyncId, parent.generation ?? null]) }
}
