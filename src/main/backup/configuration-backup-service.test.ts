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
import { LlmSkillRepository } from '../llm/skill-repository'
import { LlmQuickMessageRepository } from '../llm/quick-message-repository'
import { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { WebSearchRepository } from '../search/web-search-repository'

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
    fixture.settings.update({
      sourcePaneWidth: 310,
      articlePaneWidth: 460,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: true
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
    expect(fixture.settings.current()).toMatchObject({
      syncIntervalMinutes: 60,
      syncOnStart: true,
      layoutMode: 'three-pane',
      sourcePaneWidth: 260,
      articlePaneWidth: 380,
      sourcePaneCollapsed: false,
      articlePaneCollapsed: false
    })
  })

  it('exports the Android envelope and can omit or include encrypted secrets', () => {
    const fixture = createFixture()
    fixture.ai.updateProvider({ id: 'default', endpoint: 'https://api.example/v1', defaultModel: 'model', apiKey: 'secret-ai' })
    fixture.translation.updateProvider({ type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', apiKey: 'secret-deepl' })
    fixture.settings.update({ layoutMode: 'two-pane', sourcePaneWidth: 300, articlePaneWidth: 440, sourcePaneCollapsed: true })

    const plainContent = fixture.backup.exportBackup('')
    const plain = JSON.parse(plainContent) as ConfigurationBackup
    expect(plain).toMatchObject({ schemaVersion: 1, appName: 'OrigRead', sourceVersion: '0.1.0' })
    expect(plain.preferences).toMatchObject({
      'origread.desktop.readerFontSize': 17,
      'origread.desktop.readerLineHeight': 1.85,
      'origread.desktop.readerContentWidth': 760,
      'origread.desktop.layoutMode': 'two-pane',
      'origread.desktop.sourcePaneWidth': 300,
      'origread.desktop.articlePaneWidth': 440,
      'origread.desktop.sourcePaneCollapsed': true,
      'origread.desktop.articlePaneCollapsed': false,
      'origread.desktop.aiSummaryPlacement': 'right'
    })
    expect(plain.encryptedSecrets).toBeNull()

    fixture.settings.update({ layoutMode: 'three-pane', sourcePaneWidth: 220, articlePaneWidth: 320, sourcePaneCollapsed: false, articlePaneCollapsed: true })
    fixture.backup.restoreBackup(plainContent)
    expect(fixture.settings.current()).toMatchObject({
      layoutMode: 'two-pane',
      sourcePaneWidth: 300,
      articlePaneWidth: 440,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: false
    })

    const encrypted = JSON.parse(fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
    expect(encrypted.encryptedSecrets).toMatchObject({ kdf: 'PBKDF2WithHmacSHA256', cipher: 'AES-256-GCM', iterations: 210_000 })
  })

  it.each(['replace', 'top', 'bottom'] as const)('restores legacy desktop summary placement %s as right', (legacyPlacement) => {
    const fixture = createFixture()
    const backup = androidBackup(fixture)
    backup.preferences = {
      'origread.desktop.aiSummaryPlacement': legacyPlacement,
      'origread.desktop.aiSummaryPanelSize': 430
    }

    fixture.backup.restoreBackup(JSON.stringify(backup), 'backup-pass')

    expect(fixture.settings.current()).toMatchObject({
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 430
    })
  })

  it('round-trips Skills, Quick Messages, and Custom Instructions without exposing them as secrets', async () => {
    const fixture = createFixture()
    await fixture.skills.createFromMarkdown(`---\nname: evidence-reader\ndescription: Use for evidence checks\n---\nCheck claims carefully.`)
    fixture.skills.setBinding('SUMMARY', 'evidence-reader')
    fixture.quickMessages.create('Compare', 'Compare {{article_title}} with the current evidence.')
    fixture.customization.update({ skillsEnabled: false, customInstructions: 'Prefer concise answers.' })

    const content = fixture.backup.exportBackup('')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.llm).toMatchObject({
      customization: { skillsEnabled: false, customInstructions: 'Prefer concise answers.' }
    })
    expect(JSON.stringify(exported.llm)).toContain('evidence-reader')
    expect(JSON.stringify(exported.llm)).toContain('Compare')
    expect(exported.encryptedSecrets).toBeNull()

    fixture.skills.delete('evidence-reader')
    fixture.quickMessages.delete(fixture.quickMessages.current().find((message) => message.title === 'Compare')!.id)
    fixture.customization.update({ skillsEnabled: true, customInstructions: 'Changed after backup.' })
    fixture.backup.restoreBackup(content)

    expect(fixture.skills.skill('evidence-reader')).toMatchObject({ id: 'evidence-reader', enabled: true })
    expect(fixture.skills.current().bindings.summarySkillId).toBe('evidence-reader')
    expect(fixture.quickMessages.current().some((message) => message.title === 'Compare')).toBe(true)
    expect(fixture.customization.current()).toEqual({ skillsEnabled: false, customInstructions: 'Prefer concise answers.' })
  })

  it('round-trips Web Search profiles separately from encrypted API keys and rejects dangling Search secrets', () => {
    const fixture = createFixture()
    const added = fixture.webSearch.addProvider('TAVILY')
    const provider = added.providers[0]!
    fixture.webSearch.updateProvider({
      id: provider.id,
      name: 'Backup Tavily',
      endpoint: 'https://api.tavily.com/search',
      apiKey: 'search-secret-value'
    })
    fixture.webSearch.updateSettings({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })

    const content = fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.webSearch).toMatchObject({
      mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8,
      providers: [{ id: provider.id, kind: 'TAVILY', name: 'Backup Tavily' }]
    })
    expect(JSON.stringify(exported.webSearch)).not.toContain('search-secret-value')
    expect(content).not.toContain('search-secret-value')

    fixture.webSearch.removeProvider(provider.id)
    expect(fixture.webSearch.current().providers).toHaveLength(0)
    fixture.backup.restoreBackup(content, 'backup-pass')
    expect(fixture.webSearch.current()).toMatchObject({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })
    expect(fixture.webSearch.getApiKey(provider.id)).toBe('search-secret-value')

    const dangling = { ...exported }
    dangling.encryptedSecrets = encryptConfigurationSecrets({
      translationApiKeys: {}, aiApiKeys: {}, webSearchApiKeys: { 'missing-provider': 'bad-secret' }
    }, 'backup-pass')
    expect(() => fixture.backup.restoreBackup(JSON.stringify(dangling), 'backup-pass')).toThrow('Web Search 凭据引用了不存在的 Provider')
  })

  it('keeps current Web Search settings when restoring a pre-D5 backup without Search fields', () => {
    const fixture = createFixture()
    const added = fixture.webSearch.addProvider('KEENABLE')
    const provider = added.providers[0]!
    fixture.webSearch.updateSettings({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 10 })

    fixture.backup.restoreBackup(JSON.stringify(androidBackup(fixture)), 'backup-pass')

    expect(fixture.webSearch.current()).toMatchObject({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 10 })
    expect(fixture.webSearch.current().providers[0]).toMatchObject({ id: provider.id, kind: 'KEENABLE' })
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
  const skills = new LlmSkillRepository(database.connection)
  const quickMessages = new LlmQuickMessageRepository(database.connection)
  const customization = new LlmCustomizationSettingsRepository(database.connection)
  const webSearch = new WebSearchRepository(database.connection, secrets)
  const backup = new ConfigurationBackupService(
    '0.1.0', library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai,
    undefined, skills, quickMessages, customization, webSearch
  )
  return { dir, database, library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai, skills, quickMessages, customization, webSearch, backup }
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

