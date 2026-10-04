// 来源修复和离线保存提示按应用当前语言提供，不借用其它语言的文案。
const messages = {
  zh: {
    fullContentCacheWriteFailed: '正文已加载，但未能保存离线缓存',
    jsonSourceRepairDescription: '重新探测页面并确认解析规则，保留现有文章、已读状态和收藏。',
    jsonSourcePageUrl: '页面或接口地址', jsonSourceReprobe: '重新探测', jsonSourceConfirmBinding: '确认替换规则',
    jsonSourceCandidateCount: '{{count}} 篇文章',
    ARTICLE_UNAVAILABLE: '文章或来源已不存在', CACHE_STORAGE: '离线正文缓存读取失败'
  },
  en: {
    fullContentCacheWriteFailed: 'Content loaded, but the offline cache could not be saved',
    jsonSourceRepairDescription: 'Detect the page again and confirm a parser while keeping existing articles, read status and stars.',
    jsonSourcePageUrl: 'Page or API URL', jsonSourceReprobe: 'Detect again', jsonSourceConfirmBinding: 'Confirm parser replacement',
    jsonSourceCandidateCount: '{{count}} articles',
    ARTICLE_UNAVAILABLE: 'The article or source no longer exists', CACHE_STORAGE: 'The offline content cache could not be read'
  },
  de: {
    fullContentCacheWriteFailed: 'Inhalt geladen, aber der Offline-Cache konnte nicht gespeichert werden',
    jsonSourceRepairDescription: 'Seite erneut erkennen und Parser bestätigen. Vorhandene Artikel, Lesestatus und Favoriten bleiben erhalten.',
    jsonSourcePageUrl: 'Seiten- oder API-Adresse', jsonSourceReprobe: 'Erneut erkennen', jsonSourceConfirmBinding: 'Parserwechsel bestätigen',
    jsonSourceCandidateCount: '{{count}} Artikel',
    ARTICLE_UNAVAILABLE: 'Der Artikel oder die Quelle existiert nicht mehr', CACHE_STORAGE: 'Der Offline-Inhaltscache konnte nicht gelesen werden'
  },
  fr: {
    fullContentCacheWriteFailed: 'Contenu chargé, mais le cache hors ligne n’a pas pu être enregistré',
    jsonSourceRepairDescription: 'Détectez à nouveau la page et confirmez un analyseur en conservant les articles, leur état de lecture et les favoris.',
    jsonSourcePageUrl: 'Adresse de la page ou de l’API', jsonSourceReprobe: 'Détecter à nouveau', jsonSourceConfirmBinding: 'Confirmer le nouvel analyseur',
    jsonSourceCandidateCount: '{{count}} articles',
    ARTICLE_UNAVAILABLE: 'L’article ou la source n’existe plus', CACHE_STORAGE: 'Impossible de lire le cache du contenu hors ligne'
  },
  es: {
    fullContentCacheWriteFailed: 'Contenido cargado, pero no se pudo guardar la caché sin conexión',
    jsonSourceRepairDescription: 'Detecta la página de nuevo y confirma un analizador conservando los artículos, su estado de lectura y los favoritos.',
    jsonSourcePageUrl: 'Dirección de la página o API', jsonSourceReprobe: 'Detectar de nuevo', jsonSourceConfirmBinding: 'Confirmar el nuevo analizador',
    jsonSourceCandidateCount: '{{count}} artículos',
    ARTICLE_UNAVAILABLE: 'El artículo o la fuente ya no existe', CACHE_STORAGE: 'No se pudo leer la caché del contenido sin conexión'
  },
  'pt-BR': {
    fullContentCacheWriteFailed: 'Conteúdo carregado, mas não foi possível salvar o cache offline',
    jsonSourceRepairDescription: 'Detecte a página novamente e confirme um analisador mantendo os artigos, o estado de leitura e os favoritos.',
    jsonSourcePageUrl: 'Endereço da página ou API', jsonSourceReprobe: 'Detectar novamente', jsonSourceConfirmBinding: 'Confirmar o novo analisador',
    jsonSourceCandidateCount: '{{count}} artigos',
    ARTICLE_UNAVAILABLE: 'O artigo ou a fonte não existe mais', CACHE_STORAGE: 'Não foi possível ler o cache de conteúdo offline'
  },
  ja: {
    fullContentCacheWriteFailed: '本文を読み込みましたが、オフラインキャッシュを保存できませんでした',
    jsonSourceRepairDescription: 'ページを再検出して解析ルールを確認します。既存の記事、既読状態、お気に入りは保持されます。',
    jsonSourcePageUrl: 'ページまたは API のアドレス', jsonSourceReprobe: '再検出', jsonSourceConfirmBinding: '解析ルールの変更を確定',
    jsonSourceCandidateCount: '{{count}} 件の記事',
    ARTICLE_UNAVAILABLE: '記事またはソースが存在しません', CACHE_STORAGE: 'オフライン本文キャッシュを読み込めませんでした'
  }
} as const

interface Resource {
  readonly [namespace: string]: Readonly<Record<string, unknown>>
  readonly translation: Readonly<Record<string, unknown>>
}

/** 新提示合并到各语言资源，保留现有文案并返回新对象。 */
export function withSourceRepairMessages(resources: Readonly<Record<string, Resource>>): Record<string, Resource> {
  return Object.fromEntries(Object.entries(resources).map(([language, resource]) => {
    const localized = messages[language as keyof typeof messages]
    if (!localized) throw new Error(`缺少来源修复语言资源：${language}`)
    const { ARTICLE_UNAVAILABLE, CACHE_STORAGE, ...labels } = localized
    return [language, { translation: { ...resource.translation, ...labels,
      fullContentFailure: { ...(resource.translation.fullContentFailure as Record<string, string>), ARTICLE_UNAVAILABLE, CACHE_STORAGE } } }]
  }))
}
