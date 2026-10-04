/** 只有这些产品域包含来源配置；文章正文/Tool 数据不会因出现 token 一词被当凭据。 */
const CONFIG_TYPES = new Set(['feed', 'json_rule', 'website_rule', 'rsshub_settings', 'rsshub_subscription_source', 'website_parse_preference', 'filter_rule'])
/** 明确的认证参数名；保留业务 query 原样，遇到凭据则暂停导出整个配置。 */
const SECRET_KEYS = new Set(['apikey', 'apitoken', 'accesskey', 'accesstoken', 'refreshtoken', 'token', 'password', 'passwd', 'secret', 'clientsecret', 'authorization', 'cookie', 'key', 'code'])
/** URL 承载字段白名单，避免把规则选择器、正文、正则误当地址。 */
const URL_FIELDS = new Set(['url', 'endpoint', 'sourceUrl', 'originalInput', 'preferredInstance', 'automaticUrlPattern'])
/** JSON 来源只输出正式协议的规则字段，未知扩展不能夹带请求 header/本机凭据。 */
const JSON_RULE_FIELDS = new Set(['id','name','version','enabled','hosts','sourceKind','endpoint','itemsPath','titlePath','linkPath','datePath','authorPath','descriptionPath','contentPath','imagePath','idPath','dateFormat','maxItems'])

/** 在本机事务已提交后的构建/导出边界拒绝，保留本机凭据与冻结 Outbox，不改历史签名。 */
export function requireExportableConfig(type: string, payload: unknown): void {
  if (!CONFIG_TYPES.has(type)) return
  walk({ value: payload, type, field: '' })
}

/** 只有配置域需要展开字段检查凭据；其他域的正文 JSON 仍由正式记录边界验证。 */
export function requireExportableConfigField(input: { type: string; field: string; valueJson: string }): void {
  if (!CONFIG_TYPES.has(input.type)) return
  requireExportableConfig(input.type, { [input.field]: JSON.parse(input.valueJson) })
}

/** 逐层检查正式来源字段；错误只带字段名，绝不把完整 URL 写入诊断。 */
function walk(input: { value: unknown; type: string; field: string }): void {
  const { value, type, field } = input
  if (Array.isArray(value)) { for (const item of value) walk({ value: item, type, field }); return }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(normalizedKey(key)) && child != null && child !== '') blocked(key)
      if (type === 'json_rule' && field === 'rule' && !JSON_RULE_FIELDS.has(key)) blocked(key)
      walk({ value: child, type, field: key })
    }
    return
  }
  if (typeof value === 'string' && URL_FIELDS.has(field) && value.trim()) checkUrl(value, field)
}

/** 相对 endpoint 使用固定基址仅用于识别 query，返回值从不写回身份或配置。 */
function checkUrl(value: string, field: string): void {
  const url = new URL(value, 'https://sync-config.invalid')
  if (url.username || url.password) blocked(field)
  for (const [key, contents] of url.searchParams) if (contents && SECRET_KEYS.has(normalizedKey(key))) blocked(field)
}
function normalizedKey(value: string): string { return value.toLowerCase().replace(/[-_]/g, '') }
function blocked(field: string): never { throw new Error(`CREDENTIAL_REQUIRED: ${field} 含本机认证信息，配置导出已暂停；请先在本机拆分凭据绑定`) }
