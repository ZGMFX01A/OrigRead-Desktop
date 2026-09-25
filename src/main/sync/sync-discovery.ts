import { createSocket, type Socket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { SyncDiagnostic, SyncDiscoveredPeer } from '../../shared/sync-protocol'

export const SYNC_MDNS_SERVICE = '_origread-sync._tcp.local'
const MCAST_ADDRESS = '224.0.0.251'
const MCAST_PORT = 5353

export interface SyncDiscoveryResult {
  peers: SyncDiscoveredPeer[]
  diagnostic: SyncDiagnostic | null
}

export interface SyncDiscoveryProvider {
  discover(timeoutMs?: number): Promise<SyncDiscoveryResult>
  close(): Promise<void>
}

/** Desktop mDNS/DNS-SD discovery. It only discovers endpoints; authentication still happens in Sync Core. */
export class DesktopMdnsDiscoveryProvider implements SyncDiscoveryProvider {
  private socket: Socket | null = null

  async discover(timeoutMs = 1_500): Promise<SyncDiscoveryResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Discovery timeout must be positive')
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    const peers = new Map<string, SyncDiscoveredPeer>()
    const packets: Buffer[] = []
    socket.on('message', (message) => packets.push(message))
    try {
      await bindSocket(socket)
      socket.addMembership(MCAST_ADDRESS)
      socket.send(buildQuery(SYNC_MDNS_SERVICE), MCAST_PORT, MCAST_ADDRESS)
      await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      for (const packet of packets) for (const peer of parseMdnsPacket(packet)) peers.set(peer.endpointId, peer)
      const values = [...peers.values()].sort((left, right) => left.endpointId.localeCompare(right.endpointId))
      return {
        peers: values,
        diagnostic: values.length === 0 ? {
          code: 'DISCOVERY_EMPTY', message: 'No OrigRead Sync peer was announced on the local network',
          retryable: true, at: Date.now()
        } : null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        peers: [],
        diagnostic: {
          code: message.toLowerCase().includes('permission') ? 'PERMISSION_DENIED' : 'PEER_UNREACHABLE',
          message, retryable: true, at: Date.now()
        }
      }
    } finally {
      await this.close()
    }
  }

  async close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => {
      try { socket.close(() => resolve()) } catch { resolve() }
    })
  }
}

export interface DesktopMdnsAdvertisementOptions {
  port: number
  deviceId: string
  displayName: string
  protocol?: 'http' | 'https'
  syncSpaceIds?: string[]
  fingerprint?: string
  hostAddress?: string
  hostName?: string
}

/**
 * Minimal DNS-SD responder for the Desktop LAN endpoint.
 *
 * The TXT record is discovery metadata only. It never contains a bearer token and it does not grant
 * Sync access; the HTTP endpoint still requires a paired/authenticated device session.
 */
export class DesktopMdnsAdvertisementProvider {
  private socket: Socket | null = null
  private readonly options: Required<Pick<DesktopMdnsAdvertisementOptions, 'port' | 'deviceId' | 'displayName'>> & DesktopMdnsAdvertisementOptions

  constructor(options: DesktopMdnsAdvertisementOptions) {
    if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) throw new Error('mDNS service port must be valid')
    if (!options.deviceId.trim() || !options.displayName.trim()) throw new Error('mDNS device metadata must not be blank')
    this.options = { protocol: 'http', syncSpaceIds: [], ...options }
  }

  async start(): Promise<void> {
    if (this.socket) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (message, remote) => {
      if (!isMdnsServiceQuery(message)) return
      const response = buildMdnsAdvertisement(this.options)
      socket.send(response, 0, response.length, remote.port || MCAST_PORT, remote.address)
    })
    try {
      await bindAdvertisementSocket(socket)
      socket.addMembership(MCAST_ADDRESS)
      socket.setMulticastTTL(255)
      socket.setMulticastLoopback(true)
    } catch (error) {
      this.socket = null
      try { socket.close() } catch { /* best effort */ }
      throw error
    }
  }

  async close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => {
      try { socket.close(() => resolve()) } catch { resolve() }
    })
  }
}

