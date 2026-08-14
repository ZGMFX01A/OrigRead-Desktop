import { BookOpenText, Clock3, Database, Globe2, Settings2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import {
  SYNC_INTERVAL_OPTIONS,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type SyncIntervalMinutes
} from '../../shared/settings'
import type { SyncRuntimeState } from '../../shared/sync-runtime'

interface SettingsPanelProps {
  settings: DesktopSettings
  appInfo: AppInfo | null
  syncState: SyncRuntimeState | null
  onChange(patch: DesktopSettingsPatch): void
}

export function SettingsPanel({ settings, appInfo, syncState, onChange }: SettingsPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const dateLocale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US'
  return (
    <div className="settings-page">
      <div className="settings-intro">
        <div className="settings-intro-icon"><Settings2 size={22} /></div>
        <div>
          <h1>{t('settings')}</h1>
          <p>{t('settingsDescription')}</p>
        </div>
      </div>

      <SettingsSection icon={<Globe2 size={17} />} title={t('settingsGeneral')}>
        <SettingRow title={t('language')} description={t('languageDescription')}>
          <select
            className="language-select"
            aria-label={t('language')}
            value={settings.language}
            onChange={(event) => onChange({ language: event.target.value as DesktopSettings['language'] })}
          >
            <option value="system">{t('languageSystem')}</option>
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<BookOpenText size={17} />} title={t('settingsReading')}>
        <SettingRow title={t('readerFontSize')} description={t('readerFontSizeDescription')}>
          <select
            className="reader-font-size-select"
            aria-label={t('readerFontSize')}
            value={settings.readerFontSize}
            onChange={(event) => onChange({ readerFontSize: Number(event.target.value) })}
          >
            <option value={15}>{t('readerFontSmall')}</option>
            <option value={17}>{t('readerFontStandard')}</option>
            <option value={19}>{t('readerFontLarge')}</option>
            <option value={21}>{t('readerFontExtraLarge')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('readerLineHeight')} description={t('readerLineHeightDescription')}>
          <select
            className="reader-line-height-select"
            aria-label={t('readerLineHeight')}
            value={settings.readerLineHeight}
            onChange={(event) => onChange({ readerLineHeight: Number(event.target.value) })}
          >
            <option value={1.65}>{t('readerCompact')}</option>
            <option value={1.85}>{t('readerStandard')}</option>
            <option value={2.05}>{t('readerRelaxed')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('readerContentWidth')} description={t('readerContentWidthDescription')}>
          <select
            className="reader-content-width-select"
            aria-label={t('readerContentWidth')}
            value={settings.readerContentWidth}
            onChange={(event) => onChange({ readerContentWidth: Number(event.target.value) })}
          >
            <option value={680}>{t('readerWidthNarrow')}</option>
            <option value={760}>{t('readerWidthStandard')}</option>
            <option value={900}>{t('readerWidthWide')}</option>
          </select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<Clock3 size={17} />} title={t('settingsSync')}>
        <SettingRow title={t('syncInterval')} description={t('syncIntervalDescription')}>
          <select
            className="sync-interval-select"
            aria-label={t('syncInterval')}
            value={settings.syncIntervalMinutes}
            onChange={(event) => onChange({ syncIntervalMinutes: Number(event.target.value) as SyncIntervalMinutes })}
          >
            {SYNC_INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>{syncIntervalLabel(minutes, t)}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title={t('syncOnStart')} description={t('syncOnStartDescription')}>
          <label className="setting-switch">
            <input
              type="checkbox"
              aria-label={t('syncOnStart')}
              checked={settings.syncOnStart}
              onChange={(event) => onChange({ syncOnStart: event.target.checked })}
            />
            <span />
          </label>
        </SettingRow>
        <div className="sync-runtime-card">
          <div><span>{t('syncStatus')}</span><strong>{syncState?.running ? t('syncRunning') : t('syncIdle')}</strong></div>
          <div><span>{t('lastSync')}</span><strong>{formatDate(syncState?.lastFinishedAt, t('never'), dateLocale)}</strong></div>
          <div><span>{t('nextSync')}</span><strong>{formatDate(syncState?.nextRunAt, t('manualOnly'), dateLocale)}</strong></div>
        </div>
      </SettingsSection>

      <SettingsSection icon={<Database size={17} />} title={t('settingsData')}>
        <PlaceholderRow title={t('backupRestore')} description={t('comingLater')} badge={t('comingSoonBadge')} />
        <PlaceholderRow title={t('ruleManagement')} description={t('comingLater')} badge={t('comingSoonBadge')} />
      </SettingsSection>

      <SettingsSection icon={<Sparkles size={17} />} title={t('settingsIntelligence')}>
        <PlaceholderRow title={t('aiProvider')} description={t('comingLater')} badge={t('comingSoonBadge')} />
        <PlaceholderRow title={t('translationProvider')} description={t('comingLater')} badge={t('comingSoonBadge')} />
      </SettingsSection>

      <div className="settings-about">
        <span>{t('brand')}</span>
        <small>{appInfo ? `v${appInfo.version} · ${appInfo.platform}` : '—'}</small>
      </div>
    </div>
  )
}

function SettingsSection({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-title">{icon}<span>{title}</span></div>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-copy"><strong>{title}</strong><span>{description}</span></div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function PlaceholderRow({ title, description, badge }: { title: string; description: string; badge: string }): React.JSX.Element {
  return (
    <div className="setting-row setting-placeholder" aria-disabled="true">
      <div className="setting-copy"><strong>{title}</strong><span>{description}</span></div>
      <span className="coming-badge">{badge}</span>
    </div>
  )
}

function syncIntervalLabel(minutes: SyncIntervalMinutes, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (minutes === 0) return t('syncManual')
  if (minutes < 60) return t('syncEveryMinutes', { count: minutes })
  if (minutes === 60) return t('syncEveryHour')
  if (minutes < 1440) return t('syncEveryHours', { count: minutes / 60 })
  return t('syncEveryDay')
}

function formatDate(value: number | null | undefined, fallback: string, locale: string): string {
  return value ? new Date(value).toLocaleString(locale) : fallback
}


