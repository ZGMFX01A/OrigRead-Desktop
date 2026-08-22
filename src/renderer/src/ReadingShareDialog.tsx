import { Link, Share2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReadingSharePreference } from './reading-share'

export type ReadingShareDialogMode = 'first-use' | 'config'

interface ReadingShareDialogProps {
  mode: ReadingShareDialogMode
  preference: ReadingSharePreference
  onClose: () => void
  onUseDefault?: () => void
  onCustomize?: () => void
  onSave?: (preference: ReadingSharePreference) => void
}

export function ReadingShareDialog({
  mode,
  preference,
  onClose,
  onUseDefault,
  onCustomize,
  onSave
}: ReadingShareDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [includeTitle, setIncludeTitle] = useState(preference.includeTitle)
  const [includeBody, setIncludeBody] = useState(preference.includeBody)
  const [includeTranslation, setIncludeTranslation] = useState(preference.includeTranslation)
  const [includeSummary, setIncludeSummary] = useState(preference.includeSummary)

  if (mode === 'first-use') {
    return (
      <div className="dialog-backdrop nested-dialog" role="presentation" onMouseDown={onClose}>
        <section className="reader-tool-dialog reading-share-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog-header">
            <div className="reading-share-dialog-heading">
              <span className="reading-share-dialog-icon"><Share2 size={18} /></span>
              <div>
                <h2>{t('readingShareFirstUseTitle')}</h2>
                <p>{t('readingShareFirstUseDescription')}</p>
              </div>
            </div>
            <button className="dialog-close" type="button" aria-label={t('close')} onClick={onClose}><X size={17} /></button>
          </header>
          <div className="reader-tool-dialog-body reading-share-dialog-body">
            <div className="reading-share-notice"><Link size={16} /><span>{t('readingShareSourceAlways')}</span></div>
            <p className="reading-share-format-note">{t('readingShareMarkdownNote')}</p>
          </div>
          <footer className="dialog-footer">
            <span className="dialog-footer-spacer" />
            <button className="dialog-cancel" type="button" onClick={onClose}>{t('cancel')}</button>
            <button className="dialog-cancel" type="button" onClick={onCustomize}>{t('readingShareCustomize')}</button>
            <button className="dialog-submit" type="button" onClick={onUseDefault}>{t('readingShareUseDefault')}</button>
          </footer>
        </section>
      </div>
    )
  }

  const nextPreference: ReadingSharePreference = {
    configured: true,
    includeTitle,
    includeBody,
    includeTranslation,
    includeSummary
  }

  return (
    <div className="dialog-backdrop nested-dialog" role="presentation" onMouseDown={onClose}>
      <section className="reader-tool-dialog reading-share-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div className="reading-share-dialog-heading">
            <span className="reading-share-dialog-icon"><Share2 size={18} /></span>
            <div>
              <h2>{t('readingShareConfigTitle')}</h2>
              <p>{t('readingShareConfigDescription')}</p>
            </div>
          </div>
          <button className="dialog-close" type="button" aria-label={t('close')} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="reader-tool-dialog-body reading-share-dialog-body">
          <ReadingShareOption label={t('readingShareTitleOption')} checked={includeTitle} onChange={setIncludeTitle} />
          <ReadingShareOption label={t('readingShareBodyOption')} checked={includeBody} onChange={setIncludeBody} />
          <ReadingShareOption label={t('readingShareTranslationOption')} checked={includeTranslation} onChange={setIncludeTranslation} />
          <ReadingShareOption label={t('readingShareSummaryOption')} checked={includeSummary} onChange={setIncludeSummary} />
          <div className="reading-share-notice"><Link size={16} /><span>{t('readingShareSourceAlways')}</span></div>
          <p className="reading-share-format-note">{t('readingShareMarkdownNote')}</p>
        </div>
        <footer className="dialog-footer">
          <span className="dialog-footer-spacer" />
          <button className="dialog-cancel" type="button" onClick={onClose}>{t('cancel')}</button>
          <button className="dialog-submit" type="button" onClick={() => onSave?.(nextPreference)}>{t('save')}</button>
        </footer>
      </section>
    </div>
  )
}

function ReadingShareOption({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return (
    <label className="reading-share-option">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}
