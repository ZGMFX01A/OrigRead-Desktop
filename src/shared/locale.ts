export type DesktopLanguage = 'zh' | 'en' | 'es' | 'pt-BR' | 'de' | 'fr' | 'ja'

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

