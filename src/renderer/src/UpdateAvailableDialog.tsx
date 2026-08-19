import { Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
      <header className="dialog-header update-dialog-header">
        <div className="update-dialog-heading">
          <div className="update-dialog-title-line">
            <h2>{t('updateAvailable')}</h2>
            <span className="update-version-badge">v{release.version}</span>
          </div>
          <div className="update-dialog-meta">
            {release.publishedDate&&<span>{t('releaseDate')} · {release.publishedDate}</span>}
            {!release.publishedDate&&release.title&&<span>{release.title}</span>}
          </div>
        </div>
        <button type="button" className="dialog-close" onClick={onClose}><X size={17}/></button>
      </header>
      <div className="update-dialog-body">
        {release.notes&&<section className="update-release-notes">
          <strong>{t('releaseNotes')}</strong>
          <div className="update-release-notes-surface"><ReleaseNotesMarkdown text={release.notes}/></div>
        </section>}
        {release.asset&&<div className="update-release-asset-summary">
          <span className="update-release-asset-icon"><Download size={15}/></span>
          <div><span>{t('releaseAsset')}</span><strong>{release.asset.name}</strong></div>
        </div>}
        {!release.asset&&<div className="dialog-error">{t('noPlatformAsset')}</div>}
        {status&&<div className="settings-status">{status}</div>}
      </div>
      <footer className="dialog-footer update-dialog-footer">
        <button type="button" className="dialog-cancel update-later-button" onClick={onClose}>{t('later')}</button>
        <div className="update-dialog-actions">
          <button type="button" className="mini-action update-release-page-button" onClick={()=>void window.origread.openExternalUrl(release.releasePageUrl)}><ExternalLink size={14}/>{t('openReleasePage')}</button>
          {downloaded
            ? <button type="button" className="dialog-submit update-primary-action" onClick={()=>void launch()}>{t('installUpdate')}</button>
            : release.asset&&<button type="button" className="dialog-submit update-primary-action" disabled={busy} onClick={()=>void download()}>{busy?<RefreshCw size={14} className="spinning"/>:<Download size={14}/>} {busy?t('downloadingUpdate'):t('downloadUpdate')}</button>}
        </div>
      </footer>
    </section>
  </div>
}

/**
 * Release notes 只渲染常见 Markdown 子集，不把 GitHub Release body 当 HTML 注入 Renderer。
 * 既能去掉原始 `##` / `-` / `---` 控制字符，也保持更新日志的层级和可读性。
 */
function ReleaseNotesMarkdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let unorderedItems: string[] = []
  let orderedItems: string[] = []

  const flushLists = (): void => {
    if (unorderedItems.length > 0) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{unorderedItems.map((item,index)=><li key={index}>{renderReleaseInline(item)}</li>)}</ul>)
      unorderedItems = []
    }
    if (orderedItems.length > 0) {
      blocks.push(<ol key={`ol-${blocks.length}`}>{orderedItems.map((item,index)=><li key={index}>{renderReleaseInline(item)}</li>)}</ol>)
      orderedItems = []
    }
  }

  for (const sourceLine of lines) {
    const line = sourceLine.trim()
    if (!line || /^<!--[\s\S]*-->$/.test(line)) {
      flushLists()
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading?.[1]&&heading[2]) {
      flushLists()
      const level = heading[1].length
      const content = renderReleaseInline(heading[2])
      if (level === 1) blocks.push(<h3 key={blocks.length}>{content}</h3>)
      else if (level === 2) blocks.push(<h4 key={blocks.length}>{content}</h4>)
      else blocks.push(<h5 key={blocks.length}>{content}</h5>)
      continue
    }
    if (/^([-*_])\1{2,}$/.test(line)) {
      flushLists()
      blocks.push(<hr key={blocks.length}/>)
      continue
    }
    const unordered = line.match(/^[-*]\s+(.+)$/)
    if (unordered?.[1]) {
      if (orderedItems.length > 0) flushLists()
      unorderedItems.push(unordered[1])
      continue
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (ordered?.[1]) {
      if (unorderedItems.length > 0) flushLists()
      orderedItems.push(ordered[1])
      continue
    }
    flushLists()
    blocks.push(<p key={blocks.length}>{renderReleaseInline(line)}</p>)
  }
  flushLists()
  return <div className="update-release-notes-markdown">{blocks}</div>
}

function renderReleaseInline(text: string): ReactNode[] {
  const result: ReactNode[] = []
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > start) result.push(text.slice(start, match.index))
    if (match[2]) result.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>)
    else if (match[3]) result.push(<code key={`code-${match.index}`}>{match[3]}</code>)
    else if (match[4]&&match[5]) {
      const label = match[4]
      const url = match[5]
      result.push(<a key={`link-${match.index}`} href={url} onClick={(event)=>{event.preventDefault();void window.origread.openExternalUrl(url)}}>{label}</a>)
    }
    start = pattern.lastIndex
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

