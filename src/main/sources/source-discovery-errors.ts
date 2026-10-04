import type { RssHubProbeResult } from '../../shared/rsshub'

// 可识别的实例失败必须显示具体原因，不能变成空来源成功。
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  'blocked': 'RSSHub 服务器或上游网站返回了人机验证或反爬拦截页面。请重试或换用其他实例。',
  'timeout': 'RSSHub 请求超时。请稍后重试或换用其他实例。',
  'network_unavailable': '无法连接这个 RSSHub 服务器。请检查网络和服务器地址。',
  'connection_closed': '连接在响应完成前被关闭。请重试，或检查代理和服务器。',
  'dns_failure': '无法解析 RSSHub 服务器域名。请检查服务器地址和 DNS 设置。',
  'tls_error': '无法与 RSSHub 建立安全连接。请检查服务器证书或代理设置。',
  'html_response': '服务器返回了网页，而非 RSS/Atom。请检查实例地址和路由。',
  'invalid_content': '服务器返回的内容无法解析为有效的 RSS/Atom。',
  'disabled': 'RSSHub 当前已关闭。请在设置中启用后重试。',
  'no_instances': '没有启用任何 RSSHub 实例。请在设置中添加或启用实例。',
  'probe_budget_exhausted': '本次 RSSHub 探测超时，部分实例尚未完成。请重试或调整实例顺序。',
  'unsupported_format': '此 RSSHub 返回了暂不支持的格式（如 JSON）。请使用 RSS 或 Atom 输出，例如将 format 改为 rss。',
  'authentication_requires_instance': '此 RSSHub 路由包含访问密钥或访问码。请填写所属实例的完整 HTTP/HTTPS 地址，避免将凭证发送给其他实例。',
  'bound_instance_disabled': '此带凭证订阅所属的 RSSHub 实例已被禁用或删除。请启用原实例后再进行自动恢复。'
}

/** 保留 HTTP、连接及路由失败的原有用户诊断。 */
export function rssHubFailureText(result: RssHubProbeResult): string {
  const reason = result.failureReason ?? (['timeout','network_unavailable','invalid_content'].find((state) => state === result.state) ?? null)
  if (reason === 'http_error') return httpFailureText(result.statusCode)
  if (reason && FAILURE_MESSAGES[reason]) return FAILURE_MESSAGES[reason]!
  if (result.state === 'needs_input') {
          return `RSSHub 匹配项“${result.match.route.name}”还需要更多信息（${result.match.missingParameters.join(', ')}），请填写更具体的页面地址。`
        }
  if (result.state === 'unsupported') {
          return 'RSSHub 当前已关闭。请在设置中启用后重试。'
        }
  return '本次未获得可用的 RSSHub 订阅。请查看具体原因后重试。'
}

function httpFailureText(statusCode: number | null | undefined): string {
  switch (statusCode) {
        case 401:
          return 'HTTP 401：请求需要身份认证。请检查实例访问权限或路由配置。'
        case 403:
          return 'HTTP 403：服务器拒绝了请求。请尝试其他实例或检查访问规则。'
        case 404:
          return 'HTTP 404：找不到请求的地址或路由。请检查路由和实例基础地址。'
        case 429:
          return 'HTTP 429：服务器限制了请求频率。请稍后重试或换用其他实例。'
        case null:
        case undefined:
          return 'RSSHub 请求在服务器或上游网站执行失败。请查看各服务器的具体原因，或尝试其他实例。'
        default:
          return `RSSHub 服务器返回 HTTP ${statusCode}。请检查服务器或上游路由，稍后重试。`
      }
}

export function rssHubFailureSummary(results: RssHubProbeResult[]): string | null {
  const failures = results.filter((item) => !item.available)
  if (failures.length === 0) return null
  const budget = failures.find((item) => item.failureReason === 'probe_budget_exhausted')
  if (budget) return rssHubFailureText(budget)
  const texts = [...new Set(failures.map(rssHubFailureText))]
  if (texts.length > 1) {
    return '不同 RSSHub 服务器返回了不同错误。请查看下方各服务器的具体原因后重试。'
  }
  return texts[0] ?? null
}

export function explicitRssHubFailureNotice(results: RssHubProbeResult[]): string {
  return rssHubFailureSummary(results) ?? '本次未获得可用的 RSSHub 订阅。请查看具体原因后重试。'
}
