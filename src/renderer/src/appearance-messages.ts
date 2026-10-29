const messages = {
  "zh": {
    "uiFontScale": "界面字号",
    "uiFontScaleDescription": "调整来源列表、文章列表和应用控件的文字大小。文章正文使用独立字号。",
    "uiFontScale100": "100%（标准）",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "显示文章缩略图",
    "showArticleThumbnailsDescription": "在文章列表中显示可用的图片。没有图片的文章保持文字布局。"
  },
  "en": {
    "uiFontScale": "UI text size",
    "uiFontScaleDescription": "Adjusts text in source lists, article lists, and app controls. Article text uses its own font size.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Show article thumbnails",
    "showArticleThumbnailsDescription": "Shows available images in the article list. Articles without an image keep the text layout."
  },
  "es": {
    "uiFontScale": "Tamaño del texto de la interfaz",
    "uiFontScaleDescription": "Ajusta el texto de las listas de fuentes y artículos y de los controles de la aplicación. El texto del artículo usa su propio tamaño.",
    "uiFontScale100": "100% (Estándar)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Mostrar miniaturas de artículos",
    "showArticleThumbnailsDescription": "Muestra las imágenes disponibles en la lista de artículos. Los artículos sin imagen conservan el diseño de texto."
  },
  "pt-BR": {
    "uiFontScale": "Tamanho do texto da interface",
    "uiFontScaleDescription": "Ajusta o texto das listas de fontes e artigos e dos controles do aplicativo. O texto do artigo tem seu próprio tamanho.",
    "uiFontScale100": "100% (Padrão)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Mostrar miniaturas dos artigos",
    "showArticleThumbnailsDescription": "Mostra as imagens disponíveis na lista de artigos. Artigos sem imagem mantêm o layout de texto."
  },
  "de": {
    "uiFontScale": "Textgröße der Oberfläche",
    "uiFontScaleDescription": "Passt den Text in Quellen- und Artikellisten sowie in Bedienelementen an. Für Artikeltexte gilt eine eigene Schriftgröße.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Artikelvorschaubilder anzeigen",
    "showArticleThumbnailsDescription": "Zeigt verfügbare Bilder in der Artikelliste. Artikel ohne Bild behalten das Textlayout."
  },
  "fr": {
    "uiFontScale": "Taille du texte de l’interface",
    "uiFontScaleDescription": "Ajuste le texte des listes de sources et d’articles ainsi que des commandes de l’application. Le texte des articles conserve sa propre taille.",
    "uiFontScale100": "100% (Standard)",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "Afficher les miniatures des articles",
    "showArticleThumbnailsDescription": "Affiche les images disponibles dans la liste des articles. Les articles sans image conservent la présentation textuelle."
  },
  "ja": {
    "uiFontScale": "画面の文字サイズ",
    "uiFontScaleDescription": "ソース一覧、記事一覧、アプリの操作項目の文字サイズを調整します。記事本文の文字サイズは個別に設定します。",
    "uiFontScale100": "100%（標準）",
    "uiFontScale110": "110%",
    "uiFontScale125": "125%",
    "uiFontScale150": "150%",
    "showArticleThumbnails": "記事のサムネイルを表示",
    "showArticleThumbnailsDescription": "記事一覧に利用可能な画像を表示します。画像のない記事は文字のみで表示します。"
  }
}

export function withAppearanceMessages<T extends Record<string, { translation: object }>>(resources: T): T {
  return Object.fromEntries(Object.entries(resources).map(([language, value]) => [language, {
    ...value, translation: { ...value.translation, ...(messages[language as keyof typeof messages] ?? messages.en) }
  }])) as T
}
