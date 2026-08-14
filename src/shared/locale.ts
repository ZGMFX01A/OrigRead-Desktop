export type DesktopLanguage = 'zh' | 'en'

export function resolveDesktopLanguage(locale: string): DesktopLanguage {
  return locale.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function resolveBrandName(locale: string): '原读' | 'OrigRead' {
  return resolveDesktopLanguage(locale) === 'zh' ? '原读' : 'OrigRead'
}

