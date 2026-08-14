import type * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { classNames } from './website-dom'

const BLOCKED_ROUTE_SEGMENTS = new Set([
  'login', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'account', 'accounts',
  'profile', 'profiles', 'user', 'users', 'author', 'authors', 'tag', 'tags', 'category',
  'categories', 'topic', 'topics', 'search', 'query', 'help', 'faq', 'about', 'contact',
  'privacy', 'terms', 'policy', 'sitemap', 'subscribe', 'membership', 'settings', 'hide',
  'from', 'u', 'column', 'columns'
])
const BLOCKED_QUERY_KEYS = new Set(['s', 'q', 'query', 'search', 'keyword', 'tag', 'category', 'author', 'user', 'username', 'page', 'paged'])
const ARTICLE_ID_QUERY_KEYS = new Set(['id', 'aid', 'articleid', 'article_id', 'newsid', 'news_id', 'post', 'postid', 'post_id', 'contentid', 'content_id'])
const BLOCKED_ELEMENT_TOKENS = new Set(['author', 'category', 'tag', 'topic', 'login', 'signin', 'signup', 'register', 'search', 'help', 'more-link', 'read-more-category'])
const BLOCKED_EXACT_TITLES = new Set([
  'login', 'sign in', 'sign up', 'register', 'my account', 'profile', 'search', 'help', 'faq',
  'about', 'about us', 'contact', 'contact us', 'privacy', 'privacy policy', 'terms',
  'terms of service', 'subscribe', 'more', 'hide', 'flag', 'favorite', 'unfavorite', 'reply',
  '登录', '登陆', '注册', '账户', '账号', '个人中心', '用户中心', '搜索', '帮助', '常见问题',
  '关于', '关于我们', '联系我们', '隐私', '隐私政策', '服务条款', '订阅', '更多', '查看更多',
  '作者主页', '全部分类', '全部标签'
])
const BLOCKED_TITLE_PREFIXES = ['作者：', '作者:', '标签：', '标签:', '分类：', '分类:', '专题：', '专题:', '搜索：', '搜索:', 'author:', 'tag:', 'category:']

export function shouldRejectArticleLink(
  $: cheerio.CheerioAPI,
  element: Element,
  title: string,
  url: string
): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  if (BLOCKED_EXACT_TITLES.has(normalizedTitle)) return true
  if (BLOCKED_TITLE_PREFIXES.some((prefix) => normalizedTitle.startsWith(prefix))) return true

  const tokens = new Set(classNames($, element).map((value) => value.toLowerCase()))
  const id = $(element).attr('id')?.trim().toLowerCase()
  if (id) tokens.add(id)
  for (const rel of ($(element).attr('rel') ?? '').split(/\s+/).filter(Boolean)) tokens.add(rel.toLowerCase())
  if ([...tokens].some((value) => BLOCKED_ELEMENT_TOKENS.has(value))) return true

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const pathSegments = parsed.pathname
    .split('/')
    .map((segment) => {
      try { return decodeURIComponent(segment).toLowerCase() } catch { return null }
    })
    .filter((segment): segment is string => Boolean(segment))
  if (pathSegments.some((segment) => BLOCKED_ROUTE_SEGMENTS.has(segment))) return true
  if (isArchiveListingPath(pathSegments)) return true

  const queryKeys = new Set([...parsed.searchParams.keys()].map((key) => key.trim().toLowerCase()).filter(Boolean))
  if ([...queryKeys].some((key) => BLOCKED_QUERY_KEYS.has(key)) && ![...queryKeys].some((key) => ARTICLE_ID_QUERY_KEYS.has(key))) return true
  return false
}

function isArchiveListingPath(pathSegments: string[]): boolean {
  const index = pathSegments.findIndex((segment) => segment === 'archive' || segment === 'archives')
  if (index < 0) return false
  const tail = pathSegments.slice(index + 1)
  return tail.length === 0 || tail[0] === 'page' || tail[0] === 'paged'
}

