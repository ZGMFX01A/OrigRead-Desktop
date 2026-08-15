export interface FeedCatalogSource {
  id: string
  name: string
  url: string
  license: string | null
}

export interface FeedCatalogOrigin {
  sourceId: string
  category: string
}

export interface FeedCatalogEntry {
  id: string
  name: string
  feedUrl: string
  siteUrl: string | null
  categories: string[]
  origins: FeedCatalogOrigin[]
}

export interface FeedCatalogData {
  schemaVersion: number
  generatedAt: string | null
  feedCount: number
  categories: string[]
  sources: FeedCatalogSource[]
  feeds: FeedCatalogEntry[]
}

export interface FeedCatalogSnapshot extends FeedCatalogData {
  categoryCounts: Record<string, number>
}

interface CategoryLabel {
  zh: string
  zhHant: string
}

// 与 Android SourceCategoryLabels 保持同一组上游分类映射。
const CATEGORY_LABELS: Record<string, CategoryLabel> = {
  AI:{zh:'人工智能',zhHant:'人工智慧'}, Android:{zh:'安卓',zhHant:'Android'},
  'Android Development':{zh:'Android 开发',zhHant:'Android 開發'}, 'Animal & Wildlife':{zh:'动物与野生生物',zhHant:'動物與野生動物'},
  Apple:{zh:'Apple 生态',zhHant:'Apple 生態'}, Architecture:{zh:'建筑',zhHant:'建築'}, Articles:{zh:'文章',zhHant:'文章'},
  Beauty:{zh:'美妆',zhHant:'美妝'}, Books:{zh:'图书',zhHant:'書籍'}, 'Business & Economy':{zh:'商业与经济',zhHant:'商業與經濟'},
  Cars:{zh:'汽车',zhHant:'汽車'}, Chess:{zh:'国际象棋',zhHant:'西洋棋'}, Cricket:{zh:'板球',zhHant:'板球'},
  Cryptocurrency:{zh:'加密货币',zhHant:'加密貨幣'}, 'Cyber security':{zh:'网络安全',zhHant:'網路安全'}, DIY:{zh:'DIY 手作',zhHant:'DIY 手作'},
  Environment:{zh:'环境',zhHant:'環境'}, Fashion:{zh:'时尚',zhHant:'時尚'}, Food:{zh:'美食',zhHant:'美食'}, Football:{zh:'足球',zhHant:'足球'},
  Funny:{zh:'搞笑',zhHant:'搞笑'}, Gaming:{zh:'游戏',zhHant:'遊戲'}, History:{zh:'历史',zhHant:'歷史'}, 'Interior design':{zh:'室内设计',zhHant:'室內設計'},
  'iOS Development':{zh:'iOS 开发',zhHant:'iOS 開發'}, Memes:{zh:'梗图',zhHant:'迷因'}, Movies:{zh:'电影',zhHant:'電影'}, Music:{zh:'音乐',zhHant:'音樂'},
  Nature:{zh:'自然',zhHant:'自然'}, News:{zh:'新闻',zhHant:'新聞'}, 'Personal finance':{zh:'个人理财',zhHant:'個人理財'}, Photography:{zh:'摄影',zhHant:'攝影'},
  Product:{zh:'产品',zhHant:'產品'}, Programming:{zh:'编程',zhHant:'程式設計'}, Science:{zh:'科学',zhHant:'科學'}, Space:{zh:'太空',zhHant:'太空'},
  Sports:{zh:'体育',zhHant:'體育'}, Startups:{zh:'创业',zhHant:'創業'}, Tech:{zh:'科技',zhHant:'科技'}, Television:{zh:'电视',zhHant:'電視'},
  Tennis:{zh:'网球',zhHant:'網球'}, Travel:{zh:'旅行',zhHant:'旅行'}, 'UI - UX':{zh:'UI / UX',zhHant:'UI / UX'}, 'Web Development':{zh:'Web 开发',zhHant:'Web 開發'}
}

export function localizedSourceCategory(category: string, locale: string): string {
  const label = CATEGORY_LABELS[category]
  if (!label) return category
  const normalized = locale.toLowerCase()
  if (normalized.startsWith('zh-hant') || normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo')) return label.zhHant
  if (normalized.startsWith('zh')) return label.zh
  return category
}

export function secondarySourceCategory(category: string, locale: string): string | null {
  const localized = localizedSourceCategory(category, locale)
  return locale.toLowerCase().startsWith('zh') && localized !== category ? category : null
}

export function sourceCategorySearchTerms(category: string): string[] {
  const label = CATEGORY_LABELS[category]
  return label ? [...new Set([category, label.zh, label.zhHant])] : [category]
}
