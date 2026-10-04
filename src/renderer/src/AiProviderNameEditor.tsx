import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiProviderProfile, AiSettings } from '../../shared/ai'

interface AiProviderNameEditorProps {
  provider: AiProviderProfile
  onSaved(settings: AiSettings): void
}

/** 单独保存服务名称，避免输入草稿修改服务地址、模型或本机凭据。 */
export function AiProviderNameEditor({ provider, onSaved }: AiProviderNameEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(provider.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setName(provider.name) }, [provider.name])

  // 通过既有设置接口按服务 ID 保存；失败时保留草稿并显示真实错误。
  const saveName = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const settings = await window.origread.updateAiProvider({ id: provider.id, name })
      setName(settings.providers.find((item) => item.id === provider.id)!.name)
      onSaved(settings)
    } catch (cause) {
      // 持久化失败不能伪装为保存成功，允许用户保留输入后重新保存。
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <form className="ai-provider-form-field" onSubmit={(event) => void saveName(event)}>
    <span><strong>{t('aiProviderName')}</strong><small>{t('aiProviderNameDescription')}</small></span>
    <div>
      <div className="inline-controls">
        <input className="ai-provider-name-input" aria-label={t('aiProviderName')} value={name}
          disabled={saving} onChange={(event) => setName(event.target.value)}/>
        <button type="submit" className="mini-action" disabled={saving || name === provider.name}>{t('save')}</button>
      </div>
      {error && <div role="alert" className="settings-status">{error}</div>}
    </div>
  </form>
}
