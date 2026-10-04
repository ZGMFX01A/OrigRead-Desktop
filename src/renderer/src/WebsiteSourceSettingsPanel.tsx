import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedRecord } from '../../shared/library'
import type { WebsiteParseCandidate, WebsiteRule } from '../../shared/website'
import type { WebsiteSourceRuleSettings } from '../../shared/contracts'

interface Props { readonly feed: FeedRecord; readonly setError: (error: string | null) => void }
type WebsiteSettings = ReturnType<typeof useWebsiteSettings>

/** 网站解析偏好独立维护，规则目录和内置候选分组展示。 */
export function WebsiteSourceSettingsPanel(props: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useWebsiteSettings(props)
  const { settings, busy } = state
  if (!settings) return null
  return <section className="source-settings-card">
    <div className="source-section-heading"><div><h3>{t('websiteSourceParser')}</h3><p>{t('websiteSourceParserDesc')}</p></div></div>
    <label className="source-setting-row"><span><strong>{t('dynamicRendering')}</strong><small>{t('dynamicRenderingDesc')}</small></span><input type="checkbox" checked={settings.dynamicRenderingEnabled} disabled={busy} onChange={(event) => void state.setDynamicRendering(event.target.checked)} /></label>
    <div className="source-parser-actions">
      <button type="button" className="mini-action" disabled={busy} onClick={() => void state.evaluate()}>{busy ? <RefreshCw size={13} className="spinning" /> : null}{t('evaluateParserCandidates')}</button>
      <button type="button" className="mini-action" disabled={busy || settings.preferredRuleId === null} onClick={() => void state.setPreferredRule(null)}>{t('restoreAutomaticParser')}</button>
    </div>
    <div className="source-parser-groups">
      <div className="source-parser-group">
        <div className="source-parser-group-heading"><div><h4>{t('websiteParserAutomatic')}</h4><p>{t('websiteParserAutomaticDesc')}</p></div></div>
        <button type="button" disabled={busy} className={`source-parser-option ${settings.preferredRuleId === null ? 'selected' : ''}`} onClick={() => void state.setPreferredRule(null)}>
          <span><strong>{t('websiteParserAutomatic')}</strong><small>{t('websiteParserAutomaticDesc')}</small></span>
          <span className="source-parser-option-state">{settings.preferredRuleId === null ? t('currentChoice') : ''}</span>
        </button>
      </div>
      <WebsiteRuleList state={state} />
      <WebsiteBuiltInList state={state} />
    </div>
  </section>
}

/** 网络探测和偏好写入共用忙碌状态，失败交回来源设置的错误出口。 */
function useWebsiteAction(setError: Props['setError']) {
  const [busy, setBusy] = useState(false)
  const execute = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await operation() }
    catch (error) {
      // 真实 IPC 或规则写入错误保持可见，界面不提前发布保存结果。
      setError(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }
  return { busy, execute }
}

