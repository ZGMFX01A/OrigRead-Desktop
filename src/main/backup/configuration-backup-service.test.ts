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
import { McpRemoteRepository, mcpOAuthSecretKey } from '../mcp/mcp-remote-repository'
import { McpLocalRepository } from '../mcp/mcp-local-repository'

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

  it('round-trips Remote/Local MCP profiles and encrypted secrets without restoring transient OAuth state', () => {
    const fixture = createFixture()
    const firstRemote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: firstRemote.id,
      name: 'Backup bearer MCP',
      url: 'https://mcp.example/stream',
      enabled: true,
      authMode: 'BEARER',
      credential: 'remote-bearer-secret'
    })
    const secondRemote = fixture.mcpRemote.addServer().servers.at(-1)!
    fixture.mcpRemote.updateServer({
      id: secondRemote.id,
      name: 'Backup OAuth MCP',
      url: 'https://oauth-mcp.example/mcp',
      enabled: true,
      authMode: 'OAUTH',
      oauthScopes: 'tools.read tools.write'
    })
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'client'), JSON.stringify({ issuer: 'https://auth.example', value: { client_id: 'client-1' } }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'tokens'), JSON.stringify({ issuer: 'https://auth.example', value: { access_token: 'oauth-access-secret', refresh_token: 'oauth-refresh-secret' } }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'discovery'), JSON.stringify({ authorizationServerUrl: 'https://auth.example' }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'verifier'), 'transient-verifier')
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'state'), 'transient-state')

    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({
      id: local.id,
      name: 'Backup local MCP',
      command: process.execPath,
      args: ['fixture-server.cjs', '--stdio'],
      cwd: fixture.dir,
      environment: 'LOCAL_TOKEN=local-env-secret\nLOCAL_MODE=backup',
      enabled: true
    })

    const content = fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp).toMatchObject({
      remote: { servers: [
        { id: firstRemote.id, name: 'Backup bearer MCP', authMode: 'BEARER', enabled: true },
        { id: secondRemote.id, name: 'Backup OAuth MCP', authMode: 'OAUTH', oauthScopes: 'tools.read tools.write', enabled: true }
      ] },
      local: { servers: [{ id: local.id, name: 'Backup local MCP', command: process.execPath, enabled: true }] }
    })
    expect(JSON.stringify(exported.mcp)).not.toContain('remote-bearer-secret')
    expect(JSON.stringify(exported.mcp)).not.toContain('local-env-secret')
    expect(content).not.toContain('remote-bearer-secret')
    expect(content).not.toContain('oauth-access-secret')
    expect(content).not.toContain('local-env-secret')

    fixture.mcpRemote.removeServer(firstRemote.id)
    fixture.mcpRemote.removeServer(secondRemote.id)
    fixture.mcpLocal.removeServer(local.id)
    fixture.backup.restoreBackup(content, 'backup-pass')

    expect(fixture.mcpRemote.current().servers).toMatchObject([
      { id: firstRemote.id, name: 'Backup bearer MCP', authMode: 'BEARER', hasCredential: true },
      { id: secondRemote.id, name: 'Backup OAuth MCP', authMode: 'OAUTH', oauthAuthorized: true }
    ])
    expect(fixture.mcpRemote.getCredential(firstRemote.id)).toBe('remote-bearer-secret')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'client'))).toContain('client-1')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'tokens'))).toContain('oauth-refresh-secret')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'discovery'))).toContain('authorizationServerUrl')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'verifier'))).toBe('')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'state'))).toBe('')
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, name: 'Backup local MCP', enabled: true, hasEnvironment: true })
    expect(fixture.mcpLocal.getEnvironment(local.id)).toContain('LOCAL_TOKEN=local-env-secret')

    const dangling = { ...exported }
    dangling.encryptedSecrets = encryptConfigurationSecrets({
      translationApiKeys: {},
      aiApiKeys: {},
      mcpRemoteCredentials: { 'missing-mcp-server': 'bad-secret' }
    }, 'backup-pass')
    expect(() => fixture.backup.restoreBackup(JSON.stringify(dangling), 'backup-pass')).toThrow('Remote MCP 凭据引用了不存在的 Server')
  })

  it('rejects MCP secrets when the backup has no MCP profiles', () => {
    const fixture = createFixture()
    const legacy = androidBackup(fixture)
    legacy.encryptedSecrets = encryptConfigurationSecrets({
      translationApiKeys: {},
      aiApiKeys: {},
      mcpLocalEnvironments: { 'orphan-local-server': 'TOKEN=orphan-secret' }
    }, 'backup-pass')

    expect(() => fixture.backup.restoreBackup(JSON.stringify(legacy), 'backup-pass'))
      .toThrow('MCP 凭据存在，但备份缺少对应的 MCP 配置')
  })

  it('restores plain MCP profiles without inheriting stale credentials from matching server IDs', () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: remote.id,
      name: 'Plain bearer MCP',
      url: 'https://mcp.example/plain',
      enabled: true,
      authMode: 'BEARER',
      credential: 'backup-time-secret'
    })
    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({
      id: local.id,
      name: 'Plain local MCP',
      command: process.execPath,
      environment: 'LOCAL_TOKEN=backup-time-secret',
      enabled: true
    })

    const content = fixture.backup.exportBackup('')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp).toBeDefined()
    expect(exported.encryptedSecrets).toBeNull()

    fixture.mcpRemote.updateServer({ id: remote.id, credential: 'restore-target-secret' })
    fixture.mcpLocal.updateServer({ id: local.id, environment: 'LOCAL_TOKEN=restore-target-secret' })
    fixture.backup.restoreBackup(content)

    expect(fixture.mcpRemote.getCredential(remote.id)).toBe('')
    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, hasCredential: false })
    expect(fixture.mcpLocal.getEnvironment(local.id)).toBe('')
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, hasEnvironment: false })
  })

  it('round-trips Remote MCP Custom Headers only through encrypted backup secrets', () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: remote.id,
      name: 'Custom Header MCP',
      url: 'https://mcp.example/custom-headers',
      enabled: true,
      authMode: 'CUSTOM_HEADERS',
      credential: 'X-Api-Key: custom-header-secret\nX-Client: OrigRead'
    })

    const content = fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp?.remote.servers[0]).toMatchObject({
      id: remote.id,
      authMode: 'CUSTOM_HEADERS',
      enabled: true
    })
    expect(JSON.stringify(exported.mcp)).not.toContain('custom-header-secret')
    expect(content).not.toContain('custom-header-secret')

    fixture.mcpRemote.removeServer(remote.id)
    fixture.backup.restoreBackup(content, 'backup-pass')
    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, authMode: 'CUSTOM_HEADERS', hasCredential: true })
    expect(fixture.mcpRemote.getCredential(remote.id)).toContain('X-Api-Key: custom-header-secret')
  })

  it('keeps current MCP settings when restoring a pre-D6 backup without MCP fields', () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({ id: remote.id, name: 'Keep remote', url: 'https://mcp.example/mcp', enabled: true })
    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({ id: local.id, name: 'Keep local', command: process.execPath, enabled: true })

    fixture.backup.restoreBackup(JSON.stringify(androidBackup(fixture)), 'backup-pass')

    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, name: 'Keep remote' })
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, name: 'Keep local' })
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
  const mcpRemote = new McpRemoteRepository(database.connection, secrets)
  const mcpLocal = new McpLocalRepository(database.connection, secrets)
  const backup = new ConfigurationBackupService(
    '0.1.0', library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai,
    undefined, skills, quickMessages, customization, webSearch, mcpRemote, mcpLocal
  )
  return { dir, database, library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai, skills, quickMessages, customization, webSearch, mcpRemote, mcpLocal, secrets, backup }
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

