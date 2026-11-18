import type { DesktopLanguage } from '../../shared/locale'

const messages = {
  "zh": {
    "recentArticles": "最近阅读",
    "clearReadingHistory": "清除阅读历史",
    "clearReadingHistoryConfirm": "确定要清除当前账户的所有阅读历史吗？此操作无法撤销。",
    "clearReadingHistorySuccess": "已清除阅读历史",
    "clearReadingHistoryFailed": "清除阅读历史失败",
    "noRecentArticles": "暂无最近阅读记录",
    "noRecentArticlesDescription": "在列表中打开并阅读文章后，记录将显示在这里。",
    "recordHistoryFailed": "记录阅读历史失败",
    "loadReadingHistoryFailed": "加载阅读历史失败"
  },
  "en": {
    "recentArticles": "Recent",
    "clearReadingHistory": "Clear reading history",
    "clearReadingHistoryConfirm": "Are you sure you want to clear all reading history for the current account? This action cannot be undone.",
    "clearReadingHistorySuccess": "Reading history cleared",
    "clearReadingHistoryFailed": "Failed to clear reading history",
    "noRecentArticles": "No recently read articles",
    "noRecentArticlesDescription": "Articles will appear here after you open and read them.",
    "recordHistoryFailed": "Failed to record reading history",
    "loadReadingHistoryFailed": "Failed to load reading history"
  },
  "es": {
    "recentArticles": "Recientes",
    "clearReadingHistory": "Borrar historial de lectura",
    "clearReadingHistoryConfirm": "¿Quieres borrar todo el historial de lectura de la cuenta actual? Esta acción no se puede deshacer.",
    "clearReadingHistorySuccess": "Historial de lectura borrado",
    "clearReadingHistoryFailed": "No se pudo borrar el historial de lectura",
    "noRecentArticles": "No hay lecturas recientes",
    "noRecentArticlesDescription": "Los artículos aparecerán aquí cuando los abras y los leas desde la lista.",
    "recordHistoryFailed": "No se pudo registrar la lectura",
    "loadReadingHistoryFailed": "No se pudo cargar el historial de lectura"
  },
  "pt-BR": {
    "recentArticles": "Recentes",
    "clearReadingHistory": "Limpar histórico de leitura",
    "clearReadingHistoryConfirm": "Deseja limpar todo o histórico de leitura da conta atual? Esta ação não pode ser desfeita.",
    "clearReadingHistorySuccess": "Histórico de leitura limpo",
    "clearReadingHistoryFailed": "Não foi possível limpar o histórico de leitura",
    "noRecentArticles": "Nenhuma leitura recente",
    "noRecentArticlesDescription": "Os artigos aparecerão aqui depois que você os abrir e ler na lista.",
    "recordHistoryFailed": "Não foi possível registrar a leitura",
    "loadReadingHistoryFailed": "Não foi possível carregar o histórico de leitura"
  },
  "de": {
    "recentArticles": "Zuletzt gelesen",
    "clearReadingHistory": "Leseverlauf löschen",
    "clearReadingHistoryConfirm": "Möchtest du den gesamten Leseverlauf des aktuellen Kontos löschen? Dies kann nicht rückgängig gemacht werden.",
    "clearReadingHistorySuccess": "Leseverlauf gelöscht",
    "clearReadingHistoryFailed": "Der Leseverlauf konnte nicht gelöscht werden",
    "noRecentArticles": "Noch keine kürzlich gelesenen Artikel",
    "noRecentArticlesDescription": "Artikel erscheinen hier, nachdem du sie in der Liste geöffnet und gelesen hast.",
    "recordHistoryFailed": "Der Lesevorgang konnte nicht gespeichert werden",
    "loadReadingHistoryFailed": "Der Leseverlauf konnte nicht geladen werden"
  },
  "fr": {
    "recentArticles": "Récents",
    "clearReadingHistory": "Effacer l’historique de lecture",
    "clearReadingHistoryConfirm": "Voulez-vous effacer tout l’historique de lecture du compte actuel ? Cette action est irréversible.",
    "clearReadingHistorySuccess": "Historique de lecture effacé",
    "clearReadingHistoryFailed": "Impossible d’effacer l’historique de lecture",
    "noRecentArticles": "Aucune lecture récente",
    "noRecentArticlesDescription": "Les articles apparaîtront ici après avoir été ouverts et lus depuis la liste.",
    "recordHistoryFailed": "Impossible d’enregistrer la lecture",
    "loadReadingHistoryFailed": "Impossible de charger l’historique de lecture"
  },
  "ja": {
    "recentArticles": "最近読んだ記事",
    "clearReadingHistory": "閲覧履歴を消去",
    "clearReadingHistoryConfirm": "現在のアカウントの閲覧履歴をすべて消去しますか？この操作は元に戻せません。",
    "clearReadingHistorySuccess": "閲覧履歴を消去しました",
    "clearReadingHistoryFailed": "閲覧履歴を消去できませんでした",
    "noRecentArticles": "最近読んだ記事はありません",
    "noRecentArticlesDescription": "一覧から記事を開いて読むと、ここに表示されます。",
    "recordHistoryFailed": "閲覧履歴を記録できませんでした",
    "loadReadingHistoryFailed": "閲覧履歴を読み込めませんでした"
  }
} as const

// Every supported locale must explicitly provide every key, rather than rely on English fallback.
const localizedMessages: Record<DesktopLanguage, Record<keyof typeof messages.en, string>> = messages

export function withHistoryMessages<T extends Record<string, { translation: object }>>(resources: T): T {
  return Object.fromEntries(
    Object.entries(resources).map(([language, value]) => [
      language,
      {
        ...value,
        translation: {
          ...value.translation,
          ...localizedMessages.en,
          ...(localizedMessages[language as DesktopLanguage] ?? {})
        }
      }
    ])
  ) as T
}
