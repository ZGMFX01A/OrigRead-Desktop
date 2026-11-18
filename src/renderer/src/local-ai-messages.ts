import type { DesktopLanguage } from '../../shared/locale'

const messages = {
  "zh": {
    "addLocalAiProvider": "添加本地 AI 服务",
    "addLocalAiProviderOllama": "添加 Ollama 本地服务",
    "addLocalAiProviderLmStudio": "添加 LM Studio 本地服务",
    "aiModelPlaceholder": "选择或输入模型名称",
    "localAiPresetNotice": "已按本地端点预设创建，需确保本地服务正在运行，并手动输入或加载可用模型。",
    "localAiCreateFailed": "创建本地 AI 服务失败",
    "translationAiNoticeTitle": "关于翻译服务与 AI 模型",
    "translationAiNoticeDescription": "Microsoft 与 Google 翻译为官方 API 服务，需在下方配置密钥；Android ML Kit 本地翻译在桌面端不可用。若要使用本地模型（如 Ollama、LM Studio）或云端 AI 进行翻译，请前往“AI 设置”配置服务与模型，并在阅读视图工具栏中选择 AI 翻译目标。",
    "translationGoToAiSettings": "前往 AI 设置"
  },
  "en": {
    "addLocalAiProvider": "Add local AI service",
    "addLocalAiProviderOllama": "Add Ollama local service",
    "addLocalAiProviderLmStudio": "Add LM Studio local service",
    "aiModelPlaceholder": "Select or enter model name",
    "localAiPresetNotice": "Created with local endpoint preset. Ensure your local service is running, and enter or load available models.",
    "localAiCreateFailed": "Failed to create local AI service",
    "translationAiNoticeTitle": "About Translation Services & AI Models",
    "translationAiNoticeDescription": "Microsoft and Google Translation use official API keys configured below; Android ML Kit offline translation is not available on desktop. To use local models (such as Ollama or LM Studio) or cloud AI for translation, configure them in AI Settings and choose an AI translation target in the reader view toolbar.",
    "translationGoToAiSettings": "Go to AI Settings"
  },
  "es": {
    "addLocalAiProvider": "Añadir servicio de IA local",
    "addLocalAiProviderOllama": "Añadir servicio local de Ollama",
    "addLocalAiProviderLmStudio": "Añadir servicio local de LM Studio",
    "aiModelPlaceholder": "Selecciona o introduce el nombre del modelo",
    "localAiPresetNotice": "Se ha creado el servicio con una dirección local predefinida. Asegúrate de que esté en ejecución e introduce o carga un modelo disponible.",
    "localAiCreateFailed": "No se pudo crear el servicio de IA local",
    "translationAiNoticeTitle": "Acerca de los servicios de traducción y los modelos de IA",
    "translationAiNoticeDescription": "Microsoft y Google Translation utilizan API oficiales y requieren las claves que se configuran a continuación. La traducción local con Android ML Kit no está disponible en escritorio. Para traducir con modelos locales (como Ollama o LM Studio) o IA en la nube, configura el servicio y el modelo en «Ajustes de IA» y selecciona un destino de traducción de IA en la barra del lector.",
    "translationGoToAiSettings": "Ir a los ajustes de IA"
  },
  "pt-BR": {
    "addLocalAiProvider": "Adicionar serviço de IA local",
    "addLocalAiProviderOllama": "Adicionar serviço local do Ollama",
    "addLocalAiProviderLmStudio": "Adicionar serviço local do LM Studio",
    "aiModelPlaceholder": "Selecione ou digite o nome do modelo",
    "localAiPresetNotice": "O serviço foi criado com um endereço local predefinido. Verifique se ele está em execução e digite ou carregue um modelo disponível.",
    "localAiCreateFailed": "Não foi possível criar o serviço de IA local",
    "translationAiNoticeTitle": "Sobre serviços de tradução e modelos de IA",
    "translationAiNoticeDescription": "O Microsoft Translator e o Google Translation usam APIs oficiais e exigem as chaves configuradas abaixo. A tradução local do Android ML Kit não está disponível no desktop. Para traduzir com modelos locais (como Ollama ou LM Studio) ou IA na nuvem, configure o serviço e o modelo em «Configurações de IA» e selecione um destino de tradução por IA na barra do leitor.",
    "translationGoToAiSettings": "Ir para as configurações de IA"
  },
  "de": {
    "addLocalAiProvider": "Lokalen KI-Dienst hinzufügen",
    "addLocalAiProviderOllama": "Lokalen Ollama-Dienst hinzufügen",
    "addLocalAiProviderLmStudio": "Lokalen LM-Studio-Dienst hinzufügen",
    "aiModelPlaceholder": "Modellnamen auswählen oder eingeben",
    "localAiPresetNotice": "Der Dienst wurde mit einer lokalen Standardadresse erstellt. Stelle sicher, dass er ausgeführt wird, und gib ein verfügbares Modell ein oder lade die Modellliste.",
    "localAiCreateFailed": "Der lokale KI-Dienst konnte nicht erstellt werden",
    "translationAiNoticeTitle": "Über Übersetzungsdienste und KI-Modelle",
    "translationAiNoticeDescription": "Microsoft und Google Translation verwenden offizielle APIs. Die zugehörigen Schlüssel werden unten konfiguriert. Die lokale Übersetzung mit Android ML Kit ist auf dem Desktop nicht verfügbar. Um mit lokalen Modellen (etwa Ollama oder LM Studio) oder Cloud-KI zu übersetzen, konfiguriere Dienst und Modell in den KI-Einstellungen und wähle in der Leser-Symbolleiste ein KI-Übersetzungsziel.",
    "translationGoToAiSettings": "Zu den KI-Einstellungen"
  },
  "fr": {
    "addLocalAiProvider": "Ajouter un service d’IA local",
    "addLocalAiProviderOllama": "Ajouter un service local Ollama",
    "addLocalAiProviderLmStudio": "Ajouter un service local LM Studio",
    "aiModelPlaceholder": "Sélectionnez ou saisissez le nom du modèle",
    "localAiPresetNotice": "Le service a été créé avec une adresse locale prédéfinie. Assurez-vous qu’il est en cours d’exécution, puis saisissez un modèle disponible ou chargez la liste des modèles.",
    "localAiCreateFailed": "Impossible de créer le service d’IA local",
    "translationAiNoticeTitle": "À propos des services de traduction et des modèles d’IA",
    "translationAiNoticeDescription": "Microsoft et Google Translation utilisent des API officielles dont les clés se configurent ci-dessous. La traduction locale Android ML Kit n’est pas disponible sur ordinateur. Pour traduire avec des modèles locaux (comme Ollama ou LM Studio) ou une IA dans le cloud, configurez le service et le modèle dans les paramètres de l’IA, puis sélectionnez une cible de traduction par IA dans la barre du lecteur.",
    "translationGoToAiSettings": "Ouvrir les paramètres de l’IA"
  },
  "ja": {
    "addLocalAiProvider": "ローカルAIサービスを追加",
    "addLocalAiProviderOllama": "Ollamaのローカルサービスを追加",
    "addLocalAiProviderLmStudio": "LM Studioのローカルサービスを追加",
    "aiModelPlaceholder": "モデル名を選択または入力",
    "localAiPresetNotice": "ローカルの接続先設定でサービスを作成しました。サービスを起動し、利用可能なモデルを入力するか、モデル一覧を読み込んでください。",
    "localAiCreateFailed": "ローカルAIサービスを作成できませんでした",
    "translationAiNoticeTitle": "翻訳サービスとAIモデルについて",
    "translationAiNoticeDescription": "MicrosoftとGoogleの翻訳は公式APIを使用するため、以下でAPIキーを設定してください。Android ML Kitのローカル翻訳はデスクトップでは利用できません。OllamaやLM Studioなどのローカルモデル、またはクラウドAIで翻訳する場合は、「AI設定」でサービスとモデルを設定し、リーダーのツールバーでAI翻訳先を選択してください。",
    "translationGoToAiSettings": "AI設定を開く"
  }
} as const

// Every supported locale must explicitly provide every key, rather than rely on English fallback.
const localizedMessages: Record<DesktopLanguage, Record<keyof typeof messages.en, string>> = messages

export function withLocalAiMessages<T extends Record<string, { translation: object }>>(resources: T): T {
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
