import type * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import type { WebsiteParsedArticle, WebsiteParseCandidate, WebsiteRule } from '../../../shared/website'
import { defaultWebsiteRule } from '../../../shared/website'
import { normalizeArticleUrlPattern, type ArticleUrlPattern } from './article-url-pattern-normalizer'
import { shouldRejectArticleLink } from './article-link-heuristics'
import { AutomaticArticleDateExtractor } from './automatic-article-date-extractor'
import { scoreAutomaticWebsiteRegion } from './automatic-website-region-scorer'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import { rankingScore, scoreWebsiteCandidate } from './website-candidate-scorer'
import {
  ancestorElements,
  classNames,
  elementChildren,
  javaStringHash,
  parentElement,
  resolveElementAttribute,
  selectFirstWithin,
  selectWithin,
  tagName,
  unsignedHex
} from './website-dom'

export const AUTOMATIC_WEBSITE_RULE_ID_PREFIX = 'auto-dom:'
export const AUTOMATIC_WEBSITE_RULE_VERSION = 7

const MIN_REPEATED_ITEMS = 3
const MAX_REPEATED_ITEMS = 100
const MAX_CANDIDATES = 5
const MAX_CONTAINERS = 400
const MAX_GROUPS = 120
const MAX_ITEMS_PER_GROUP = 30
const MAX_VISITED_ELEMENTS = 1_500
const MAX_CHILDREN_PER_ELEMENT = 80
const MAX_LINKS_PER_ITEM = 40
const MAX_DETECTION_TIME_MS = 1_500
const IGNORED_TAGS = new Set(['nav', 'header', 'footer', 'script', 'style', 'noscript', 'svg'])

interface RepeatedGroup {
  signature: string
  container: Element
  items: Element[]
}

interface LinkCandidate {
  element: Element
  titleElement: Element
  title: string
  url: string
  pattern: ArticleUrlPattern
  score: number
}

interface ItemLinkCandidates {
  item: Element
  links: LinkCandidate[]
}

interface SelectedItem {
  item: Element
  link: LinkCandidate
}

interface ArticleCluster {
  pattern: ArticleUrlPattern
  articles: WebsiteParsedArticle[]
  selectedItems: SelectedItem[]
  linkQualityScore: number
}

export function detectAutomaticWebsiteLists(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  sourceUrl: string,
  fetchedAt: number,
  historyScoreProvider: (ruleId: string) => number = () => 0
): WebsiteParseCandidate[] {
  let host = ''
  try { host = new URL(sourceUrl).hostname } catch { return [] }
  const body = $('body').get(0)
  if (!body || !('name' in body)) return []

  const seenArticleSets = new Set<string>()
  const deadline = performance.now() + MAX_DETECTION_TIME_MS
  const dateExtractor = AutomaticArticleDateExtractor.create($, baseUrl, fetchedAt)
  const results: WebsiteParseCandidate[] = []
  let groupCount = 0

  for (const container of boundedElements($, body as Element, deadline)) {
    if (performance.now() >= deadline || results.length >= MAX_CANDIDATES * 4) break
    if (!isEligibleContainer($, container)) continue
    for (const group of repeatedGroups($, container)) {
      groupCount += 1
      if (groupCount > MAX_GROUPS || performance.now() >= deadline) break
      const clusters = buildArticleClusters($, baseUrl, group.items, sourceUrl, fetchedAt, host, dateExtractor, deadline)
      for (const cluster of clusters) {
        if (cluster.articles.length < MIN_REPEATED_ITEMS || performance.now() >= deadline) continue
        const uniqueKey = cluster.articles.map((article) => article.link).join('|')
        if (seenArticleSets.has(uniqueKey)) continue
        seenArticleSets.add(uniqueKey)

        const candidateIdSource = `${group.signature}|${cluster.pattern.key}`
        const ruleId = `${AUTOMATIC_WEBSITE_RULE_ID_PREFIX}${host}:${unsignedHex(javaStringHash(candidateIdSource))}`
        const region = scoreAutomaticWebsiteRegion($, group.container)
        const rule = buildReusableRule($, baseUrl, sourceUrl, group, cluster, host, ruleId, fetchedAt, deadline, region.adjustment)
        if (!rule) continue
        const diagnostics = scoreWebsiteCandidate(cluster.articles, fetchedAt)
        diagnostics.linkQualityScore = cluster.linkQualityScore
        diagnostics.regionScore = region.adjustment
        diagnostics.historyScore = historyScoreProvider(ruleId)
        if (!diagnostics.state.startsWith('AVAILABLE')) continue
        results.push({ rule, articles: cluster.articles, diagnostics })
      }
    }
    if (groupCount > MAX_GROUPS) break
  }

  const distinct = new Map<string, WebsiteParseCandidate>()
  for (const candidate of results.sort((left, right) => rankingScore(right.diagnostics) - rankingScore(left.diagnostics))) {
    if (!distinct.has(candidate.rule.id)) distinct.set(candidate.rule.id, candidate)
  }
  return [...distinct.values()].slice(0, MAX_CANDIDATES)
}

