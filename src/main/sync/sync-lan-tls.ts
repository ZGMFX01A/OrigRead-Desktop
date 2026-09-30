import { createPublicKey, randomBytes, verify as verifySignature, X509Certificate, type KeyObject } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

const CHALLENGE_NONCE = /^[A-Za-z0-9._~-]{16,128}$/
const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024

export interface SyncLanPeerTlsIdentity {
  deviceId: string
  publicKeySpkiBase64: string
  certificateDerBase64: string
  nonce: string
  timestamp: number
  signature: string
}

interface SyncLanChallengeResponse {
  deviceId?: unknown
  publicKeySpkiBase64?: unknown
  tlsCertificateDerBase64?: unknown
  nonce?: unknown
  timestamp?: unknown
  signature?: unknown
}

/**
 * Authenticated HTTPS transport for one LAN peer. The only cleartext call is the public nonce
 * challenge used to learn the peer certificate before opening TLS; its signature and certificate
 * key are checked before this object can send any pairing or business request.
 */
export class SyncLanPeerTlsClient {
  private readonly agent: HttpsAgent

  private constructor(
    readonly baseUrl: string,
    readonly identity: SyncLanPeerTlsIdentity,
    certificate: X509Certificate,
    private readonly localAddress?: string
  ) {
    this.agent = new HttpsAgent({
      keepAlive: true,
      maxSockets: 8,
      ca: certificate.toString(),
      rejectUnauthorized: true,
      // AndroidKeyStore emits a self-signed leaf certificate (CA=false). Node/OpenSSL will not
      // accept that leaf as an explicit trust anchor by default even though it is the exact
      // certificate authenticated by the signed bootstrap challenge. Partial-chain trust lets
      // the explicitly supplied certificate terminate verification here; checkServerIdentity
      // below still enforces the exact durable-device SPKI pin on every TLS connection.
      allowPartialTrustChain: true,
      minVersion: 'TLSv1.2',
      checkServerIdentity: (_hostname, peerCertificate) => {
        try {
          const peerKey = spkiBase64(new X509Certificate(peerCertificate.raw).publicKey)
          if (!constantTimeBase64Equal(peerKey, identity.publicKeySpkiBase64)) {
            return new Error('TLS peer certificate does not match the paired device identity')
          }
          return undefined
        } catch (error) {
          return error instanceof Error ? error : new Error('TLS peer certificate is invalid')
        }
      }
    })
  }

  static async connect(
    secureBaseUrl: string,
    expectedPublicKeySpkiBase64?: string,
    expectedDeviceId?: string,
    timeoutMs = 5_000,
    localAddress?: string
  ): Promise<SyncLanPeerTlsClient> {
    const secureBase = new URL(secureBaseUrl)
    if (secureBase.protocol !== 'https:') throw new Error('LAN peer endpoint must use HTTPS')
    const securePort = Number(secureBase.port || 443)
    const bootstrapPort = securePort - 1
    if (!Number.isSafeInteger(bootstrapPort) || bootstrapPort < 1 || bootstrapPort > 65_534) {
      throw new Error('LAN TLS endpoint must use its adjacent bootstrap port')
    }
    secureBase.pathname = '/'
    secureBase.search = ''
    secureBase.hash = ''

    const nonce = randomNonce()
    const bootstrapUrl = new URL('/v1/auth/challenge', secureBase)
    bootstrapUrl.protocol = 'http:'
    bootstrapUrl.port = String(bootstrapPort)
    const bootstrap = await requestBootstrapIdentity(
      bootstrapUrl,
      JSON.stringify({ nonce }),
      timeoutMs,
      localAddress
    )
    const body = bootstrap.body
    if (body.length > MAX_BOOTSTRAP_RESPONSE_BYTES) throw new Error('LAN identity challenge response exceeds the size limit')
    if (bootstrap.status < 200 || bootstrap.status >= 300) {
      throw new Error(`LAN identity challenge failed: HTTP ${bootstrap.status} ${body.slice(0, 300)}`)
    }

    let challenge: SyncLanChallengeResponse
    try {
      challenge = JSON.parse(body) as SyncLanChallengeResponse
    } catch {
      throw new Error('LAN identity challenge returned invalid JSON')
    }
    if (
      typeof challenge.deviceId !== 'string' || !challenge.deviceId.trim() ||
      typeof challenge.publicKeySpkiBase64 !== 'string' ||
      typeof challenge.tlsCertificateDerBase64 !== 'string' ||
      typeof challenge.nonce !== 'string' ||
      typeof challenge.timestamp !== 'number' || !Number.isSafeInteger(challenge.timestamp) ||
      typeof challenge.signature !== 'string'
    ) {
      throw new Error('LAN identity challenge is missing signed device or TLS certificate fields')
    }
    if (challenge.nonce !== nonce || !CHALLENGE_NONCE.test(challenge.nonce)) {
      throw new Error('LAN identity challenge nonce does not match this request')
    }
    if (Math.abs(Date.now() - challenge.timestamp) > 120_000) {
      throw new Error('LAN identity challenge timestamp is outside the allowed window')
    }
    if (expectedDeviceId && challenge.deviceId !== expectedDeviceId) {
      throw new Error('LAN endpoint answered with a different device identity')
    }
    if (expectedPublicKeySpkiBase64 && !constantTimeBase64Equal(challenge.publicKeySpkiBase64, expectedPublicKeySpkiBase64)) {
      throw new Error('LAN endpoint public key changed; pair this device again before syncing')
    }

    const publicKeyBytes = decodeCanonicalBase64(challenge.publicKeySpkiBase64, 'LAN identity public key')
    const publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' })
    const signature = decodeCanonicalBase64(challenge.signature, 'LAN challenge signature')
    const signedMaterial = Buffer.from(`CHALLENGE_RESPONSE:${challenge.deviceId}:${nonce}:${challenge.timestamp}`, 'utf8')
    if (!verifySignature('sha256', signedMaterial, publicKey, signature)) {
      throw new Error('LAN identity challenge signature is invalid')
    }

    const certificateDer = decodeCanonicalBase64(challenge.tlsCertificateDerBase64, 'LAN TLS certificate')
    if (certificateDer.byteLength > 16 * 1024) throw new Error('LAN TLS certificate exceeds the size limit')
    const certificate = new X509Certificate(certificateDer)
    if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
      throw new Error('LAN TLS certificate is not self-signed by its device key')
    }
    if (!constantTimeBase64Equal(spkiBase64(certificate.publicKey), challenge.publicKeySpkiBase64)) {
      throw new Error('LAN TLS certificate key does not match the signed device identity')
    }
    const now = Date.now()
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
      throw new Error('LAN TLS certificate is outside its validity period')
    }

    return new SyncLanPeerTlsClient(
      secureBase.toString().replace(/\/$/, ''),
      {
        deviceId: challenge.deviceId,
        publicKeySpkiBase64: challenge.publicKeySpkiBase64,
        certificateDerBase64: challenge.tlsCertificateDerBase64,
        nonce,
        timestamp: challenge.timestamp,
        signature: challenge.signature
      },
      certificate,
      localAddress
    )
  }

  fetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(pathOrUrl, this.baseUrl)
    if (url.protocol !== 'https:' || url.origin !== new URL(this.baseUrl).origin) {
      throw new Error('LAN TLS transport cannot be redirected to a different endpoint')
    }
    return requestPinnedHttps(url, init, this.agent, this.localAddress)
  }

  close(): void {
    this.agent.destroy()
  }
}

