export type SettingsPage = 'general' | 'accounts' | 'translation' | 'ai' | 'filters' | 'jsonRules' | 'websiteRules' | 'rsshub' | 'backup' | 'about' | 'update'
export type AiSettingsView = 'reading' | 'providers' | 'search' | 'behavior'

export const SETTINGS_PAGE_LABELS: Record<SettingsPage, string> = {
  general: 'settingsGeneral', accounts: 'accountsTitle', ai: 'aiSettingsTitle',
  translation: 'translationSettingsTitle', filters: 'articleFilters', jsonRules: 'jsonRules',
  websiteRules: 'websiteRules', rsshub: 'rssHubSettings', backup: 'backupRestore',
  about: 'aboutAndSupport', update: 'softwareUpdate'
}

export interface SettingsSearchItem {
  readonly id: string
  readonly page: SettingsPage
  readonly titleKey: string
  readonly descriptionKey?: string
  readonly sectionKey?: string
  readonly aiView?: AiSettingsView
  readonly anchor?: string
  readonly keywords: readonly string[]
}

export interface SettingsSearchResult {
  readonly item: SettingsSearchItem
  readonly title: string
  readonly description: string
  readonly breadcrumb: string
  readonly score: number
}

export interface SettingsSearchRequest {
  readonly item: SettingsSearchItem
  readonly revision: number
}

function setting(page: SettingsPage, titleKey: string, keywords: readonly string[] = [],
  options: Partial<Omit<SettingsSearchItem, 'id' | 'page' | 'titleKey' | 'keywords'>> = {}): SettingsSearchItem {
  return { id: titleKey, page, titleKey, anchor: titleKey, keywords, ...options }
}