export function isReusableAutomaticWebsiteRule(rule: WebsiteRule): boolean {
  return rule.id.startsWith(AUTOMATIC_WEBSITE_RULE_ID_PREFIX)
    && rule.version === AUTOMATIC_WEBSITE_RULE_VERSION
    && rule.articleSelectors.some((selector) => selector.trim().length > 0)
    && rule.titleSelector.trim().length > 0
    && rule.linkSelector.trim().length > 0
    && Boolean(rule.automaticUrlPattern?.trim())
}

function* boundedElements($: cheerio.CheerioAPI, root: Element, deadline: number): Generator<Element> {
  const stack = elementChildren($, root).slice(0, MAX_CHILDREN_PER_ELEMENT).reverse()
  let visited = 0
  while (stack.length > 0 && visited < MAX_VISITED_ELEMENTS && performance.now() < deadline) {
    const element = stack.pop()!
    visited += 1
    yield element
    const children = elementChildren($, element).slice(0, MAX_CHILDREN_PER_ELEMENT).reverse()
    stack.push(...children)
  }
}

function isEligibleContainer($: cheerio.CheerioAPI, element: Element): boolean {
  if (IGNORED_TAGS.has(tagName(element))) return false
  if (ancestorElements($, element).some((parent) => IGNORED_TAGS.has(tagName(parent)))) return false
  const childCount = elementChildren($, element).length
  return childCount >= MIN_REPEATED_ITEMS && childCount <= MAX_REPEATED_ITEMS
}

function repeatedGroups($: cheerio.CheerioAPI, container: Element): RepeatedGroup[] {
  const groups = new Map<string, Element[]>()
  for (const child of elementChildren($, container)) {
    const signature = elementSignature($, child)
    const list = groups.get(signature) ?? []
    list.push(child)
    groups.set(signature, list)
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length >= MIN_REPEATED_ITEMS && items.length <= MAX_REPEATED_ITEMS)
    .map(([signature, items]) => ({
      signature: `${elementSignature($, container)} > ${signature}`,
      container,
      items
    }))
}

function elementSignature($: cheerio.CheerioAPI, element: Element): string {
  const classes = classNames($, element).filter((value) => !looksUnstableClass(value)).sort().slice(0, 2)
  return `${tagName(element)}${classes.map((value) => `.${value}`).join('')}`
}

