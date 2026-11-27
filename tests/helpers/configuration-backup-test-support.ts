
import { DesktopDatabase } from '../../src/main/database/database'
import { LibraryRepository } from '../../src/main/database/library-repository'
import { SettingsRepository } from '../../src/main/database/settings-repository'
import { WebsiteRuleRepository } from '../../src/main/sources/website/website-rule-repository'
import { JsonRuleRepository } from '../../src/main/sources/json/json-rule-repository'
import { ArticleFilterRepository } from '../../src/main/filter/article-filter-repository'
import { WebsiteParsePreferenceRepository } from '../../src/main/sources/website/website-parse-preference-repository'
import { RssHubSettingsRepository } from '../../src/main/sources/rsshub/rsshub-settings-repository'
import { TranslationSettingsRepository } from '../../src/main/translation/translation-settings-repository'
import { AiSettingsRepository } from '../../src/main/ai/ai-settings-repository'
import { MemorySecretStore } from '../../src/main/security/secret-store'
import { ConfigurationBackupService } from '../../src/main/backup/configuration-backup-service'
import { LlmSkillRepository } from '../../src/main/llm/skill-repository'
import { LlmQuickMessageRepository } from '../../src/main/llm/quick-message-repository'
import { LlmCustomizationSettingsRepository } from '../../src/main/llm/customization-settings-repository'
import { WebSearchRepository } from '../../src/main/search/web-search-repository'
import { McpRemoteRepository } from '../../src/main/mcp/mcp-remote-repository'
import { McpLocalRepository } from '../../src/main/mcp/mcp-local-repository'
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
