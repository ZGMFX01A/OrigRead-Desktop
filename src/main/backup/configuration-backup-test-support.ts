
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
import { LlmSkillRepository } from '../llm/skill-repository'
import { LlmQuickMessageRepository } from '../llm/quick-message-repository'
import { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { WebSearchRepository } from '../search/web-search-repository'
import { McpRemoteRepository } from '../mcp/mcp-remote-repository'
import { McpLocalRepository } from '../mcp/mcp-local-repository'
import { join } from 'node:path'

/** 使用正式配置恢复器、真实 SQLite 和独立规则文件验证备份行为。 */
export function createConfigurationBackupFixture(dir: string) {
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
    undefined, skills, quickMessages, customization, webSearch, mcpRemote, mcpLocal, database.connection, secrets
  )
  return { dir, database, library, settings, websiteRules, jsonRules, filters, websitePreferences, rssHub, translation, ai, skills, quickMessages, customization, webSearch, mcpRemote, mcpLocal, secrets, backup }
}
