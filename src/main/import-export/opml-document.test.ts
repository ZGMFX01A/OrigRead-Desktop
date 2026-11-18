import { describe, expect, it } from 'vitest'
import { parseOpml, DEFAULT_GROUP_KEY } from './opml-document'

describe('parseOpml', () => {
  it('throws on empty or non-OPML content', () => {
    expect(() => parseOpml('')).toThrow('OPML 文件为空')
    expect(() => parseOpml('   ')).toThrow('OPML 文件为空')
    expect(() => parseOpml('<rss><channel></channel></rss>')).toThrow('不是有效的 OPML 文件')
    expect(() => parseOpml('<opml><head></head></opml>')).toThrow('OPML 文件缺少 body')
  })

  it('parses nested outlines, preserving parent relations, names and XML entities', () => {
    const xml = `<opml version="2.0">
      <body>
        <outline text="Tech &amp; Science">
          <outline text="AI / ML">
            <outline title="Arxiv &amp; Papers" xmlUrl="https://example.com/feed?a=1&amp;b=2" />
          </outline>
        </outline>
      </body>
    </opml>`

    const parsed = parseOpml(xml)
    expect(parsed.groups).toHaveLength(3) // Default, Tech & Science, AI / ML

    const defGroup = parsed.groups.find((g) => g.isDefault)!
    expect(defGroup.key).toBe(DEFAULT_GROUP_KEY)

    const techGroup = parsed.groups.find((g) => g.name === 'Tech & Science')!
    expect(techGroup.parentKey).toBeNull()
    expect(techGroup.path).toEqual(['Tech & Science'])

    const aiGroup = parsed.groups.find((g) => g.name === 'AI / ML')!
    expect(aiGroup.parentKey).toBe(techGroup.key)
    expect(aiGroup.path).toEqual(['Tech & Science', 'AI / ML'])

    expect(parsed.feeds).toHaveLength(1)
    const feed = parsed.feeds[0]!
    expect(feed.name).toBe('Arxiv & Papers')
    expect(feed.url).toBe('https://example.com/feed?a=1&b=2')
    expect(feed.groupKey).toBe(aiGroup.key)
  })

  it('preserves single decoding of xml entities for URLs with & and literal &amp;', () => {
    const xml = `<opml version="2.0">
      <body>
        <outline text="Test" xmlUrl="https://example.com/feed?normal=1&amp;literal=fish&amp;amp;chips" />
      </body>
    </opml>`
    const parsed = parseOpml(xml)
    expect(parsed.feeds[0]!.url).toBe('https://example.com/feed?normal=1&literal=fish&amp;chips')
  })

  it('hoists children in anonymous container without generating fake groups', () => {
    const xml = `<opml version="2.0">
      <body>
        <outline text="Category">
          <outline>
            <outline text="Nested Feed" xmlUrl="https://example.com/nested.xml" />
            <outline text="Subcategory">
              <outline text="Deep Feed" xmlUrl="https://example.com/deep.xml" />
            </outline>
          </outline>
        </outline>
      </body>
    </opml>`

    const parsed = parseOpml(xml)
    // Groups should only be Default, Category, Subcategory
    expect(parsed.groups.map((g) => g.name)).toEqual(['Default', 'Category', 'Subcategory'])

    const category = parsed.groups.find((g) => g.name === 'Category')!
    const subcategory = parsed.groups.find((g) => g.name === 'Subcategory')!
    expect(subcategory.parentKey).toBe(category.key)

    const nestedFeed = parsed.feeds.find((f) => f.url === 'https://example.com/nested.xml')!
    expect(nestedFeed.groupKey).toBe(category.key)
  })

  it('merges multiple outlines of the same name at the same level', () => {
    const xml = `<opml version="2.0">
      <body>
        <outline text="Tech">
          <outline text="Feed 1" xmlUrl="https://example.com/1.xml" />
        </outline>
        <outline text="Tech">
          <outline text="Feed 2" xmlUrl="https://example.com/2.xml" />
        </outline>
      </body>
    </opml>`

    const parsed = parseOpml(xml)
    const techGroups = parsed.groups.filter((g) => g.name === 'Tech')
    expect(techGroups).toHaveLength(1)

    expect(parsed.feeds).toHaveLength(2)
    expect(parsed.feeds[0]!.groupKey).toBe(techGroups[0]!.key)
    expect(parsed.feeds[1]!.groupKey).toBe(techGroups[0]!.key)
  })

  it('handles feed outline with children as feed plus child structure', () => {
    const xml = `<opml version="2.0">
      <body>
        <outline text="Parent" xmlUrl="https://example.com/parent.xml">
          <outline text="Child" xmlUrl="https://example.com/child.xml" />
        </outline>
      </body>
    </opml>`

    const parsed = parseOpml(xml)
    expect(parsed.groups.map((g) => g.name)).toEqual(['Default'])
    expect(parsed.feeds).toHaveLength(2)
    expect(parsed.feeds[0]!.url).toBe('https://example.com/parent.xml')
    expect(parsed.feeds[0]!.groupKey).toBe(DEFAULT_GROUP_KEY)
    expect(parsed.feeds[1]!.url).toBe('https://example.com/child.xml')
    expect(parsed.feeds[1]!.groupKey).toBe(DEFAULT_GROUP_KEY)
  })

  it('throws when folder nesting exceeds depth 32', () => {
    let nested = '<outline text="End" xmlUrl="https://example.com/end.xml" />'
    for (let i = 33; i >= 1; i--) {
      nested = `<outline text="N${i}">${nested}</outline>`
    }
    const xml = `<opml version="2.0"><body>${nested}</body></opml>`

    expect(() => parseOpml(xml)).toThrow('分组层级深度超过最大限制')
  })
})
