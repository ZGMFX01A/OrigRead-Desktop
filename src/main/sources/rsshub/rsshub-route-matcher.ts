import type { RssHubRouteDefinition, RssHubRouteMatch } from '../../../shared/rsshub'

const MAX_PARAMETER_LENGTH = 256
const MAX_INPUT_PATH_SEGMENT_LENGTH = 256
const PARAMETER_SOURCE = ':([A-Za-z_][A-Za-z0-9_]*)(?:\\{([^}]*)\\})?(\\?)?'
const PARAMETER_ENTIRE = new RegExp(`^${PARAMETER_SOURCE}$`)

interface TemplateMatch {
  parameters: Record<string, string>
  missingParameters: string[]
}

interface ResolvedTarget {
  path: string
  missingParameters: string[]
}

export class RssHubRouteMatcher {
  constructor(private readonly routes: RssHubRouteDefinition[]) {}

  match(inputUrl: string, instanceBaseUrl: string, maxResults = 5): RssHubRouteMatch[] {
    return matchRssHubRoutes(inputUrl, this.routes, instanceBaseUrl, maxResults)
  }
}

export function matchRssHubRoutes(
  inputUrl: string,
  routes: RssHubRouteDefinition[],
  instanceBaseUrl: string,
  maxResults = 5
): RssHubRouteMatch[] {
  let input: URL
  try {
    input = new URL(inputUrl)
  } catch {
    return []
  }
  if (!['http:', 'https:'].includes(input.protocol)) return []

  const encodedPath = input.pathname.toLowerCase()
  if (encodedPath.includes('%2f') || encodedPath.includes('%5c')) return []

  const pathSegments = encodedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment))
  if (pathSegments.some((segment) => segment.length > MAX_INPUT_PATH_SEGMENT_LENGTH)) return []

  const host = normalizeHost(input.hostname)
  const path = `/${pathSegments.join('/')}`
  const baseUrl = normalizeInstanceBaseUrl(instanceBaseUrl)
  if (!baseUrl) return []

  const matched = routes
    .filter((route) => {
      const routeHost = normalizeHost(route.host)
      return host === routeHost || host.endsWith(`.${routeHost}`)
    })
    .map((route) => {
      const templateResult = route.sourcePathTemplate
        ? matchTemplate(path, route.sourcePathTemplate, route.sourceQueryTemplate ?? null, (key) => input.searchParams.get(key))
        : pathMatches(path, route.pathPrefix)
          ? { parameters: {}, missingParameters: [] }
          : null
      return templateResult ? { route, templateResult } : null
    })
    .filter((value): value is { route: RssHubRouteDefinition; templateResult: TemplateMatch } => value !== null)
    .sort((left, right) => {
      const prefixDifference = right.route.pathPrefix.length - left.route.pathPrefix.length
      return prefixDifference !== 0 ? prefixDifference : left.route.name.localeCompare(right.route.name)
    })

  const distinct = new Map<string, { route: RssHubRouteDefinition; templateResult: TemplateMatch }>()
  for (const value of matched) {
    const key = `${value.route.target}\u0000${JSON.stringify(value.templateResult.parameters)}`
    if (!distinct.has(key)) distinct.set(key, value)
    if (distinct.size >= maxResults) break
  }

  return [...distinct.values()].map(({ route, templateResult }) => {
    const target = resolveTarget(route.target, templateResult.parameters)
    const missingParameters = distinctStrings([
      ...templateResult.missingParameters,
      ...target.missingParameters
    ])
    const feedUrl = missingParameters.length === 0 ? `${baseUrl}${target.path}` : null
    return {
      route,
      feedUrl,
      parameters: templateResult.parameters,
      missingParameters,
      resolved: feedUrl !== null
    }
  })
}

export function rssHubParameterMatches(value: string, constraint?: string | null): boolean {
  const normalized = constraint?.trim() ?? ''
  if (!normalized || normalized === '.+' || normalized === '.*') return true
  if (normalized === '\\d+' || normalized === '[0-9]+') return /^\d+$/.test(value)

  const numericLength = /^(?:\\d|\[0-9])\{(\d+)(?:,(\d+))?\}$/.exec(normalized)
  if (numericLength) {
    const minimum = Number(numericLength[1])
    const maximum = numericLength[2] ? Number(numericLength[2]) : minimum
    return /^\d+$/.test(value) && value.length >= minimum && value.length <= maximum
  }

  const literals = normalized.split('|')
  const literalEnum = literals.length > 1 && literals.every((literal) => {
    return literal.length > 0 && literal.length <= 64 && /^[A-Za-z0-9_-]+$/.test(literal)
  })
  return !literalEnum || literals.includes(value)
}

function matchTemplate(
  path: string,
  pathTemplate: string,
  queryTemplate: string | null,
  inputQuery: (key: string) => string | null
): TemplateMatch | null {
  const parameters: Record<string, string> = {}
  const missing = new Set<string>()
  if (!matchPath(path, pathTemplate, parameters, missing)) return null
  if (!matchQuery(queryTemplate, inputQuery, parameters, missing)) return null
  return { parameters, missingParameters: [...missing] }
}

