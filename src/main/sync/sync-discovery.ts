import { createSocket, type Socket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import type { SyncDiagnostic, SyncDiscoveredPeer } from '../../shared/sync-protocol'

export const SYNC_MDNS_SERVICE = '_origread-sync._tcp.local'
const MCAST_ADDRESS = '224.0.0.251'
const MCAST_ADDRESS_V6 = 'ff02::fb'
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
  private sockets: Socket[] = []

  async discover(timeoutMs = 1_500): Promise<SyncDiscoveryResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Discovery timeout must be positive')
    const peers = new Map<string, SyncDiscoveredPeer>()
    const packets: Array<{
      packet: Buffer
      sourceAddress: string
      interfaceName?: string
      localBindAddress?: string
    }> = []
    try {
      const ipv4Socket = createSocket({ type: 'udp4', reuseAddr: true })
      this.sockets.push(ipv4Socket)
      ipv4Socket.on('message', (message, remote) =>
        packets.push({ packet: message, sourceAddress: remote.address }))
      await bindSocket(ipv4Socket)
      const ipv4Interfaces = mdnsIpv4Interfaces()
      if (ipv4Interfaces.length === 0) {
        ipv4Socket.addMembership(MCAST_ADDRESS)
        ipv4Socket.send(buildQuery(SYNC_MDNS_SERVICE), MCAST_PORT, MCAST_ADDRESS)
      } else {
        for (const entry of ipv4Interfaces) {
          try {
            ipv4Socket.addMembership(MCAST_ADDRESS, entry.address)
            ipv4Socket.setMulticastInterface(entry.address)
            ipv4Socket.send(buildQuery(SYNC_MDNS_SERVICE), MCAST_PORT, MCAST_ADDRESS)
          } catch {
            // A disabled adapter must not make discovery fail on every other physical NIC.
          }
        }
      }
      for (const entry of mdnsIpv6Interfaces()) {
        const socket6 = createSocket({ type: 'udp6', reuseAddr: true })
        this.sockets.push(socket6)
        socket6.on('message', (message, remote) => {
          packets.push({
            packet: message,
            sourceAddress: remote.address,
            interfaceName: entry.name,
            localBindAddress: entry.scopedAddress
          })
        })
        try {
          await bindSocket(socket6, '::')
          socket6.setMulticastInterface(entry.scopedAddress)
          socket6.send(buildQuery(SYNC_MDNS_SERVICE), MCAST_PORT, MCAST_ADDRESS_V6)
        } catch {
          try { socket6.close() } catch { /* best effort */ }
          this.sockets = this.sockets.filter((candidate) => candidate !== socket6)
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      for (const item of packets) {
        for (const parsed of parseMdnsPacket(item.packet, item.sourceAddress)) {
          const parsedHostIsIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.host)
          const ipv4Context = parsedHostIsIpv4 ? inferLocalInterfaceForRemote(parsed.host) : null
          const peer = item.localBindAddress
            ? {
                ...parsed,
                interfaceName: parsedHostIsIpv4
                  ? ipv4Context?.name ?? parsed.interfaceName ?? item.interfaceName
                  : item.interfaceName ?? parsed.interfaceName,
                localBindAddress: parsedHostIsIpv4
                  ? ipv4Context?.ipv4Address ?? parsed.localBindAddress
                  : item.localBindAddress
              }
            : parsed
          const key = `mdns:${peer.deviceId}`
          const candidate = { ...peer, endpointId: key }
          const existing = peers.get(key)
          if (!existing || preferMdnsHost(candidate.host, existing.host)) {
            peers.set(key, candidate)
          }
        }
      }
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
    const sockets = this.sockets
    this.sockets = []
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      try { socket.close(() => resolve()) } catch { resolve() }
    })))
  }
}

export interface DesktopMdnsAdvertisementOptions {
  port: number
  deviceId: string
  displayName: string
  discoveryId?: string
  protocol?: 'http' | 'https'
  syncSpaceIds?: string[]
  fingerprint?: string
  hostAddress?: string
  hostIpv6Address?: string
  hostName?: string
}

/**
 * Minimal DNS-SD responder for the Desktop LAN endpoint.
 *
 * The TXT record is discovery metadata only. It never contains a bearer token and it does not grant
 * Sync access; the HTTP endpoint still requires a paired/authenticated device session.
 */