function buildArticleClusters(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  items: Element[],
  sourceUrl: string,
  fetchedAt: number,
  host: string,
  dateExtractor: AutomaticArticleDateExtractor,
  deadline: number
): ArticleCluster[] {
  const itemCandidates: ItemLinkCandidates[] = []
  for (const item of items.slice(0, MAX_ITEMS_PER_GROUP)) {
    if (performance.now() >= deadline) break
    const links = collectLinkCandidates($, baseUrl, item, host, deadline)
    if (links.length > 0) itemCandidates.push({ item, links })
  }

  const patternCounts = new Map<string, number>()
  for (const candidate of itemCandidates) {
    for (const key of new Set(candidate.links.map((link) => link.pattern.key))) {
      patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1)
    }
  }

  const clusters: ArticleCluster[] = []
  for (const [patternKey] of [...patternCounts.entries()]
    .filter(([, count]) => count >= MIN_REPEATED_ITEMS)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)) {
    const selectedItems: SelectedItem[] = []
    const seenUrls = new Set<string>()
    for (const itemCandidate of itemCandidates) {
      const matching = itemCandidate.links.filter((link) => link.pattern.key === patternKey)
      if (matching.length === 0) continue
      const link = matching.reduce((best, current) => current.score > best.score ? current : best)
      if (seenUrls.has(link.url)) continue
      seenUrls.add(link.url)
      selectedItems.push({ item: itemCandidate.item, link })
      if (selectedItems.length >= 50) break
    }
    if (selectedItems.length < MIN_REPEATED_ITEMS) continue
    const pattern = itemCandidates.flatMap((candidate) => candidate.links).find((link) => link.pattern.key === patternKey)!.pattern
    clusters.push({
      pattern,
      articles: selectedItems.map((selected) => buildArticle($, baseUrl, selected.item, selected.link, sourceUrl, fetchedAt, dateExtractor)),
      selectedItems,
      linkQualityScore: calculateLinkQualityScore(selectedItems, itemCandidates)
    })
  }
  return clusters
}

function calculateLinkQualityScore(selectedItems: SelectedItem[], itemCandidates: ItemLinkCandidates[]): number {
  if (selectedItems.length === 0) return 0
  const bestScores = new Map<Element, number>()
  for (const candidate of itemCandidates) bestScores.set(candidate.item, Math.max(...candidate.links.map((link) => link.score), 0))
  const gap = Math.trunc(selectedItems.reduce((sum, selected) => sum + selected.link.score - (bestScores.get(selected.item) ?? selected.link.score), 0) / selectedItems.length)
  return Math.max(-60, Math.min(0, gap))
}

function collectLinkCandidates(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  item: Element,
  host: string,
  deadline: number
): LinkCandidate[] {
  const links = selectWithin($, item, 'a[href]').slice(0, MAX_LINKS_PER_ITEM)
  const results: LinkCandidate[] = []
  for (const link of links) {
    if (performance.now() >= deadline) break
    const title = extractLinkTitle($, link)
    if (!title) continue
    const url = resolveElementAttribute($, link, 'href', baseUrl)
    if (!url || shouldRejectArticleLink($, link, title.text, url)) continue
    const pattern = normalizeArticleUrlPattern(url, host)
    if (!pattern) continue
    results.push({
      element: link,
      titleElement: title.element,
      title: title.text,
      url,
      pattern,
      score: calculateLinkScore($, link, title.text, url, pattern)
    })
  }
  return results
}

function extractLinkTitle($: cheerio.CheerioAPI, link: Element): { element: Element; text: string } | null {
  const heading = selectFirstWithin($, link, 'h1, h2, h3, h4, h5, h6')
  if (heading) {
    const text = $(heading).text().trim()
    if (text.length >= 4 && text.length <= 200) return { element: heading, text }
  }
  const text = $(link).text().trim()
  return text.length >= 4 && text.length <= 200 ? { element: link, text } : null
}

function buildArticle(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  item: Element,
  anchor: LinkCandidate,
  sourceUrl: string,
  fetchedAt: number,
  dateExtractor: AutomaticArticleDateExtractor
): WebsiteParsedArticle {
  const image = selectFirstWithin($, item, 'img')
  let imageUrl: string | null = null
  if (image) {
    for (const attribute of ['data-original', 'data-src', 'src']) {
      imageUrl = resolveElementAttribute($, image, attribute, baseUrl)
      if (imageUrl) break
    }
  }
  return {
    stableId: anchor.url,
    title: anchor.title,
    link: anchor.url,
    author: null,
    publishedAt: dateExtractor.extract(item, anchor.url),
    descriptionHtml: '',
    imageUrl
  }
}