/** 读取当前来源设置；各写入成功后再发布主进程返回的真实状态。 */
function useWebsiteSettings({ feed, setError }: Props) {
  const [settings, setSettings] = useState<WebsiteSourceRuleSettings | null>(null)
  const [candidates, setCandidates] = useState<WebsiteParseCandidate[]>([])
  const [rules, setRules] = useState<WebsiteRule[]>([])
  const { busy, execute } = useWebsiteAction(setError)
  useEffect(() => {
    let active = true
    void Promise.all([window.origread.getWebsiteSourceRuleSettings(feed.id), window.origread.listWebsiteRulesForUrl(feed.url)])
      .then(([loaded, loadedRules]) => { if (active) { setSettings(loaded); setRules(loadedRules) } })
      .catch((error) => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [feed.id, feed.url])
  /** 真实候选探测只更新当前来源的偏好预览。 */
  const evaluate = () => execute(async () => { setCandidates(await window.origread.evaluateWebsiteSourceRules(feed.id)) })
  /** 指定规则偏好沿用原有健康检查和刷新策略。 */
  const setPreferredRule = (ruleId: string | null) => execute(async () => { setSettings(await window.origread.setWebsiteSourcePreferredRule(feed.id, ruleId)) })
  /** 停用当前偏好规则后恢复自动模式，写入失败明确报告。 */
  const setRuleEnabled = (ruleId: string, enabled: boolean) => execute(async () => {
    await window.origread.setWebsiteRuleEnabled(ruleId, enabled)
    setRules(await window.origread.listWebsiteRulesForUrl(feed.url))
    if (!enabled && settings?.preferredRuleId === ruleId) {
      setSettings(await window.origread.setWebsiteSourcePreferredRule(feed.id, null))
    }
  })
  /** 动态渲染开关写入后才更新界面，避免 IPC 失败被当作保存成功。 */
  const setDynamicRendering = (enabled: boolean) => execute(async () => { setSettings(await window.origread.setWebsiteSourceDynamicRendering(feed.id, enabled)) })
  return { settings, candidates, rules, busy, evaluate, setPreferredRule, setRuleEnabled, setDynamicRendering }
}

/** 规则目录按稳定规则 ID 合并探测诊断，开关与偏好设置分别提交。 */
function WebsiteRuleList({ state }: { readonly state: WebsiteSettings }): React.JSX.Element {
  const { t } = useTranslation()
  const byId = new Map(state.candidates.map((candidate) => [candidate.rule.id, candidate]))
  return <div className="source-parser-group">
    <div className="source-parser-group-heading"><div><h4>{t('websiteParserRules')} ({state.rules.length})</h4><p>{t('websiteParserRulesDesc')}</p></div></div>
    {state.rules.length === 0 ? <p className="source-settings-muted">{t('noMatchingWebsiteRules')}</p> : <div className="source-parser-rule-list">{state.rules.map((rule) => {
      const candidate = byId.get(rule.id)
      const selected = state.settings?.preferredRuleId === rule.id
      const label = candidate ? t('websiteRuleCandidateStats', { count: candidate.diagnostics.articleCount, score: candidate.diagnostics.score, state: t(candidate.diagnostics.state === 'AVAILABLE' ? 'websiteParserAvailable' : 'websiteParserUnavailable') })
        : `${rule.hosts.join(', ')} · ${t(rule.enabled ? 'websiteRuleEnabled' : 'websiteRuleDisabled')}`
      return <div className={`source-parser-rule ${selected ? 'selected' : ''}`} key={rule.id}>
        <label className="source-parser-rule-toggle">
          <input type="checkbox" checked={rule.enabled} disabled={state.busy} onChange={(event) => void state.setRuleEnabled(rule.id, event.target.checked)} />
          <span><strong>{rule.name}</strong><small>{label}</small></span>
        </label>
        <button type="button" className="mini-action source-parser-use" disabled={state.busy || !rule.enabled} onClick={() => void state.setPreferredRule(rule.id)}>{t(selected ? 'currentChoice' : 'useParser')}</button>
      </div>
    })}</div>}
  </div>
}

/** 排除已配置目录项后展示自动解析器，名称只替换内置前缀并保留诊断后缀。 */
function WebsiteBuiltInList({ state }: { readonly state: WebsiteSettings }): React.JSX.Element {
  const { t } = useTranslation()
  const configured = new Set(state.rules.map((rule) => rule.id))
  const builtIn = state.candidates.filter((candidate) => !configured.has(candidate.rule.id))
  return <div className="source-parser-group">
    <div className="source-parser-group-heading"><div><h4>{t('websiteParserBuiltIn')} ({builtIn.length})</h4><p>{t('websiteParserBuiltInDesc')}</p></div></div>
    {state.candidates.length === 0 ? <p className="source-settings-muted">{t('noBuiltInWebsiteCandidates')}</p> : builtIn.length === 0 ? <p className="source-settings-muted">{t('noAvailableBuiltInWebsiteCandidates')}</p> : <div className="source-parser-candidates">{builtIn.map((candidate) => {
      const selected = state.settings?.preferredRuleId === candidate.rule.id
      const available = candidate.diagnostics.state === 'AVAILABLE'
      const name = candidate.rule.id.startsWith('auto-dom:')
        ? `${t('websiteParserSmartDetection')}${candidate.rule.name.includes(' · ') ? ` · ${candidate.rule.name.split(' · ').slice(1).join(' · ')}` : ''}` : candidate.rule.name
      return <button type="button" key={candidate.rule.id} disabled={!available || state.busy} className={`source-parser-option ${selected ? 'selected' : ''} ${!available ? 'unavailable' : ''}`} onClick={() => void state.setPreferredRule(candidate.rule.id)}>
        <span><strong>{name}</strong><small>{t('websiteRuleCandidateStats', { count: candidate.diagnostics.articleCount, score: candidate.diagnostics.score, state: t(available ? 'websiteParserAvailable' : 'websiteParserUnavailable') })}</small></span>
        <span className="source-parser-option-state">{selected ? t('currentChoice') : ''}</span>
      </button>
    })}</div>}
  </div>
}
