export interface ArticleImageUrlContext {
  articleUrl?: string | null
  sourcePageUrl?: string | null
  feedUrl?: string | null
}

/** Resolve existing image metadata without fetching or inspecting an article body. */
export function resolveArticleImageUrl(
  imageUrl: string | null | undefined,
  context: ArticleImageUrlContext = {}
): string | null {
  const value = imageUrl?.trim()
  if (!value) return null
  const absolute = httpUrl(value)
  if (absolute) return absolute.href
  for (const candidate of [context.articleUrl, context.sourcePageUrl, context.feedUrl]) {
    const base = candidate?.trim() ? httpUrl(candidate.trim()) : null
    if (!base) continue
    const resolved = httpUrl(value, base)
    if (resolved) return resolved.href
  }
  return null
}

function httpUrl(value: string, base?: URL): URL | null {
  // Do not let URL silently strip control characters from persisted metadata.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const url = new URL(value, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}
