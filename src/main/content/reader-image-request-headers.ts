export interface ReaderImageRequestDetails {
  url: string
  resourceType: string
  requestHeaders: Record<string, string>
}

/**
 * Android Reader 的 Coil 请求会为文章图片补充 Referer。Electron Reader 从 file:// 页面直接加载远程图片时
 * 通常没有可用的 HTTP Referer，部分站点会因此返回防盗链占位图或异常图片内容。
 *
 * 这里只在“图片请求且当前没有 HTTP(S) Referer”时补目标图片自身的 origin；真实网页 WebContentsView
 * 已经拥有正常 Referer 时保持原样，避免改变原站导航语义。
 */
export function withReaderImageReferer(details: ReaderImageRequestDetails): Record<string, string> {
  if (details.resourceType !== 'image') return details.requestHeaders

  const existingEntry = Object.entries(details.requestHeaders)
    .find(([key]) => key.toLowerCase() === 'referer')
  const existingReferer = existingEntry?.[1]?.trim() ?? ''
  if (/^https?:\/\//i.test(existingReferer)) return details.requestHeaders

  try {
    const target = new URL(details.url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return details.requestHeaders
    const next = { ...details.requestHeaders }
    if (existingEntry) delete next[existingEntry[0]]
    next.Referer = `${target.origin}/`
    return next
  } catch {
    return details.requestHeaders
  }
}
