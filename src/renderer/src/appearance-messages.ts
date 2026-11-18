import type { DesktopLanguage } from '../../shared/locale'

const messages = {
  "zh": {
    "uiFontScale": "界面字号",
    "uiFontScaleDescription": "调整来源列表、文章列表和应用控件的文字大小。文章正文使用独立字号。",
    "uiFontScale100": "100%（标准）",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "显示文章缩略图",
    "showArticleThumbnailsDescription": "在文章列表中显示可用的图片。没有图片的文章保持文字布局。",
    "showArticleSummaries": "显示文章摘要",
    "showArticleSummariesDescription": "在文章列表中显示正文摘要和译文摘要。关闭后仅保留标题和元信息。",
    "readerIndentParagraphs": "段落首行缩进",
    "readerIndentParagraphsDescription": "阅读模式下的普通段落缩进两字符。代码、引用、列表和表格保持原样。",
    "articleLoadedCount": "显示{{visible}}篇，共{{total}}篇"
  },
  "en": {
    "uiFontScale": "UI text size",
    "uiFontScaleDescription": "Adjusts text in source lists, article lists, and app controls. Article text uses its own font size.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Show article thumbnails",
    "showArticleThumbnailsDescription": "Shows available images in the article list. Articles without an image keep the text layout.",
    "showArticleSummaries": "Show article summaries",
    "showArticleSummariesDescription": "Shows article and translation summaries in the article list. When turned off, only titles and metadata are kept.",
    "readerIndentParagraphs": "Indent paragraphs",
    "readerIndentParagraphsDescription": "Indent the first line of regular paragraphs by 2em in reader view. Media, code blocks, lists, quotes, and tables remain unchanged.",
    "articleLoadedCount": "Showing {{visible}} of {{total}} articles"
  },
  "es": {
    "uiFontScale": "Tamaño del texto de la interfaz",
    "uiFontScaleDescription": "Ajusta el texto de las listas de fuentes y artículos y de los controles de la aplicación. El texto del artículo usa su propio tamaño.",
    "uiFontScale100": "100% (Estándar)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Mostrar miniaturas de artículos",
    "showArticleThumbnailsDescription": "Muestra las imágenes disponibles en la lista de artículos. Los artículos sin imagen conservan el diseño de texto.",
    "showArticleSummaries": "Mostrar resúmenes de artículos",
    "showArticleSummariesDescription": "Muestra los resúmenes de artículos y traducciones en la lista de artículos. Si se desactiva, solo se conservan los títulos y los metadatos.",
    "readerIndentParagraphs": "Sangría de párrafos",
    "readerIndentParagraphsDescription": "Aplica una sangría de 2em a la primera línea de los párrafos en modo lectura. Medios, código, listas, citas y tablas no cambian.",
    "articleLoadedCount": "Mostrando {{visible}} de {{total}} artículos"
  },
  "pt-BR": {
    "uiFontScale": "Tamanho do texto da interface",
    "uiFontScaleDescription": "Ajusta o texto das listas de fontes e artigos e dos controles do aplicativo. O texto do artigo tem seu próprio tamanho.",
    "uiFontScale100": "100% (Padrão)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Mostrar miniaturas dos artigos",
    "showArticleThumbnailsDescription": "Mostra as imagens disponíveis na lista de artigos. Artigos sem imagem mantêm o layout de texto.",
    "showArticleSummaries": "Mostrar resumos dos artigos",
    "showArticleSummariesDescription": "Mostra resumos dos artigos e traduções na lista de artigos. Quando desativado, apenas títulos e metadados são mantidos.",
    "readerIndentParagraphs": "Recuo de parágrafos",
    "readerIndentParagraphsDescription": "Recua a primeira linha dos parágrafos comuns em 2em na leitura. Mídias, blocos de código, listas, citações e tabelas permanecem inalterados.",
    "articleLoadedCount": "Mostrando {{visible}} de {{total}} artigos"
  },
  "de": {
    "uiFontScale": "Textgröße der Oberfläche",
    "uiFontScaleDescription": "Passt den Text in Quellen- und Artikellisten sowie in Bedienelementen an. Für Artikeltexte gilt eine eigene Schriftgröße.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Artikelvorschaubilder anzeigen",
    "showArticleThumbnailsDescription": "Zeigt verfügbare Bilder in der Artikelliste. Artikel ohne Bild behalten das Textlayout.",
    "showArticleSummaries": "Artikelzusammenfassungen anzeigen",
    "showArticleSummariesDescription": "Zeigt Artikel- und Übersetzungsvorschauen in der Artikelliste. Wenn deaktiviert, bleiben nur Titel und Metadaten erhalten.",
    "readerIndentParagraphs": "Absatzeinzug",
    "readerIndentParagraphsDescription": "Rückt die erste Zeile normaler Absätze im Lesemodus um 2em ein. Medien, Codeblöcke, Listen, Zitate und Tabellen bleiben unverändert.",
    "articleLoadedCount": "{{visible}} von {{total}} Artikeln angezeigt"
  },
  "fr": {
    "uiFontScale": "Taille du texte de l’interface",
    "uiFontScaleDescription": "Ajuste le texte des listes de sources et d’articles ainsi que des commandes de l’application. Le texte des articles conserve sa propre taille.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Afficher les miniatures des articles",
    "showArticleThumbnailsDescription": "Affiche les images disponibles dans la liste des articles. Les articles sans image conservent la présentation textuelle.",
    "showArticleSummaries": "Afficher les résumés des articles",
    "showArticleSummariesDescription": "Affiche les résumés d’articles et de traduction dans la liste des articles. Lorsqu’elle est désactivée, seuls les titres et métadonnées sont conservés.",
    "readerIndentParagraphs": "Retrait des paragraphes",
    "readerIndentParagraphsDescription": "Aligne la première ligne des paragraphes réguliers avec un retrait de 2em en mode lecture. Les médias, le code, les listes, les citations et les tableaux restent inchangés.",
    "articleLoadedCount": "{{visible}} sur {{total}} articles affichés"
  },
  "ja": {
    "uiFontScale": "画面の文字サイズ",
    "uiFontScaleDescription": "ソース一覧、記事一覧、アプリの操作項目の文字サイズを調整します。記事本文の文字サイズは個別に設定します。",
    "uiFontScale100": "100%（標準）",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "記事のサムネイルを表示",
    "showArticleThumbnailsDescription": "記事一覧に利用可能な画像を表示します。画像のない記事は文字のみで表示します。",
    "showArticleSummaries": "記事の要約を表示",
    "showArticleSummariesDescription": "記事一覧に本文と翻訳の要約を表示します。無効にするとタイトルとメタ情報のみを表示します。",
    "readerIndentParagraphs": "段落の字下げ",
    "readerIndentParagraphsDescription": "リーダー表示で通常段落の先頭行を2em字下げします。メディア、コードブロック、リスト、引用、表はそのまま維持します。",
    "articleLoadedCount": "{{total}} 件中 {{visible}} 件を表示"
  }
} as const

// Every supported locale must explicitly provide every key, rather than rely on English fallback.
const localizedMessages: Record<DesktopLanguage, Record<keyof typeof messages.en, string>> = messages

export function withAppearanceMessages<T extends Record<string, { translation: object }>>(resources: T): T {
  return Object.fromEntries(Object.entries(resources).map(([language, value]) => [language, {
    ...value,
    translation: {
      ...value.translation,
      ...localizedMessages.en,
      ...(localizedMessages[language as DesktopLanguage] ?? {})
    }
  }])) as T
}
