export interface ReaderImageRequestDetails {
  url: string
  resourceType: string
  requestHeaders: Record<string, string>
}

/**
 * Local Reader images have no remote referring page. Do not invent a Referer from the image URL:
 * servers can reject that fabricated origin, including when they accept a missing Referer.
 *
 * Keep a browser-generated HTTP(S) Referer unchanged; remove only unusable local/opaque values.
 * The original-page WebContentsView uses its own session and retains Chromium's normal policy.
 */
export function withReaderImageReferer(details: ReaderImageRequestDetails): Record<string, string> {
  if (details.resourceType !== 'image') return details.requestHeaders

  const existingEntry = Object.entries(details.requestHeaders)
    .find(([key]) => key.toLowerCase() === 'referer')
  const existingReferer = existingEntry?.[1]?.trim() ?? ''
  if (!existingEntry || /^https?:\/\//i.test(existingReferer)) return details.requestHeaders

  try {
    const target = new URL(details.url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return details.requestHeaders
    const next = { ...details.requestHeaders }
    delete next[existingEntry[0]]
    return next
  } catch {
    return details.requestHeaders
  }
}