export class DesktopMdnsAdvertisementProvider {
  private sockets: Socket[] = []
  private readonly options: Required<Pick<DesktopMdnsAdvertisementOptions, 'port' | 'deviceId' | 'displayName'>> & DesktopMdnsAdvertisementOptions

  constructor(options: DesktopMdnsAdvertisementOptions) {
    if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) throw new Error('mDNS service port must be valid')
    if (!options.deviceId.trim() || !options.displayName.trim()) throw new Error('mDNS device metadata must not be blank')
    this.options = { protocol: 'http', syncSpaceIds: [], ...options }
  }

  async start(): Promise<void> {
    if (this.sockets.length > 0) return
    const targetHost = `${this.options.hostName ?? hostname()}.local.`
    let firstError: unknown = null

    const ipv4Socket = createSocket({ type: 'udp4', reuseAddr: true })
    try {
      await bindAdvertisementSocket(ipv4Socket, '0.0.0.0')
      ipv4Socket.on('message', (message, remote) => {
        if (!isMdnsServiceOrHostQuery(message, targetHost)) return
        const response = buildMdnsAdvertisement(this.options)
        ipv4Socket.send(response, 0, response.length, remote.port || MCAST_PORT, remote.address)
      })
      const interfaces = mdnsIpv4Interfaces()
      if (interfaces.length === 0) {
        ipv4Socket.addMembership(MCAST_ADDRESS)
      } else {
        for (const entry of interfaces) {
          try { ipv4Socket.addMembership(MCAST_ADDRESS, entry.address) } catch { /* next interface */ }
        }
      }
      ipv4Socket.setMulticastTTL(255)
      ipv4Socket.setMulticastLoopback(true)
      this.sockets.push(ipv4Socket)
    } catch (error) {
      firstError = error
      try { ipv4Socket.close() } catch { /* best effort */ }
    }

    const ipv6Interfaces = mdnsIpv6Interfaces()
    if (ipv6Interfaces.length > 0) {
      const ipv6Socket = createSocket({ type: 'udp6', reuseAddr: true })
      try {
        await bindAdvertisementSocket(ipv6Socket, '::')
        ipv6Socket.on('message', (message, remote) => {
          if (!isMdnsServiceOrHostQuery(message, targetHost)) return
          const response = buildMdnsAdvertisement(this.options)
          ipv6Socket.send(response, 0, response.length, remote.port || MCAST_PORT, remote.address)
        })
        for (const entry of ipv6Interfaces) {
          try { ipv6Socket.addMembership(MCAST_ADDRESS_V6, entry.scopedAddress) } catch { /* next interface */ }
        }
        ipv6Socket.setMulticastLoopback(true)
        this.sockets.push(ipv6Socket)
      } catch (error) {
        firstError ??= error
        try { ipv6Socket.close() } catch { /* best effort */ }
      }
    }

    if (this.sockets.length === 0) {
      throw firstError instanceof Error ? firstError : new Error('No mDNS socket could be opened')
    }
  }

  async close(): Promise<void> {
    const sockets = this.sockets
    this.sockets = []
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      try { socket.close(() => resolve()) } catch { resolve() }
    })))
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

function bindSocket(socket: Socket, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { socket.off('listening', onListening); reject(error) }
    const onListening = (): void => { socket.off('error', onError); resolve() }
    socket.once('error', onError)
    socket.once('listening', onListening)
    if (host) socket.bind(0, host)
    else socket.bind(0)
  })
}

export function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '')
}

function bindAdvertisementSocket(socket: Socket, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { socket.off('listening', onListening); reject(error) }
    const onListening = (): void => { socket.off('error', onError); resolve() }
    socket.once('error', onError)
    socket.once('listening', onListening)
    socket.bind(MCAST_PORT, host)
  })
}

function parseMdnsQuestions(packet: Buffer): Array<{ name: string; type: number; classValue: number }> {
  try {
    if (packet.length < 12) return []
    const qdCount = packet.readUInt16BE(4)
    let offset = 12
    const questions: Array<{ name: string; type: number; classValue: number }> = []
    for (let index = 0; index < qdCount; index++) {
      const qname = readDnsName(packet, offset)
      offset = qname.next
      if (offset + 4 > packet.length) return []
      const type = packet.readUInt16BE(offset)
      const classValue = packet.readUInt16BE(offset + 2)
      offset += 4
      questions.push({ name: normalizeDnsName(qname.value), type, classValue })
    }
    return questions
  } catch {
    return []
  }
}

