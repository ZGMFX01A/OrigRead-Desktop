/**
 * R10 protocol entity names. These strings are wire-level identifiers and must stay stable even if
 * local SQLite tables or TypeScript records are renamed later.
 */
export const SYNC_ENTITY_TYPES = [
  'group',
  'feed',
  'article',
  'filter_rule',
  'website_rule',
  'json_rule',
  'rsshub_settings',
  'website_parse_preference',
  'rsshub_subscription_source',
  'conversation',
  'conversation_article',
  'message',
  'tool_call',
  'context_ref',
  'evidence_block',
  'citation_ref',
  'citation_annotation',
  'citation_annotation_ref',
  'alias_edge'
] as const

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number]

export interface SyncSpaceRecord {
  syncSpaceId: string
  createdAt: number
  updatedAt: number
}

export interface SyncIdentityMappingRecord {
  syncSpaceId: string
  entityType: SyncEntityType
  localId: string
  syncId: string
  canonicalKey: string | null
  generation: number
  createdAt: number
  updatedAt: number
}

export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(value)
}
