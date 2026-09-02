export interface RendererTrustPolicy {
  developmentUrl?: string | null
  productionUrl: string
}

/**
 * Electron IPC trust must compare parsed URLs, never string prefixes.
 * Development trusts only the configured dev-server origin. Production trusts only
 * the exact packaged renderer file (query/hash are allowed for client-side state).
 */
export function isAllowedRendererUrl(value: string, policy: RendererTrustPolicy): boolean {
  try {
    const sender = new URL(value)
    const developmentUrl = policy.developmentUrl?.trim()
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return (expected.protocol === 'http:' || expected.protocol === 'https:')
        && sender.origin === expected.origin
    }

    const expected = new URL(policy.productionUrl)
    return sender.protocol === 'file:'
      && expected.protocol === 'file:'
      && sender.host === expected.host
      && sender.pathname === expected.pathname
  } catch {
    return false
  }
}
