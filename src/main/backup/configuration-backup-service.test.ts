import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { SettingsRepository } from '../database/settings-repository'
import { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { JsonRuleRepository } from '../sources/json/json-rule-repository'
import { ArticleFilterRepository } from '../filter/article-filter-repository'
import { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import { TranslationSettingsRepository } from '../translation/translation-settings-repository'
import { AiSettingsRepository } from '../ai/ai-settings-repository'
import { MemorySecretStore } from '../security/secret-store'
import { ConfigurationBackupService } from './configuration-backup-service'
import { encryptConfigurationSecrets } from './configuration-backup-crypto'
import type { ConfigurationBackup } from '../../shared/configuration-backup'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('ConfigurationBackupService Android v1 compatibility', () => {
  it('merges Android subscriptions, preserves articles, remaps source rules, and restores encrypted credentials', () => {
    const fixture = createFixture()
    const now = 1_786_700_000_000
    fixture.library.upsertFeed({
      id: 'existing-feed', groupId: DEFAULT_GROUP_ID, name: 'Old Name', url: 'https://example.com/feed.xml',
      sourcePageUrl: 'https://example.com/', sourceType: 'rss', icon: null, isNotification: false,
      isFullContent: false, isBrowser: false, dynamicRendering: false, createdAt: now, updatedAt: now
    })
    fixture.library.upsertFeed({
      id: 'desktop-extra', groupId: DEFAULT_GROUP_ID, name: 'Desktop Extra', url: 'https://extra.example/feed.xml',
      sourcePageUrl: 'https://extra.example/', sourceType: 'rss', icon: null, isNotification: false,
      isFullContent: false, isBrowser: false, dynamicRendering: false, createdAt: now, updatedAt: now
    })
    fixture.library.upsertArticle({
      id: 'kept-article', feedId: 'existing-feed', title: 'Keep me', url: 'https://example.com/article', author: null,
      publishedAt: now, description: 'Existing article', contentHtml: null, fullContentHtml: null, imageUrl: null,
      isUnread: false, isStarred: true, createdAt: now, updatedAt: now
    })

    const backup = androidBackup(fixture)
    const result = fixture.backup.restoreBackup(JSON.stringify(backup), 'backup-pass')

    expect(result).toMatchObject({ groupsAdded: 1, feedsAdded: 1, feedsUpdated: 1, credentialsRestored: true })
    expect(fixture.library.findFeedByUrl('https://example.com/feed.xml')).toMatchObject({ id: 'existing-feed', name: 'Android Updated' })
    const newFeed = fixture.library.findFeedByUrl('https://new.example/feed.xml')
    expect(newFeed).not.toBeNull()
    expect(fixture.library.getFeedById('desktop-extra')).not.toBeNull()
    expect(fixture.library.getArticleById('kept-article')).toMatchObject({ isUnread: false, isStarred: true })
    expect(fixture.filters.getByFeed('existing-feed').map((rule) => rule.keyword)).toContain('Sponsored')
    expect(fixture.filters.getByFeed(newFeed!.id).map((rule) => rule.keyword)).toContain('Promo')
    expect(fixture.translation.getApiKey('DEEPL')).toBe('android-deepl-key')
    expect(fixture.ai.getApiKey('android-ai')).toBe('android-ai-key')
    expect(fixture.settings.current()).toMatchObject({ syncIntervalMinutes: 60, syncOnStart: true })
  })

  it('exports the Android envelope and can omit or include encrypted secrets', () => {
    const fixture = createFixture()
    fixture.ai.updateProvider({ id: 'default', endpoint: 'https://api.example/v1', defaultModel: 'model', apiKey: 'secret-ai' })
    fixture.translation.updateProvider({ type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', apiKey: 'secret-deepl' })

    const plain = JSON.parse(fixture.backup.exportBackup('')) as ConfigurationBackup
    expect(plain).toMatchObject({ schemaVersion: 1, appName: 'OrigRead', sourceVersion: '0.1.0' })
    expect(plain.preferences).toMatchObject({
      'origread.desktop.readerFontSize': 17,
      'origread.desktop.readerLineHeight': 1.85,
      'origread.desktop.readerContentWidth': 760
    })
    expect(plain.encryptedSecrets).toBeNull()

    const encrypted = JSON.parse(fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
    expect(encrypted.encryptedSecrets).toMatchObject({ kdf: 'PBKDF2WithHmacSHA256', cipher: 'AES-256-GCM', iterations: 210_000 })
  })
})

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'origread-backup-'))
  dirs.push(dir)
  const database = new DesktopDatabase(':memory:')
  const library = new LibraryRepository(database.connection)
  const settings = new SettingsRepository(database.connection)
  const websiteRules = new WebsiteRuleRepository(join(dir, 'website-rules.json'))
  const jsonRules = new JsonRuleRepository(join(dir, 'json-rules.json'))
  const filters = new ArticleFilterRepository(join(dir, 'filters.json'))
  const websitePreferences = new WebsiteParsePreferenceRepository(join(dir, 'website-preferences.json'))
  const rssHub = new RssHubSettingsRepository(database.connection)
  const secrets = new MemorySecretStore()
  const translation = new TranslationSettingsRepository(database.connection, secrets)
  const ai = new AiSettingsRepository(database.connection, secrets)
  const backup = new ConfigurationBackupService('0.1.0', library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai)
  return { dir, database, library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai, backup }
}

function androidBackup(fixture: ReturnType<typeof createFixture>): ConfigurationBackup {
  const encryptedSecrets = encryptConfigurationSecrets({
    translationApiKeys: { DEEPL: 'android-deepl-key' },
    aiApiKeys: { 'android-ai': 'android-ai-key' }
  }, 'backup-pass')
  return {
    schemaVersion: 1,
    appName: 'OrigRead',
    sourceVersion: '1.0.0-android',
    createdAtEpochMillis: 1_786_700_000_000,
    preferences: {},
    accountSettings: {
      syncIntervalMinutes: 60,
      syncOnStart: true,
      syncOnlyOnWiFi: false,
      syncOnlyWhenCharging: false,
      keepArchivedMillis: 2_592_000_000,
      syncBlockList: []
    },
    subscriptions: {
      sourceAccountId: 1,
      groups: [
        { id: 'android-default-group', name: '默认', isDefault: true },
        { id: 'android-tech-group', name: '科技', isDefault: false }
      ],
      feeds: [
        { id: 'android-existing', name: 'Android Updated', icon: null, url: 'https://example.com/feed.xml', groupId: 'android-default-group', isNotification: true, isFullContent: false, isBrowser: false, sourceType: 'RSS' },
        { id: 'android-new', name: 'Android New', icon: null, url: 'https://new.example/feed.xml', groupId: 'android-tech-group', isNotification: false, isFullContent: false, isBrowser: false, sourceType: 'RSS' }
      ]
    },
    websiteRules: JSON.parse(fixture.websiteRules.exportRules()),
    jsonRules: JSON.parse(fixture.jsonRules.exportRules()),
    articleFilters: {
      schemaVersion: 1,
      rules: [
        { id: 'global-filter', keyword: 'Ads', feedId: null, feedName: null, type: 'KEYWORD', enabled: true },
        { id: 'existing-filter', keyword: 'Sponsored', feedId: 'android-existing', feedName: 'Android Updated', type: 'KEYWORD', enabled: true },
        { id: 'new-filter', keyword: 'Promo', feedId: 'android-new', feedName: 'Android New', type: 'KEYWORD', enabled: true }
      ],
      stats: { totalFiltered: 8, lastFilteredAt: null, lastMatchedRule: null }
    },
    websiteParsePreferences: { items: [] },
    rssHub: fixture.rssHub.current(),
    rssHubSourceUrls: {},
    translation: {
      defaultProvider: 'DEEPL',
      defaultTarget: { type: 'traditional', provider: 'DEEPL' },
      targetLanguage: 'zh-CN',
      displayMode: 'BILINGUAL',
      providers: [
        { type: 'ML_KIT', enabled: true, endpoint: '', region: '' },
        { type: 'MICROSOFT', enabled: false, endpoint: 'https://api.cognitive.microsofttranslator.com', region: '' },
        { type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', region: '' },
        { type: 'GOOGLE_CLOUD', enabled: false, endpoint: 'https://translation.googleapis.com/language/translate/v2', region: '' },
        { type: 'DLX', enabled: false, endpoint: '', region: '' }
      ]
    },
    ai: {
      enabled: true,
      defaultProviderId: 'android-ai',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD',
      providers: [{ id: 'android-ai', name: 'Android AI', enabled: true, endpoint: 'https://ai.example/v1', defaultModel: 'android-model', models: ['android-model'] }]
    },
    encryptedSecrets
  }
}

