import { describe, expect, it } from 'vitest'
import { isSyncEntityType, SYNC_ENTITY_TYPES } from './sync-identity'

describe('sync identity contract', () => {
  it('keeps wire entity names unique and parseable', () => {
    expect(SYNC_ENTITY_TYPES).toEqual([
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
    ])
    expect(new Set(SYNC_ENTITY_TYPES).size).toBe(SYNC_ENTITY_TYPES.length)
    for (const value of SYNC_ENTITY_TYPES) expect(isSyncEntityType(value)).toBe(true)
    expect(isSyncEntityType('feeds')).toBe(false)
  })
})