function isMdnsServiceOrHostQuery(packet: Buffer, targetHostname: string): boolean {
  try {
    const questions = parseMdnsQuestions(packet)
    const normService = normalizeDnsName(SYNC_MDNS_SERVICE)
    const normTarget = normalizeDnsName(targetHostname)
    return questions.some((q) => q.name === normService || q.name === normTarget)
  } catch {
    return false
  }
}

function buildMdnsAdvertisement(options: DesktopMdnsAdvertisementOptions): Buffer {
  const discId = options.discoveryId ?? sanitizeDnsLabel(randomUUID().slice(0, 8))
  const instance = `${discId}.${SYNC_MDNS_SERVICE}`
  const target = `${sanitizeDnsLabel(options.hostName ?? hostname())}.local.`
  const serviceName = encodeDnsName(SYNC_MDNS_SERVICE)
  const instanceName = encodeDnsName(instance)
  const targetName = encodeDnsName(target)
  const txt = encodeTxt([
    `discoveryId=${discId}`,
    `name=${options.displayName}`,
    `tls=${options.protocol === 'https' ? '1' : '0'}`,
    ...(options.fingerprint ? [`fingerprint=${options.fingerprint}`] : []),
  ])
  const additional: Buffer[] = [
    dnsRecord(instanceName, 33, 120, Buffer.concat([u16(0), u16(0), u16(options.port), targetName])),
    dnsRecord(instanceName, 16, 120, txt),
  ]

  // 附加 A 记录 (IPv4)
  const hostAddress = options.hostAddress ?? ''
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostAddress)) {
    const bytes = Buffer.from(hostAddress.split('.').map((part) => Number(part)))
    if (bytes.every((byte) => byte >= 0 && byte <= 255)) {
      additional.push(dnsRecord(targetName, 1, 120, bytes))
    }
  }

  // 附加 AAAA 记录 (IPv6)
  const hostIpv6 = options.hostIpv6Address ?? ''
  if (hostIpv6) {
    const cleanIpv6 = hostIpv6.split('%')[0] ?? ''
    const parsedV6 = parseIpv6Address(cleanIpv6)
    if (parsedV6) {
      additional.push(dnsRecord(targetName, 28, 120, parsedV6))
    }
  }

  const answer = dnsRecord(serviceName, 12, 120, instanceName)
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, additional.length]),
    answer,
    ...additional,
  ])
}

function parseIpv6Address(ip: string): Buffer | null {
  try {
    const clean = ip.split('%')[0] ?? ''
    if (!clean || (clean.match(/::/g)?.length ?? 0) > 1) return null
    const compressed = clean.includes('::')
    const [headRaw = '', tailRaw = ''] = compressed ? clean.split('::') : [clean, '']
    const parseGroups = (raw: string): number[] | null => {
      if (!raw) return []
      const groups: number[] = []
      for (const part of raw.split(':')) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
        groups.push(Number.parseInt(part, 16))
      }
      return groups
    }
    const head = parseGroups(headRaw)
    const tail = parseGroups(tailRaw)
    if (!head || !tail) return null
    const zeroesNeeded = 8 - head.length - tail.length
    if (compressed ? zeroesNeeded < 1 : zeroesNeeded !== 0) return null
    const full = compressed
      ? [...head, ...new Array(zeroesNeeded).fill(0), ...tail]
      : head
    if (full.length !== 8) return null
    const buffer = Buffer.alloc(16)
    for (let i = 0; i < 8; i++) {
      buffer.writeUInt16BE(full[i]!, i * 2)
    }
    return buffer
  } catch {
    return null
  }
}

function dnsRecord(name: Buffer, type: number, ttl: number, data: Buffer): Buffer {
  return Buffer.concat([name, u16(type), u16(1), u32(ttl), u16(data.length), data])
}

function encodeDnsName(value: string): Buffer {
  const labels = value.replace(/\.+$/, '').split('.').filter(Boolean)
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
  const labels = service.replace(/\.+$/, '').split('.')
  const question = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  const name = Buffer.concat([Buffer.from(labels.flatMap((label) => [label.length, ...Buffer.from(label)])), Buffer.from([0])])
  return Buffer.concat([question, name, Buffer.from([0, 12, 0, 1])])
}

export interface ParsedMdnsRecord {
  name: string
  normalizedName: string
  type: number
  classValue: number
  ttl: number
  data: Buffer
  rdataOffset: number
}

