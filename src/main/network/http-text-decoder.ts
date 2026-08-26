const DECLARATION_PROBE_BYTES = 4_096

export type HttpTextKind = 'auto' | 'html' | 'xml'

/**
 * Decode an HTTP text payload without assuming UTF-8.
 *
 * Charset priority follows the information that is actually authoritative for desktop parsing:
 * BOM -> HTTP Content-Type charset -> XML declaration / HTML meta charset -> UTF-8 fallback.
 * This keeps GBK/GB2312 era Chinese sites readable without introducing site-specific rules.
 */
export function decodeHttpText(
  bytes: Uint8Array,
  contentType: string | null = null,
  kind: HttpTextKind = 'auto'
): string {
  if (bytes.length === 0) return ''

  const declarationProbe = buildDeclarationProbe(bytes)
  const candidates = distinctCharsets([
    detectBomCharset(bytes),
    extractHttpCharset(contentType),
    kind === 'html' ? null : extractXmlDeclarationCharset(declarationProbe),
    kind === 'xml' ? null : extractHtmlMetaCharset(declarationProbe),
    'utf-8'
  ])

  for (const charset of candidates) {
    try {
      return new TextDecoder(normalizeCharsetLabel(charset)).decode(bytes)
    } catch {
      // Unsupported or malformed charset labels fall through to the next safe candidate.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function detectBomCharset(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

function extractHttpCharset(contentType: string | null): string | null {
  if (!contentType) return null
  return /charset\s*=\s*["']?\s*([^;"'\s]+)/i.exec(contentType)?.[1]?.trim() || null
}

function extractXmlDeclarationCharset(probe: string): string | null {
  return /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([^"']+)\s*["']/i.exec(probe)?.[1]?.trim() || null
}

function extractHtmlMetaCharset(probe: string): string | null {
  const metaTags = probe.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of metaTags) {
    const direct = /\bcharset\s*=\s*["']?\s*([^\s"'/>;]+)/i.exec(tag)?.[1]?.trim()
    if (direct) return direct

    const content = attributeValue(tag, 'content')
    const fromContent = content
      ? /charset\s*=\s*["']?\s*([^;"'\s]+)/i.exec(content)?.[1]?.trim()
      : null
    if (fromContent) return fromContent
  }
  return null
}

function attributeValue(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function buildDeclarationProbe(bytes: Uint8Array): string {
  const length = Math.min(bytes.length, DECLARATION_PROBE_BYTES)
  let probe = ''
  for (let index = 0; index < length; index += 1) probe += String.fromCharCode(bytes[index]!)
  return probe
}

function normalizeCharsetLabel(label: string): string {
  const normalized = label.trim().toLowerCase()
  switch (normalized) {
    case 'gb2312':
    case 'gb_2312-80':
    case 'x-gbk':
    case 'gbk':
      return 'gb18030'
    case 'utf8':
      return 'utf-8'
    default:
      return normalized
  }
}

function distinctCharsets(values: Array<string | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value) continue
    const normalized = normalizeCharsetLabel(value)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}