export class ManualSyncDiscoveryProvider implements SyncDiscoveryProvider {
  constructor(private readonly url: string, private readonly displayName = 'Manual Sync endpoint') {}

  async discover(): Promise<SyncDiscoveryResult> {
    const parsed = new URL(this.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { peers: [], diagnostic: { code: 'ROUTE_CONFLICT', message: 'Manual Sync endpoint must use http or https', retryable: false, at: Date.now() } }
    }
    return {
      peers: [{
        endpointId: `manual:${parsed.toString()}`,
        deviceId: 'unknown-until-handshake', displayName: this.displayName,
        host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
        protocol: parsed.protocol.slice(0, -1) as 'http' | 'https', syncSpaceIds: [], fingerprint: null, capabilities: null
      }], diagnostic: null
    }
  }

  async close(): Promise<void> { return undefined }
}

function bindSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { socket.off('listening', onListening); reject(error) }
    const onListening = (): void => { socket.off('error', onError); resolve() }
    socket.once('error', onError)
    socket.once('listening', onListening)
    socket.bind(0)
  })
}

function bindAdvertisementSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { socket.off('listening', onListening); reject(error) }
    const onListening = (): void => { socket.off('error', onError); resolve() }
    socket.once('error', onError)
    socket.once('listening', onListening)
    socket.bind(MCAST_PORT, '0.0.0.0')
  })
}

function isMdnsServiceQuery(packet: Buffer): boolean {
  try {
    if (packet.length < 12 || packet.readUInt16BE(4) === 0) return false
    const name = readDnsName(packet, 12)
    return name.value.replace(/\.$/, '') === SYNC_MDNS_SERVICE.replace(/\.$/, '')
  } catch {
    return false
  }
}

function buildMdnsAdvertisement(options: DesktopMdnsAdvertisementOptions): Buffer {
  const instance = `${sanitizeDnsLabel(options.deviceId)}.${SYNC_MDNS_SERVICE}`
  const target = `${sanitizeDnsLabel(options.hostName ?? hostname())}.local.`
  const serviceName = encodeDnsName(SYNC_MDNS_SERVICE)
  const instanceName = encodeDnsName(instance)
  const targetName = encodeDnsName(target)
  const txt = encodeTxt([
    `deviceId=${options.deviceId}`,
    `name=${options.displayName}`,
    `tls=${options.protocol === 'https' ? '1' : '0'}`,
    ...((options.syncSpaceIds ?? []).length > 0 ? [`space=${(options.syncSpaceIds ?? []).slice(0, 8).join(',')}`] : []),
    ...(options.fingerprint ? [`fingerprint=${options.fingerprint}`] : []),
  ])
  const additional: Buffer[] = [
    dnsRecord(instanceName, 33, 120, Buffer.concat([u16(0), u16(0), u16(options.port), targetName])),
    dnsRecord(instanceName, 16, 120, txt),
  ]
  const hostAddress = options.hostAddress ?? ''
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostAddress)) {
    const bytes = Buffer.from(hostAddress.split('.').map((part) => Number(part)))
    if (bytes.every((byte) => byte >= 0 && byte <= 255)) additional.push(dnsRecord(targetName, 1, 120, bytes))
  }
  const answer = dnsRecord(serviceName, 12, 120, instanceName)
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, additional.length]),
    answer,
    ...additional,
  ])
}

function dnsRecord(name: Buffer, type: number, ttl: number, data: Buffer): Buffer {
  return Buffer.concat([name, u16(type), u16(1), u32(ttl), u16(data.length), data])
}

function encodeDnsName(value: string): Buffer {
  const labels = value.replace(/\.$/, '').split('.').filter(Boolean)
  const parts: Buffer[] = []
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 63) throw new Error('DNS label is too long')
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function encodeTxt(values: string[]): Buffer {
  return Buffer.concat(values.map((value) => {
    const bytes = Buffer.from(value.slice(0, 254), 'utf8')
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  }))
}

