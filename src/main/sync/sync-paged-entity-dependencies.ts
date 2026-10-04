/** 业务实体的强依赖来自实际产品外键；可选 article/locator 链接不触发级联删除。 */
const DEPENDENCIES: Readonly<Record<string, readonly [string, string, string?][]>> = {
  feed: [['group', 'groupSyncId', 'groupGeneration']], article: [['feed', 'feedSyncId', 'feedGeneration']],
  filter_rule: [['feed', 'feedSyncId', 'feedGeneration']], website_parse_preference: [['feed', 'feedSyncId', 'feedGeneration']],
  rsshub_subscription_source: [['feed', 'feedSyncId', 'feedGeneration']],
  message: [['conversation', 'conversationSyncId']], tool_call: [['conversation', 'conversationSyncId'], ['message', 'assistantMessageSyncId']],
  context_ref: [['conversation', 'conversationSyncId'], ['message', 'assistantMessageSyncId']],
  evidence_block: [['context_ref', 'contextRefSyncId']],
  citation_ref: [['conversation', 'conversationSyncId'], ['message', 'assistantMessageSyncId'], ['context_ref', 'contextRefSyncId']],
  citation_annotation: [['conversation', 'conversationSyncId'], ['message', 'assistantMessageSyncId']],
  conversation_article: [['conversation', 'conversationSyncId']],
  citation_annotation_ref: [['citation_annotation', 'annotationSyncId'], ['citation_ref', 'citationRefSyncId']]
}

/** 子实体在父优先顺序处理，删除见证能够继续传播到任意真实级联后代。 */
export const PAGED_ENTITY_DEPENDENCY_ORDER = ['group', 'feed', 'article', 'filter_rule', 'website_parse_preference', 'rsshub_subscription_source',
  'conversation', 'message', 'tool_call', 'context_ref', 'evidence_block', 'citation_ref', 'citation_annotation',
  'conversation_article', 'citation_annotation_ref'] as const

/** 同步身份与显式父代次共同定位依赖，缺失的强依赖直接暴露为快照损坏。 */
export function pagedEntityDependencies(entityType: string, fields: Readonly<Record<string, unknown>>): {
  entityType: string; entitySyncId: string; generation?: number
}[] {
  // 全局过滤规则没有 Feed 父实体；用户偏好和 RSSHub 来源使用协议中的嵌套载荷。
  if (entityType === 'filter_rule' && fields.feedSyncId == null) return []
  const parentFields = entityType === 'website_parse_preference' ? fields.preference
    : entityType === 'rsshub_subscription_source' ? fields.source : fields
  if (!parentFields || typeof parentFields !== 'object') throw new Error('SNAPSHOT_CORRUPTED: missing parent payload')
  const values = parentFields as Readonly<Record<string, unknown>>
  const rules = [...(DEPENDENCIES[entityType] ?? [])]
  if (entityType === 'citation_ref' && fields.evidenceBlockSyncId != null) rules.push(['evidence_block', 'evidenceBlockSyncId'])
  return rules.map(([type, field, generation]) => {
    if (typeof values[field] !== 'string' || !values[field]) throw new Error('SNAPSHOT_CORRUPTED: missing parent identity ' + entityType + '/' + field)
    const value = generation ? values[generation] : undefined
    if (value != null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('SNAPSHOT_CORRUPTED: invalid parent generation')
    return { entityType: type, entitySyncId: String(values[field]), generation: value == null ? undefined : Number(value) }
  })
}
