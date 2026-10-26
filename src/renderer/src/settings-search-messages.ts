const messages = {
  zh: { settingsSearchPlaceholder: '搜索设置项', settingsSearchEmpty: '未找到相关设置项', settingsSearchTryAnother: '试试其他名称或关键词', settingsSearchClear: '清空设置搜索', settingsSearchBack: '返回搜索结果', settingsSearchCount: '找到 {{count}} 项设置' },
  en: { settingsSearchPlaceholder: 'Search settings', settingsSearchEmpty: 'No matching settings found', settingsSearchTryAnother: 'Try another name or keyword', settingsSearchClear: 'Clear settings search', settingsSearchBack: 'Back to search results', settingsSearchCount: '{{count}} settings found' },
  es: { settingsSearchPlaceholder: 'Buscar en ajustes', settingsSearchEmpty: 'No se encontraron ajustes coincidentes', settingsSearchTryAnother: 'Prueba otro nombre o palabra clave', settingsSearchClear: 'Borrar búsqueda de ajustes', settingsSearchBack: 'Volver a los resultados', settingsSearchCount: '{{count}} ajustes encontrados' },
  'pt-BR': { settingsSearchPlaceholder: 'Pesquisar nas configurações', settingsSearchEmpty: 'Nenhuma configuração encontrada', settingsSearchTryAnother: 'Tente outro nome ou palavra-chave', settingsSearchClear: 'Limpar pesquisa de configurações', settingsSearchBack: 'Voltar aos resultados', settingsSearchCount: '{{count}} configurações encontradas' },
  de: { settingsSearchPlaceholder: 'Einstellungen durchsuchen', settingsSearchEmpty: 'Keine passenden Einstellungen gefunden', settingsSearchTryAnother: 'Anderen Namen oder Suchbegriff versuchen', settingsSearchClear: 'Einstellungssuche löschen', settingsSearchBack: 'Zurück zu den Suchergebnissen', settingsSearchCount: '{{count}} Einstellungen gefunden' },
  fr: { settingsSearchPlaceholder: 'Rechercher dans les paramètres', settingsSearchEmpty: 'Aucun paramètre correspondant trouvé', settingsSearchTryAnother: 'Essayez un autre nom ou mot-clé', settingsSearchClear: 'Effacer la recherche de paramètres', settingsSearchBack: 'Retour aux résultats', settingsSearchCount: '{{count}} paramètres trouvés' },
  ja: { settingsSearchPlaceholder: '設定を検索', settingsSearchEmpty: '一致する設定が見つかりません', settingsSearchTryAnother: '別の名前やキーワードで検索してください', settingsSearchClear: '設定の検索をクリア', settingsSearchBack: '検索結果に戻る', settingsSearchCount: '{{count}} 件の設定が見つかりました' }
}

export function withSettingsSearchMessages<T extends Record<string, { translation: object }>>(resources: T): T {
  return Object.fromEntries(Object.entries(resources).map(([language, value]) => [language, {
    ...value, translation: { ...value.translation, ...(messages[language as keyof typeof messages] ?? messages.en) }
  }])) as T
}