function sanitizeDnsLabel(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 59)
  return sanitized || randomUUID().replaceAll('-', '').slice(0, 16)
}

function u16(value: number): Buffer { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer }
function u32(value: number): Buffer { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer }

function buildQuery(service: string): Buffer {
  const labels = service.split('.')
  const question = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  const name = Buffer.concat([Buffer.from(labels.flatMap((label) => [label.length, ...Buffer.from(label)])), Buffer.from([0])])
  return Buffer.concat([question, name, Buffer.from([0, 12, 0, 1])])
}

function parseMdnsPacket(packet: Buffer): SyncDiscoveredPeer[] {
  // mDNS packets are intentionally parsed defensively. A malformed local broadcast is ignored;
  // discovery remains usable through the manual fallback without exposing arbitrary data.
  try {
    if (packet.length < 12) return []
    const answerCount = packet.readUInt16BE(6)
    const additionalCount = packet.readUInt16BE(10)
    let offset = 12
    const records: Array<{ name: string; type: number; data: Buffer }> = []
    for (let index = 0; index < answerCount + additionalCount; index++) {
      const name = readDnsName(packet, offset)
      offset = name.next
      if (offset + 10 > packet.length) return []
      const type = packet.readUInt16BE(offset)
      const classValue = packet.readUInt16BE(offset + 2)
      const length = packet.readUInt16BE(offset + 8)
      offset += 10
      if (offset + length > packet.length) return []
      if ((classValue & 0x7fff) === 1) records.push({ name: name.value, type, data: packet.subarray(offset, offset + length) })
      offset += length
    }
    const serviceInstances = records.filter((record) => record.type === 12 && record.name === SYNC_MDNS_SERVICE)
      .map((record) => readDnsName(record.data, 0).value)
    const peers: SyncDiscoveredPeer[] = []
    for (const instance of serviceInstances) {
      const srv = records.find((record) => record.type === 33 && record.name === instance)
      const txt = records.find((record) => record.type === 16 && record.name === instance)
      if (!srv || srv.data.length < 7) continue
      const target = readDnsName(srv.data, 6).value.replace(/\.$/, '')
      const port = srv.data.readUInt16BE(4)
      const values = parseTxt(txt?.data)
      const host = records.find((record) => record.type === 1 && record.name.replace(/\.$/, '') === target)?.data
      const hostName = host && host.length === 4 ? [...host].join('.') : target
      const deviceId = values.deviceId ?? instance.split('.')[0] ?? randomUUID()
      peers.push({
        endpointId: `mdns:${deviceId}:${hostName}:${port}`,
        deviceId, displayName: values.name ?? deviceId, host: hostName, port,
        protocol: values.tls === '1' ? 'https' : 'http',
        syncSpaceIds: values.space ? values.space.split(',').filter(Boolean) : [],
        fingerprint: values.fingerprint ?? null, capabilities: null
      })
    }
    return peers
  } catch {
    return []
  }
}

function readDnsName(packet: Uint8Array, start: number): { value: string; next: number } {
  const labels: string[] = []
  let offset = start
  let next = start
  let jumped = false
  let guard = 0
  while (offset < packet.length && guard++ < 128) {
    const length = packet[offset]
    if (length == null) throw new Error('Malformed DNS label')
    if (length === 0) { next = jumped ? next : offset + 1; break }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('Malformed DNS pointer')
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1]!
      if (!jumped) next = offset + 2
      offset = pointer
      jumped = true
      continue
    }
    offset++
    if (offset + length > packet.length) throw new Error('Malformed DNS label length')
    labels.push(Buffer.from(packet.subarray(offset, offset + length)).toString('utf8'))
    offset += length
    if (!jumped) next = offset
  }
  return { value: `${labels.join('.')}.`, next }
}

function parseTxt(data: Buffer | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!data) return result
  let offset = 0
  while (offset < data.length) {
    const length = data[offset++] ?? 0
    const value = data.subarray(offset, offset + length).toString('utf8')
    offset += length
    const separator = value.indexOf('=')
    if (separator > 0) result[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return result
}