/** HTTPS fetch-compatible adapter that keeps response bodies streamed for blob/range transfers. */
function requestPinnedHttps(url: URL, init: RequestInit, agent: HttpsAgent, localAddress?: string): Promise<Response> {
  if (init.redirect && init.redirect !== 'error') {
    throw new Error('LAN TLS transport does not follow redirects')
  }
  if (init.body instanceof ReadableStream) {
    throw new Error('LAN TLS request body must be a byte buffer or string')
  }

  return new Promise((resolve, reject) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const request = httpsRequest(url, { method, headers: Object.fromEntries(headers.entries()), agent, localAddress }, (incoming) => {
      const responseHeaders = new Headers()
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index]
        const value = incoming.rawHeaders[index + 1]
        if (name && value !== undefined) responseHeaders.append(name, value)
      }
      const status = incoming.statusCode ?? 502
      const body = status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
      if (body === null) incoming.resume()
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders
      }))
    })

    const signal = init.signal
    const onAbort = (): void => {
      request.destroy(new Error('LAN HTTPS request was aborted'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.once('error', reject)
    request.once('close', () => signal?.removeEventListener('abort', onAbort))

    const body = init.body
    if (body == null) {
      request.end()
    } else if (typeof body === 'string') {
      request.end(body)
    } else if (body instanceof Uint8Array) {
      request.end(Buffer.from(body))
    } else if (body instanceof ArrayBuffer) {
      request.end(Buffer.from(body))
    } else {
      request.destroy(new Error(`Unsupported LAN HTTPS request body type: ${Object.prototype.toString.call(body)}`))
    }
  })
}

function requestBootstrapIdentity(
  url: URL,
  body: string,
  timeoutMs: number,
  localAddress?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      localAddress,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': Buffer.byteLength(body, 'utf8')
      }
    }, (response) => {
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BOOTSTRAP_RESPONSE_BYTES) {
          request.destroy(new Error('LAN identity challenge response exceeds the size limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        status: response.statusCode ?? 502,
        body: Buffer.concat(chunks).toString('utf8')
      }))
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('LAN identity challenge timed out')))
    request.once('error', reject)
    request.end(body)
  })
}

function randomNonce(): string {
  return randomBytes(24).toString('base64url')
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0 || bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64`)
  return bytes
}

function spkiBase64(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64')
}

function constantTimeBase64Equal(left: string, right: string): boolean {
  try {
    const a = decodeCanonicalBase64(left, 'public key')
    const b = decodeCanonicalBase64(right, 'public key')
    return a.length === b.length && a.length > 0 && a.equals(b)
  } catch {
    return false
  }
}