export function parseMdnsPacket(packet: Buffer, sourceAddress?: string): SyncDiscoveredPeer[] {
  try {
    if (packet.length < 12) return []
    const qdCount = packet.readUInt16BE(4)
    const anCount = packet.readUInt16BE(6)
    const nsCount = packet.readUInt16BE(8)
    const arCount = packet.readUInt16BE(10)
    let offset = 12

    // 1. 跳过 Question Section，防御带 Question 报文导致解析偏移损坏 (B03)
    for (let i = 0; i < qdCount; i++) {
      const qname = readDnsName(packet, offset)
      offset = qname.next + 4 // QTYPE(2) + QCLASS(2)
      if (offset > packet.length) return []
    }

    // 2. 解析 Answer、Authority 与 Additional Resource Records
    const totalRecords = anCount + nsCount + arCount
    const records: ParsedMdnsRecord[] = []
    for (let index = 0; index < totalRecords; index++) {
      const name = readDnsName(packet, offset)
      offset = name.next
      if (offset + 10 > packet.length) return []
      const type = packet.readUInt16BE(offset)
      const classValue = packet.readUInt16BE(offset + 2)
      const ttl = packet.readUInt32BE(offset + 4)
      const length = packet.readUInt16BE(offset + 8)
      offset += 10
      if (offset + length > packet.length) return []
      const rdataOffset = offset
      const data = packet.subarray(offset, offset + length)
      offset += length
      if ((classValue & 0x7fff) === 1) {
        records.push({
          name: name.value,
          normalizedName: normalizeDnsName(name.value),
          type,
          classValue,
          ttl,
          data,
          rdataOffset,
        })
      }
    }

    const normTargetService = normalizeDnsName(SYNC_MDNS_SERVICE)
    // 3. 尾点归一化比对服务实例 (B02) + 使用全局报文指针解析 PTR target (B03)
    const serviceInstances = records
      .filter((record) => record.type === 12 && record.normalizedName === normTargetService)
      .map((record) => normalizeDnsName(readDnsName(packet, record.rdataOffset).value))

    const peers: SyncDiscoveredPeer[] = []
    for (const instance of serviceInstances) {
      const srv = records.find((record) => record.type === 33 && record.normalizedName === instance)
      const txt = records.find((record) => record.type === 16 && record.normalizedName === instance)
      if (!srv || srv.data.length < 7) continue

      // 从全局报文指针偏移解析 SRV target 域名 (B03)
      const target = normalizeDnsName(readDnsName(packet, srv.rdataOffset + 6).value)
      const port = srv.data.readUInt16BE(4)
      const values = parseTxt(txt?.data)

      // 解析 A 记录 (IPv4) 或 AAAA 记录 (IPv6)
      const aRecord = records.find((record) => record.type === 1 && record.normalizedName === target)
      const aaaaRecord = records.find((record) => record.type === 28 && record.normalizedName === target)
      const localInterface = sourceAddress ? inferLocalInterfaceForRemote(sourceAddress) : null

      let hostName = target
      if (aRecord && aRecord.data.length === 4) {
        hostName = [...aRecord.data].join('.')
      } else if (aaaaRecord && aaaaRecord.data.length === 16) {
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) {
          parts.push(aaaaRecord.data.readUInt16BE(i).toString(16))
        }
        const ipv6 = parts.join(':')
        // WHATWG URL does not reliably round-trip IPv6 zone identifiers. A raw link-local
        // AAAA record without the receiving-interface scope would therefore create an
        // unusable endpoint. Prefer the SRV .local hostname for link-local-only peers;
        // global/ULA IPv6 literals remain safe to use directly.
        hostName = ipv6.toLowerCase().startsWith('fe80:') ? target : ipv6
      }
      const localBindAddress =
        !aRecord && aaaaRecord
          ? localInterface?.ipv6Address ?? localInterface?.ipv4Address
          : localInterface?.ipv4Address ?? localInterface?.ipv6Address

      const deviceId = values.discoveryId ?? values.deviceId ?? instance.split('.')[0] ?? randomUUID()
      peers.push({
        endpointId: `mdns:${deviceId}`,
        deviceId,
        displayName: values.name ?? deviceId,
        host: hostName,
        port,
        protocol: values.tls === '1' ? 'https' : 'http',
        interfaceName: localInterface?.name,
        localBindAddress,
        syncSpaceIds: values.space ? values.space.split(',').filter(Boolean) : [],
        fingerprint: values.fingerprint ?? null,
        capabilities: null,
      })
    }
    return peers
  } catch {
    return []
  }
}