function calculateLinkScore(
  $: cheerio.CheerioAPI,
  element: Element,
  title: string,
  url: string,
  pattern: ArticleUrlPattern
): number {
  let score = Math.min(title.length, 80)
  if (ancestorElements($, element).some((parent) => ['h1', 'h2', 'h3', 'h4'].includes(tagName(parent))) || selectFirstWithin($, element, 'h1, h2, h3, h4')) score += 60
  if (classNames($, element).some((value) => value.toLowerCase().includes('title'))) score += 30
  if ([...url].filter((character) => character === '/').length >= 4) score += 20
  score += Math.min(pattern.pathDepth, 5) * 5
  score += Math.min(pattern.dynamicPartCount, 3) * 15
  return score
}

function buildReusableRule(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  sourceUrl: string,
  group: RepeatedGroup,
  cluster: ArticleCluster,
  host: string,
  ruleId: string,
  fetchedAt: number,
  deadline: number,
  regionScore: number
): WebsiteRule | null {
  if (performance.now() >= deadline) return null
  const itemSegment = selectorSegment($, group.items[0]!)
  const articleSelector = buildArticleSelector($, group.container, itemSegment)
  if (!articleSelector || $(articleSelector).length < MIN_REPEATED_ITEMS) return null
  const linkSelector = buildLinkSelector($, cluster)
  if (!linkSelector) return null
  const titleSelector = buildTitleSelector($, cluster, linkSelector)
  if (!titleSelector || performance.now() >= deadline) return null
  const hasImage = cluster.selectedItems.some((selected) => selectFirstWithin($, selected.item, 'img') !== null)
  const rule = defaultWebsiteRule({
    id: ruleId,
    name: `Smart detection · ${cluster.pattern.key.slice(0, 96)}`,
    version: AUTOMATIC_WEBSITE_RULE_VERSION,
    hosts: [host],
    articleSelectors: [articleSelector],
    titleSelector,
    linkSelector,
    imageSelector: hasImage ? 'img' : null,
    imageAttributes: ['data-original', 'data-src', 'src'],
    automaticUrlPattern: cluster.pattern.key,
    automaticDateExtraction: true,
    automaticRegionScore: regionScore,
    maxItems: 50
  })

  if (performance.now() >= deadline) return null
  let reparsed: WebsiteParsedArticle[] = []
  try {
    reparsed = new ConfigurableWebsiteParser(rule).parse($, baseUrl, sourceUrl, fetchedAt)
  } catch {
    return null
  }
  const originalLinks = new Set(cluster.articles.map((article) => article.link))
  const overlap = reparsed.filter((article) => originalLinks.has(article.link)).length
  return reparsed.length >= MIN_REPEATED_ITEMS && overlap >= MIN_REPEATED_ITEMS ? rule : null
}

function buildArticleSelector($: cheerio.CheerioAPI, container: Element, itemSegment: string): string | null {
  const id = validCssToken($(container).attr('id') ?? '')
  if (id) {
    const selector = `#${id} > ${itemSegment}`
    if ($(selector).length >= MIN_REPEATED_ITEMS) return selector
  }
  const segments: string[] = []
  let current: Element | null = container
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (tagName(current) === 'body') break
    segments.unshift(selectorSegment($, current))
    const selector = `${segments.join(' > ')} > ${itemSegment}`
    if ($(selector).length >= MIN_REPEATED_ITEMS) return selector
    current = parentElement($, current)
  }
  return null
}

function buildLinkSelector($: cheerio.CheerioAPI, cluster: ArticleCluster): string | null {
  const candidates = new Set<string>()
  for (const selected of cluster.selectedItems) {
    addRelativeSelectorCandidates($, candidates, selected.item, selected.link.element, false)
    addRelativeSelectorCandidates($, candidates, selected.item, selected.link.element, true)
    candidates.add(selectorSegment($, selected.link.element))
  }
  candidates.add('a[href]')
  return [...candidates]
    .filter(Boolean)
    .filter((selector) => cluster.selectedItems.every((selected) => selectFirstWithin($, selected.item, selector) === selected.link.element))
    .sort(compareSelectorComplexity)[0] ?? null
}

