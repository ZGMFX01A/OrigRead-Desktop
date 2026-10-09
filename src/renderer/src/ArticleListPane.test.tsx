import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArticleRecord } from '../../shared/library'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ListTranslationControls', () => ({
  useListTranslation: () => ({ state: {}, controller: { stop() {} }, item: () => null }),
  ListTranslationButton: () => null,
  ListTranslationStatus: () => null
}))
import { ArticleListPane } from './ArticleListPane'

afterEach(() => vi.unstubAllGlobals())

describe('large article lists', () => {
  it('bounds mounted rows independently of the number of articles', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const articles: ArticleRecord[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `article-${index}`, accountId: 1, feedId: 'feed', title: `Title ${index}`,
      url: null, author: null, publishedAt: index, description: 'Preview',
      contentHtml: null, fullContentHtml: null, imageUrl: null,
      isUnread: true, isStarred: false, createdAt: index, updatedAt: index
    }))
    const noop = () => {}
    const html = renderToStaticMarkup(<ArticleListPane destination="all" articleScope={{ kind: 'all' }}
      activeScopeFeed={null} scopeLabel="All" scopeArticleCount={articles.length}
      scopeUnreadCount={articles.length} scopeStarredCount={0} articleQuery="" visibleArticles={articles}
      feeds={[]} selectedArticleId={null} articleListError={null} searchInputRef={{ current: null }}
      refreshing={false} refreshDisabled={false} onDestinationChange={noop} onClearScope={noop}
      onArticleQueryChange={noop} onRefresh={noop} onSelectArticle={noop} onToggleStarred={noop}
      onArticleContextMenu={noop} onAddSource={noop} />)
    const mounted = (html.match(/data-article-id=/g) ?? []).length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(40)
    expect(html).toContain('Title 0')
  })
})