function matchPath(
  path: string,
  template: string,
  parameters: Record<string, string>,
  missing: Set<string>
): boolean {
  const pathSegments = splitPath(path)
  const templateSegments = splitPath(template)
  let pathIndex = 0

  for (const templateSegment of templateSegments) {
    const parameterMatch = PARAMETER_ENTIRE.exec(templateSegment)
    if (parameterMatch) {
      const name = parameterMatch[1]!
      const constraint = parameterMatch[2] || null
      const optional = parameterMatch[3] === '?'
      const value = pathSegments[pathIndex]
      if (value === undefined) {
        if (!optional) missing.add(name)
      } else {
        if (!isSafeParameter(value, constraint)) return false
        parameters[name] = value
        pathIndex += 1
      }
      continue
    }

    const actual = pathSegments[pathIndex]
    if (actual === undefined) return false
    const inlinePattern = buildInlineSegmentRegex(templateSegment)
    const match = inlinePattern.regex.exec(actual)
    if (!match) return false
    for (let index = 0; index < inlinePattern.parameters.length; index += 1) {
      const parameter = inlinePattern.parameters[index]!
      const value = match[index + 1] ?? ''
      if (!isSafeParameter(value, parameter.constraint)) return false
      parameters[parameter.name] = value
    }
    pathIndex += 1
  }

  return pathIndex === pathSegments.length
}

function matchQuery(
  template: string | null,
  inputQuery: (key: string) => string | null,
  parameters: Record<string, string>,
  missing: Set<string>
): boolean {
  if (!template?.trim()) return true
  return template.split('&').every((pair) => {
    const separator = pair.indexOf('=')
    const key = (separator >= 0 ? pair.slice(0, separator) : pair).trim()
    const expected = (separator >= 0 ? pair.slice(separator + 1) : '').trim()
    if (!key) return false
    const parameter = PARAMETER_ENTIRE.exec(expected)
    const actual = inputQuery(key)
    if (!parameter) return actual === expected

    const name = parameter[1]!
    const constraint = parameter[2] || null
    const optional = parameter[3] === '?'
    if (actual === null && optional) return true
    if (actual === null) {
      missing.add(name)
      return true
    }
    if (!isSafeParameter(actual, constraint)) return false
    parameters[name] = actual
    return true
  })
}

function resolveTarget(template: string, parameters: Record<string, string>): ResolvedTarget {
  const missing = new Set<string>()
  const resolvedSegments: string[] = []

  for (const segment of splitPath(template)) {
    const matches = [...segment.matchAll(new RegExp(PARAMETER_SOURCE, 'g'))]
    if (matches.length === 0) {
      resolvedSegments.push(segment)
      continue
    }

    const onlyParameter = matches.length === 1 && matches[0]!.index === 0 && matches[0]![0].length === segment.length
    const optional = matches.every((match) => match[3] === '?')
    const unavailable = matches.filter((match) => !parameters[match[1]!])
    if (unavailable.length > 0) {
      unavailable.filter((match) => match[3] !== '?').forEach((match) => missing.add(match[1]!))
      if (onlyParameter && optional) continue
      if (onlyParameter) continue
    }

    let resolved = segment
    for (const match of matches.reverse()) {
      const name = match[1]!
      const value = parameters[name]
      const start = match.index ?? 0
      resolved = `${resolved.slice(0, start)}${value ? encodePathSegment(value) : ''}${resolved.slice(start + match[0].length)}`
    }
    if (resolved.trim()) resolvedSegments.push(resolved.trim())
  }

  return { path: `/${resolvedSegments.join('/')}`, missingParameters: [...missing] }
}

function buildInlineSegmentRegex(template: string): {
  regex: RegExp
  parameters: Array<{ name: string; constraint: string | null }>
} {
  const parameters: Array<{ name: string; constraint: string | null }> = []
  let pattern = '^'
  let cursor = 0
  for (const match of template.matchAll(new RegExp(PARAMETER_SOURCE, 'g'))) {
    const start = match.index ?? 0
    pattern += literalPattern(template.slice(cursor, start))
    pattern += `(.{1,${MAX_PARAMETER_LENGTH}})`
    parameters.push({ name: match[1]!, constraint: match[2] || null })
    cursor = start + match[0].length
  }
  pattern += literalPattern(template.slice(cursor))
  pattern += '$'
  return { regex: new RegExp(pattern), parameters }
}

function literalPattern(value: string): string {
  return value.split('').map((char) => char === '*' ? '.*' : escapeRegex(char)).join('')
}

function isSafeParameter(value: string, constraint: string | null): boolean {
  return value.length > 0
    && value.length <= MAX_PARAMETER_LENGTH
    && value !== '.'
    && value !== '..'
    && !/[\/\\?#&=\u0000-\u001F\u007F]/.test(value)
    && !value.includes('://')
    && rssHubParameterMatches(value, constraint)
}

function encodePathSegment(value: string): string {
  const safe = /^[A-Za-z0-9._~-]$/
  const hex = '0123456789ABCDEF'
  let result = ''
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte)
    if (byte < 128 && safe.test(char)) {
      result += char
    } else {
      result += `%${hex[byte >> 4]}${hex[byte & 0x0f]}`
    }
  }
  return result
}

function splitPath(value: string): string[] {
  const normalized = value.replace(/^\/+|\/+$/g, '')
  return normalized ? normalized.split('/') : []
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, '').toLowerCase().replace(/^www\./, '')
}

export function normalizeRssHubInstanceUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return 'https://rsshub.app'
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function normalizeInstanceBaseUrl(value: string): string | null {
  return normalizeRssHubInstanceUrl(value)
}

function pathMatches(path: string, prefix: string): boolean {
  if (prefix === '/') return true
  const normalized = prefix.replace(/\/+$/, '')
  return path === normalized || path.startsWith(`${normalized}/`)
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function distinctStrings(values: string[]): string[] {
  return [...new Set(values)]
}