function buildTitleSelector($: cheerio.CheerioAPI, cluster: ArticleCluster, linkSelector: string): string | null {
  if (cluster.selectedItems.every((selected) => selected.link.titleElement === selected.link.element)) return linkSelector
  const candidates = new Set<string>()
  for (const selected of cluster.selectedItems) {
    addRelativeSelectorCandidates($, candidates, selected.item, selected.link.titleElement, false)
    addRelativeSelectorCandidates($, candidates, selected.item, selected.link.titleElement, true)
    candidates.add(selectorSegment($, selected.link.titleElement))
  }
  return [...candidates]
    .filter(Boolean)
    .filter((selector) => cluster.selectedItems.every((selected) => selectFirstWithin($, selected.item, selector) === selected.link.titleElement))
    .sort(compareSelectorComplexity)[0] ?? null
}

function addRelativeSelectorCandidates(
  $: cheerio.CheerioAPI,
  output: Set<string>,
  item: Element,
  target: Element,
  includePosition: boolean
): void {
  const segments: string[] = []
  let current: Element | null = target
  while (current && current !== item) {
    segments.push(selectorSegment($, current, includePosition))
    current = parentElement($, current)
  }
  if (current !== item || segments.length === 0) return
  const ordered = segments.reverse()
  for (let start = 0; start < ordered.length; start += 1) output.add(ordered.slice(start).join(' > '))
}

function compareSelectorComplexity(left: string, right: string): number {
  const leftDepth = [...left].filter((character) => character === '>').length
  const rightDepth = [...right].filter((character) => character === '>').length
  return leftDepth - rightDepth || left.length - right.length
}

function selectorSegment($: cheerio.CheerioAPI, element: Element, includePosition = false): string {
  const classes = stableClasses($, element)
  let selector = `${tagName(element)}${classes.map((value) => `.${value}`).join('')}`
  if (includePosition && classes.length === 0) {
    const parent = parentElement($, element)
    if (parent) {
      const sameTag = elementChildren($, parent).filter((sibling) => tagName(sibling) === tagName(element))
      if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(element) + 1})`
    }
  }
  return selector
}

function stableClasses($: cheerio.CheerioAPI, element: Element): string[] {
  return classNames($, element)
    .filter((value) => !looksUnstableClass(value))
    .map(validCssToken)
    .filter((value): value is string => Boolean(value))
    .sort()
    .slice(0, 2)
}

function looksUnstableClass(value: string): boolean {
  const normalized = value.toLowerCase()
  const digitCount = [...normalized].filter((character) => /\d/.test(character)).length
  if (normalized.length > 32 || digitCount > normalized.length / 2) return true
  if (TRANSIENT_CLASS_NAMES.has(normalized)) return true
  if (POSITION_CLASS_RE.test(normalized)) return true
  if (RESPONSIVE_UTILITY_CLASS_RE.test(normalized)) return true
  return STATE_SUFFIX_RE.test(normalized)
}

function validCssToken(value: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : null
}

const TRANSIENT_CLASS_NAMES = new Set([
  'odd', 'even', 'first', 'last', 'active', 'current', 'selected', 'is-active', 'is-current',
  'is-selected', 'sticky', 'pinned', 'featured', 'is-sticky', 'is-pinned', 'is-featured'
])
const POSITION_CLASS_RE = /^(?:item|row|entry|article|post|news|card|index|position|pos|order)[_-]?\d+$/
const STATE_SUFFIX_RE = /^.+(?:--|__|-)(?:odd|even|first|last|active|current|selected|sticky|pinned|featured)$/
const RESPONSIVE_UTILITY_CLASS_RE = /^(?:xs|sm|md|lg|xl|xxl)[:_-](?:card|grid|list|column|col|row|compact|wide|stacked|horizontal|vertical|hidden|visible|block|flex).*$/