interface MdnsInterfaceContext {
  name: string
  ipv4Address?: string
  ipv6Address?: string
}

function mdnsIpv4Interfaces(): Array<{ name: string; address: string; netmask: string }> {
  const result: Array<{ name: string; address: string; netmask: string }> = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (isVirtualInterfaceName(name)) continue
    for (const addr of addrs ?? []) {
      const family = String(addr.family)
      if (!addr.internal && (family === 'IPv4' || family === '4')) {
        result.push({ name, address: addr.address, netmask: addr.netmask })
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

function mdnsIpv6Interfaces(): Array<{ name: string; address: string; scopedAddress: string; scopeid?: number }> {
  const result: Array<{ name: string; address: string; scopedAddress: string; scopeid?: number }> = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (isVirtualInterfaceName(name)) continue
    for (const addr of addrs ?? []) {
      const family = String(addr.family)
      if (addr.internal || (family !== 'IPv6' && family !== '6')) continue
      const scopeid = (addr as typeof addr & { scopeid?: number }).scopeid
      const scopedAddress =
        addr.address.toLowerCase().startsWith('fe80:') && !addr.address.includes('%') && scopeid
          ? `${addr.address}%${scopeid}`
          : addr.address
      result.push({ name, address: addr.address, scopedAddress, scopeid })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

function inferLocalInterfaceForRemote(remoteAddress: string): MdnsInterfaceContext | null {
  const remoteV4 = ipv4ToInt(remoteAddress)
  if (remoteV4 == null) return null
  const all = networkInterfaces()
  let selectedName: string | null = null
  let selectedIpv4: string | undefined
  for (const [name, addrs] of Object.entries(all)) {
    if (isVirtualInterfaceName(name)) continue
    for (const addr of addrs ?? []) {
      const family = String(addr.family)
      if (addr.internal || (family !== 'IPv4' && family !== '4')) continue
      const local = ipv4ToInt(addr.address)
      const mask = ipv4ToInt(addr.netmask)
      if (local != null && mask != null && (local & mask) === (remoteV4 & mask)) {
        selectedName = name
        selectedIpv4 = addr.address
        break
      }
    }
    if (selectedName) break
  }
  if (!selectedName) return null
  const ipv6 = (all[selectedName] ?? []).find((addr) => {
    const family = String(addr.family)
    return !addr.internal && (family === 'IPv6' || family === '6') && addr.address.toLowerCase().startsWith('fe80:')
  })
  let ipv6Address = ipv6?.address
  const scopeId = ipv6 && 'scopeid' in ipv6 ? Number(ipv6.scopeid) : 0
  if (ipv6Address && !ipv6Address.includes('%') && scopeId > 0) ipv6Address += `%${scopeId}`
  return { name: selectedName, ipv4Address: selectedIpv4, ipv6Address }
}

function preferMdnsHost(candidate: string, current: string): boolean {
  const rank = (host: string): number => {
    const clean = host.split('%')[0] ?? host
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean)) return 0
    if (!clean.includes(':')) return 1
    if (clean.toLowerCase().startsWith('fe80:')) return 3
    return 2
  }
  const candidateRank = rank(candidate)
  const currentRank = rank(current)
  return candidateRank < currentRank ||
    (candidateRank === currentRank && candidate.localeCompare(current) < 0)
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    result = ((result << 8) | n) >>> 0
  }
  return result
}

function isVirtualInterfaceName(name: string): boolean {
  return /^(tun|tap|vpn|wg|utun|tailscale|zerotier|vethernet|docker|br-|vmnet|virbr)/i.test(name)
}

/**
 * 读取 DNS 报文中的域名。
 * 正确处理 RFC 1035 压缩指针：指针基于完整 packet 绝对寻址，防止切片导致越界或错误解析。
 */
export function readDnsName(packet: Uint8Array, start: number): { value: string; next: number } {
  const labels: string[] = []
  let offset = start
  let next = start
  let jumped = false
  let guard = 0
  while (offset < packet.length && guard++ < 128) {
    const length = packet[offset]
    if (length == null) throw new Error('Malformed DNS label')
    if (length === 0) {
      if (!jumped) next = offset + 1
      break
    }
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
