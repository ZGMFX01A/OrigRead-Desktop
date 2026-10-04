import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedRecord } from '../../shared/library'
import type { JsonBindingProbe, JsonRule } from '../../shared/json-source'
import { JsonSourceRepairRequests } from './json-source-repair-requests'

interface Props { readonly feed: FeedRecord; readonly onChanged: (feed: FeedRecord | null) => void }

/** 来源修复只在用户确认后替换绑定，原文章和状态继续保留。 */
export function JsonSourceSettingsPanel({ feed, onChanged }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { url, probe, candidateId, busy, error, changeUrl, detect, confirm, setCandidateId } = useJsonSourceRepair(feed, onChanged)
  const catalog = useJsonRuleCatalog(feed.url)
  return <section className="source-settings-card">
    <div className="source-section-heading"><div><h3>{t('jsonSourceParser')}</h3><p>{t('jsonSourceRepairDescription')}</p></div></div>
    <label className="dialog-field"><span>{t('jsonSourcePageUrl')}</span><input value={url} disabled={busy && probe !== null} onChange={(event) => changeUrl(event.target.value)} /></label>
    <div className="source-parser-actions">
      <button type="button" className="mini-action" disabled={busy || !url.trim()} onClick={() => void detect()}>{busy ? <RefreshCw size={13} className="spinning" /> : null}{t('jsonSourceReprobe')}</button>
      <button type="button" className="mini-action" disabled={busy || !probe || !candidateId} onClick={() => void confirm()}>{t('jsonSourceConfirmBinding')}</button>
    </div>
    {(error || catalog.error) && <div className="dialog-error">{error || catalog.error}</div>}
    {probe && <div className="source-parser-candidates">{probe.candidates.map((candidate) => <label className={`source-parser-candidate ${candidateId === candidate.candidateId ? 'selected' : ''}`} key={candidate.candidateId}>
      <input type="radio" checked={candidateId === candidate.candidateId} disabled={busy} onChange={() => setCandidateId(candidate.candidateId)} />
      <span><strong>{candidate.name}</strong><small>{candidate.endpointUrl} · {t('jsonSourceCandidateCount', { count: candidate.articleCount })}</small><small>{candidate.sampleTitles.join(' · ')}</small></span>
    </label>)}</div>}
    {catalog.rules.length > 0 && <div className="source-parser-candidates">{catalog.rules.map((rule) => <label className="source-parser-candidate" key={rule.id}>
      <input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(event) => void catalog.setEnabled(rule, event.target.checked)} />
      <span><strong>{rule.name}</strong><small>{rule.sourceKind} · {rule.enabled ? t('jsonRuleEnabled') : t('jsonRuleDisabled')}</small></span>
    </label>)}</div>}
  </section>
}

/** React 管理输入和预览，请求执行与取消逻辑通过注入的 API 独立维护。 */
function useJsonSourceRepair(feed: FeedRecord, onChanged: Props['onChanged']) {
  const [url, setUrl] = useState(feed.sourcePageUrl ?? feed.url)
  const [probe, setProbe] = useState<JsonBindingProbe | null>(null)
  const [candidateId, setCandidateId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requests] = useState(() => new JsonSourceRepairRequests({ api: window.origread, createRequestId: () => globalThis.crypto.randomUUID() }))
  useEffect(() => () => requests.cancel(), [feed.id, requests])
  const publisher = { setBusy, setError }
  /** 修改地址立即废弃旧预览，避免将上轮规则确认到新的输入。 */
  const changeUrl = (value: string): void => {
    requests.cancel()
    setUrl(value)
    setProbe(null)
    setCandidateId('')
    setBusy(false)
    setError(null)
  }
  return { url, probe, candidateId, busy, error, setCandidateId, changeUrl,
    detect: () => {
      setProbe(null)
      return requests.detect({ feedId: feed.id, url: url.trim(), publisher, onProbe: (result) => {
        setProbe(result); setCandidateId(result.candidates[0]?.candidateId ?? '')
      } })
    },
    confirm: () => probe && candidateId
      ? requests.confirm({ feedId: feed.id, probe, candidateId, publisher, onChanged }) : Promise.resolve()
  }
}

/** 保留原规则目录开关，文件读写失败明确展示，不更改已确认的来源快照。 */
function useJsonRuleCatalog(url: string) {
  const [rules, setRules] = useState<JsonRule[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void window.origread.listJsonRulesForUrl(url).then((loaded) => { if (active) setRules(loaded) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [url])
  /** 写入成功后重读真实规则，不能将失败的开关状态显示成已保存。 */
  const setEnabled = async (rule: JsonRule, enabled: boolean): Promise<void> => {
    setError(null)
    try {
      await window.origread.setJsonRuleEnabled(rule.id, enabled)
      setRules(await window.origread.listJsonRulesForUrl(url))
    } catch (reason) {
      // 文件或 IPC 错误留在当前解析面板。
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  return { rules, error, setEnabled }
}
