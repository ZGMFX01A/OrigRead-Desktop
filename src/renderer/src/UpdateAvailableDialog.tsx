import { Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateCheckResult } from '../../shared/update'

export function UpdateAvailableDialog({ result, onClose }: { result: UpdateCheckResult; onClose(): void }): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [status, setStatus] = useState('')
  const release = result.release
  if (!release) return <></>

  const download = async (): Promise<void> => {
    if (!release.asset) return
    setBusy(true)
    setStatus('')
    try {
      const value = await window.origread.downloadUpdateAsset(release.asset.id)
      if (value.cancelled) return
      if (value.error) {
        setStatus(`${t('updateDownloadFailed')}: ${value.error}`)
        return
      }
      if (value.path) {
        setDownloaded(true)
        setStatus(`${t('downloadUpdateSuccess')}: ${value.path}`)
      }
    } catch (error) {
      setStatus(`${t('updateDownloadFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const launch = async (): Promise<void> => {
    setStatus('')
    try {
      await window.origread.launchDownloadedUpdate()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return <div className="dialog-backdrop update-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="update-available-dialog" role="dialog" aria-modal="true" aria-label={t('updateAvailable')} onMouseDown={(event)=>event.stopPropagation()}>
      <header className="dialog-header">
        <div><h2>{t('updateAvailable')} · v{release.version}</h2><p>{release.publishedDate || release.title}</p></div>
        <button type="button" className="dialog-close" onClick={onClose}><X size={17}/></button>
      </header>
      <div className="update-dialog-body">
        {release.notes&&<div className="update-release-notes"><strong>{t('releaseNotes')}</strong><pre>{release.notes}</pre></div>}
        {!release.asset&&<div className="dialog-error">{t('noPlatformAsset')}</div>}
        {status&&<div className="settings-status">{status}</div>}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="dialog-cancel" onClick={onClose}>{t('later')}</button>
        <button type="button" className="mini-action" onClick={()=>void window.origread.openExternalUrl(release.releasePageUrl)}><ExternalLink size={14}/>{t('openReleasePage')}</button>
        {downloaded
          ? <button type="button" className="dialog-submit" onClick={()=>void launch()}>{t('installUpdate')}</button>
          : release.asset&&<button type="button" className="dialog-submit" disabled={busy} onClick={()=>void download()}>{busy?<RefreshCw size={14} className="spinning"/>:<Download size={14}/>} {busy?t('downloadingUpdate'):t('downloadUpdate')}</button>}
      </footer>
    </section>
  </div>
}

