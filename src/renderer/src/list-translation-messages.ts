const messages = {
  zh: { translateList: '翻译列表', stopTranslation: '停止翻译', listTranslationProgress: '正在翻译 {{completed}}/{{total}}', translationCacheSaveFailed: '译文未能保存到本机', listTranslationStopped: '已停止' },
  en: { translateList: 'Translate list', stopTranslation: 'Stop translation', listTranslationProgress: 'Translating {{completed}}/{{total}}', translationCacheSaveFailed: 'Could not save this translation locally', listTranslationStopped: 'Stopped' },
  es: { translateList: 'Traducir lista', stopTranslation: 'Detener traducción', listTranslationProgress: 'Traduciendo {{completed}}/{{total}}', translationCacheSaveFailed: 'No se pudo guardar la traducción en el dispositivo', listTranslationStopped: 'Detenido' },
  'pt-BR': { translateList: 'Traduzir lista', stopTranslation: 'Parar tradução', listTranslationProgress: 'Traduzindo {{completed}}/{{total}}', translationCacheSaveFailed: 'Não foi possível salvar a tradução neste dispositivo', listTranslationStopped: 'Parado' },
  de: { translateList: 'Liste übersetzen', stopTranslation: 'Übersetzung stoppen', listTranslationProgress: 'Übersetzung {{completed}}/{{total}}', translationCacheSaveFailed: 'Die Übersetzung konnte nicht lokal gespeichert werden', listTranslationStopped: 'Gestoppt' },
  fr: { translateList: 'Traduire la liste', stopTranslation: 'Arrêter la traduction', listTranslationProgress: 'Traduction {{completed}}/{{total}}', translationCacheSaveFailed: 'Impossible de conserver la traduction sur cet appareil', listTranslationStopped: 'Arrêté' },
  ja: { translateList: '一覧を翻訳', stopTranslation: '翻訳を停止', listTranslationProgress: '翻訳中 {{completed}}/{{total}}', translationCacheSaveFailed: '訳文を端末に保存できませんでした', listTranslationStopped: '停止しました' }
}
export function withListTranslationMessages<T extends Record<string, { translation: object }>>(resources: T): T {
  return Object.fromEntries(Object.entries(resources).map(([language, value]) => [language, {
    ...value, translation: { ...value.translation, ...(messages[language as keyof typeof messages] ?? messages.en) }
  }])) as T
}
