import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { shouldRejectArticleLink } from './article-link-heuristics'

describe('shouldRejectArticleLink', () => {
  it('rejects navigation routes and search queries', () => {
    assertRejected('作者编辑主页', 'https://news.example.com/author/editor-1001')
    assertRejected('Android 标签页', 'https://news.example.com/tag/android-1001')
    assertRejected('搜索相关内容', 'https://news.example.com/search?q=origread')
    assertRejected('用户注册入口', 'https://news.example.com/register')
    assertRejected('hide', 'https://news.example.com/hide?id=1001&goto=news')
    assertRejected('example.com', 'https://news.example.com/from?site=example.com')
    assertRejected('AI4Science', 'https://news.example.com/news/column?columnId=35')
    assertRejected('示例用户', 'https://news.example.com/u/1001')
  })

  it('keeps genuine article permalinks even when titles contain navigation words', () => {
    assertAccepted('搜索技术升级带来的新变化', 'https://news.example.com/article/1001')
    assertAccepted('分类算法如何改善新闻推荐', 'https://news.example.com/post?id=1002&category=tech')
    assertAccepted('真实文章标题', 'https://news.example.com/archives/1786073720538.html')
    assertAccepted('另一篇真实文章', 'https://news.example.com/archive/long-article-slug-1002')
  })

  it('rejects archive listing roots without rejecting archive article permalinks', () => {
    assertRejected('历史归档', 'https://news.example.com/archives/')
    assertRejected('更多历史文章', 'https://news.example.com/archives/page/2')
  })
})

function assertRejected(title: string, url: string): void {
  const $ = cheerio.load(`<a href="${url}">${title}</a>`)
  const element = $('a').get(0)!
  expect(shouldRejectArticleLink($, element, title, url)).toBe(true)
}

function assertAccepted(title: string, url: string): void {
  const $ = cheerio.load(`<a class="title" href="${url}">${title}</a>`)
  const element = $('a').get(0)!
  expect(shouldRejectArticleLink($, element, title, url)).toBe(false)
}