// Index the desktop's actual pages and controls. Conditional controls lead to their
// containing section, so searching never enables a feature or bypasses its disabled state.
export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  ...Object.entries(SETTINGS_PAGE_LABELS).map(([page, titleKey]) => setting(page as SettingsPage, titleKey, [], { anchor: undefined })),
  setting('general', 'language', ['语言', '中文', 'English', 'language'], { descriptionKey: 'languageDescription' }),
  setting('general', 'appearanceTheme', ['深色', '夜间', '主题', 'dark', 'light', 'theme'], { descriptionKey: 'appearanceThemeDescription' }),
  setting('general', 'uiFontScale', ['界面字号', '界面字体', '列表字体', 'UI font size', 'interface text size', 'DPI', '2K'], { descriptionKey: 'uiFontScaleDescription' }),
  setting('general', 'layoutMode', ['布局', '两栏', '三栏', 'layout', 'two pane', 'three pane'], { descriptionKey: 'layoutModeDescription' }),
  setting('general', 'showArticleThumbnails', ['缩略图', '文章图片', '列表图片', 'thumbnail', 'article images', 'list pictures'], { descriptionKey: 'showArticleThumbnailsDescription' }),
  setting('general', 'readerFont', ['字体', '导入字体', 'font', 'TTF', 'OTF'], { descriptionKey: 'readerFontDescription', sectionKey: 'settingsReading' }),
  setting('general', 'readerBackground', ['阅读背景', '护眼', '纸张', 'paper', 'sepia'], { descriptionKey: 'readerBackgroundDescription', sectionKey: 'settingsReading' }),
  setting('general', 'readerBackgroundCustom', ['自定义背景', '颜色', 'background color'], { descriptionKey: 'readerBackgroundCustomDescription', sectionKey: 'settingsReading' }),
  setting('general', 'readerFontSize', ['字号', '字体大小', '正文字号', 'font size', 'article font size'], { descriptionKey: 'readerFontSizeDescription', sectionKey: 'settingsReading' }),
  setting('general', 'readerLineHeight', ['行高', '行距', 'line height', 'line spacing'], { descriptionKey: 'readerLineHeightDescription', sectionKey: 'settingsReading' }),
  setting('general', 'readerContentWidth', ['正文宽度', '页面边距', 'content width', 'margins'], { descriptionKey: 'readerContentWidthDescription', sectionKey: 'settingsReading' }),
  setting('accounts', 'addAccount', ['账户', '账号', '登录', 'FreshRSS', 'Google Reader', 'Fever', 'account', 'login']),
  setting('accounts', 'syncInterval', ['同步', '刷新', 'sync', 'refresh'], { descriptionKey: 'syncIntervalDescription', sectionKey: 'accountDetails' }),
  setting('accounts', 'syncOnStart', ['启动同步', 'startup sync'], { descriptionKey: 'syncOnStartDescription', sectionKey: 'accountDetails' }),
  setting('accounts', 'keepArchivedArticles', ['保留文章', '清理', '存档', 'retention', 'archive'], { descriptionKey: 'keepArchivedDescription', sectionKey: 'accountDetails' }),
  setting('ai', 'aiEnabled', ['AI', '摘要', 'summary'], { descriptionKey: 'aiEnabledDescription', aiView: 'reading', sectionKey: 'aiTabReading' }),
  setting('ai', 'aiDefaultModel', ['默认模型', 'default model'], { descriptionKey: 'aiDefaultModelDescription', aiView: 'reading', sectionKey: 'aiTabReading' }),
  setting('ai', 'aiOutputLanguage', ['AI语言', '输出语言', 'output language'], { descriptionKey: 'aiOutputLanguageDescription', aiView: 'reading', sectionKey: 'aiTabReading' }),
  setting('ai', 'aiSummaryLength', ['摘要长度', 'summary length'], { descriptionKey: 'aiSummaryLengthDescription', aiView: 'reading', sectionKey: 'aiTabReading' }),
  setting('ai', 'aiProviders', ['AI', 'LLM', '模型', '服务商', 'API Key', 'OpenAI', 'Claude', 'Gemini', 'ChatGPT'], { descriptionKey: 'aiProvidersDescription', aiView: 'providers', sectionKey: 'aiTabProviders' }),
  setting('ai', 'webSearchTitle', ['联网搜索', '网页搜索', 'web search', 'internet'], { aiView: 'search', sectionKey: 'aiTabSearch' }),
  setting('ai', 'webSearchProviders', ['搜索服务', 'DeepSeek', 'Tavily', 'Brave', 'SearXNG', 'Perplexity', 'Exa', 'API Key'], { descriptionKey: 'webSearchProvidersDescription', aiView: 'search', sectionKey: 'aiTabSearch' }),
  setting('ai', 'webSearchMode', ['联网模式', '自动搜索', 'search mode', 'AUTO', 'OFF'], { descriptionKey: 'webSearchModeDescription', aiView: 'search', sectionKey: 'aiTabSearch' }),
  setting('ai', 'webSearchDefaultProvider', ['默认搜索', 'default search provider'], { descriptionKey: 'webSearchDefaultProviderDescription', aiView: 'search', sectionKey: 'aiTabSearch' }),
  setting('ai', 'webSearchResultLimit', ['搜索数量', '搜索结果数', 'search result limit'], { descriptionKey: 'webSearchResultLimitDescription', aiView: 'search', sectionKey: 'aiTabSearch' }),
  setting('ai', 'customInstructions', ['自定义指令', '提示词', 'prompt', 'instructions'], { descriptionKey: 'customInstructionsDescription', aiView: 'behavior', sectionKey: 'aiTabBehavior' }),
  setting('ai', 'skillsTitle', ['技能', 'Skill', '自动路由', 'routing'], { aiView: 'behavior', sectionKey: 'aiTabBehavior' }),
  setting('ai', 'quickMessagesTitle', ['快捷消息', '快捷提问', 'quick messages'], { descriptionKey: 'quickMessagesDescription', aiView: 'behavior', sectionKey: 'aiTabBehavior' }),
  setting('ai', 'mcpTitle', ['MCP', '远程工具', 'OAuth', 'remote tools'], { aiView: 'behavior', sectionKey: 'aiTabBehavior' }),
  setting('ai', 'mcpLocalTitle', ['MCP', '本地工具', 'stdio', 'local tools'], { aiView: 'behavior', sectionKey: 'aiTabBehavior' }),
  setting('translation', 'translationTargetLanguage', ['翻译语言', 'target language'], { descriptionKey: 'translationTargetLanguageDescription', sectionKey: 'translationGlobal' }),
  setting('translation', 'translationDisplayMode', ['双语', '译文', 'bilingual', 'translated'], { descriptionKey: 'translationDisplayModeDescription', sectionKey: 'translationGlobal' }),
  setting('translation', 'translationDefaultTarget', ['翻译服务', 'DeepL', 'DeepLX', 'DLX', 'Microsoft', 'Google Cloud'], { descriptionKey: 'translationDefaultTargetDescription' }),
  setting('filters', 'addFilterRule', ['过滤', '屏蔽', '关键词', '正则', 'keyword', 'regex'], { descriptionKey: 'addFilterRuleDescription' }),
  setting('rsshub', 'rssHubEnable', ['RSSHub', '启用', 'enable'], { descriptionKey: 'rssHubEnableDescription' }),
  setting('rsshub', 'rssHubInstanceList', ['RSSHub', '实例', 'instance'], { descriptionKey: 'rssHubInstanceListDescription' }),
  setting('rsshub', 'rssHubAddInstance', ['RSSHub', '自建', '添加实例', 'add instance', 'self hosted']),
  setting('backup', 'backupIncludeSecrets', ['备份密钥', '备份密码', '加密', 'backup password', 'secrets', 'encryption'], { descriptionKey: 'backupIncludeSecretsDescription', sectionKey: 'backupScopeTitle' }),
  setting('backup', 'exportBackup', ['备份', '导出', 'export', 'backup'], { descriptionKey: 'exportBackupDescription', sectionKey: 'backupScopeTitle' }),
  setting('backup', 'restoreBackup', ['恢复', '导入', 'import', 'restore'], { descriptionKey: 'restoreBackupDescription', sectionKey: 'backupScopeTitle' }),
  setting('about', 'keyboardShortcuts', ['快捷键', 'keyboard', 'shortcuts'], { descriptionKey: 'keyboardShortcutsDescription', sectionKey: 'supportAndHelp' }),
  setting('about', 'userGuide', ['使用手册', '用户指南', '帮助', 'guide', 'manual'], { descriptionKey: 'userGuideDescription', sectionKey: 'supportAndHelp' }),
  setting('about', 'feedbackAndIssues', ['反馈', '错误', 'issue', 'bug'], { descriptionKey: 'feedbackAndIssuesDescription', sectionKey: 'supportAndHelp' }),
  setting('update', 'autoCheckUpdates', ['自动更新', '检查更新', 'automatic update'], { descriptionKey: 'autoCheckUpdatesDescription' }),
  setting('update', 'checkUpdatesNow', ['版本', '升级', '检查更新', 'version', 'update'])
]

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

/** Resolve labels for every search, using the active locale rather than a cached resource snapshot. */
export function searchSettings(query: string, translate: (key: string) => string): SettingsSearchResult[] {
  const needle = normalized(query)
  if (!needle) return []
  return SETTINGS_SEARCH_ITEMS.flatMap((item): SettingsSearchResult[] => {
    const title = translate(item.titleKey)
    const description = item.descriptionKey ? translate(item.descriptionKey) : ''
    const breadcrumbs = ['settings', SETTINGS_PAGE_LABELS[item.page], item.sectionKey]
      .filter((key, index, keys): key is string => Boolean(key) && key !== keys[index - 1])
      .map(translate)
    const label = normalized(title)
    const score = label === needle ? 100
      : label.startsWith(needle) ? 80
      : label.includes(needle) ? 60
      : item.keywords.some(keyword => normalized(keyword).includes(needle)) ? 45
      : normalized(description).includes(needle) ? 30
      : breadcrumbs.some(crumb => normalized(crumb).includes(needle)) ? 15 : 0
    return score > 0 ? [{ item, title, description, breadcrumb: breadcrumbs.join(' › '), score }] : []
  }).sort((a, b) => b.score - a.score || a.title.length - b.title.length)
}
