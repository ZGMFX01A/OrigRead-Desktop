export const DESKTOP_LANGUAGES = ['zh', 'en', 'es', 'pt-BR', 'de', 'fr', 'ja'] as const
export type DesktopLanguage = typeof DESKTOP_LANGUAGES[number]

export const DESKTOP_LANGUAGE_LABELS: Record<DesktopLanguage, string> = {
  zh: '简体中文', en: 'English', es: 'Español', 'pt-BR': 'Português (Brasil)',
  de: 'Deutsch', fr: 'Français', ja: '日本語'
}

export function isDesktopLanguage(value: unknown): value is DesktopLanguage {
  return DESKTOP_LANGUAGES.some(language => language === value)
}

export function resolveDesktopLanguage(locale: string): DesktopLanguage {
  const language = locale.trim().replace(/_/g, '-').toLowerCase().split('-')[0]
  // 葡语采用本项目提供的巴西葡语资源；未知语言保持英文回退。
  switch (language) {
    case 'zh': return 'zh'
    case 'es': return 'es'
    case 'pt': return 'pt-BR'
    case 'de': return 'de'
    case 'fr': return 'fr'
    case 'ja': return 'ja'
    default: return 'en'
  }
}

export function resolveBrandName(locale: string): '原读' | 'OrigRead' {
  return resolveDesktopLanguage(locale) === 'zh' ? '原读' : 'OrigRead'
}

