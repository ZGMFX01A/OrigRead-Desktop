import { createSocket } from 'node:dgram'

/** mDNS 使用链路本地端口；UDP connect 只询问系统路由，不发送探测报文。 */
const MDNS_PORT = 5353

/** 广告地址必须属于回复实际使用的网卡，不能把全局首选 VPN 地址广播到 WLAN。 */
export async function mdnsResponseAddresses(remote: { address: string; family: string }): Promise<{
  hostAddress?: string
  hostIpv6Address?: string
}> {
  const routeSocket = createSocket(remote.family === 'IPv6' ? 'udp6' : 'udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      routeSocket.once('error', reject)
      routeSocket.connect(MDNS_PORT, remote.address, resolve)
    })
    const route = routeSocket.address()
    // 只发布 OS 实际选中的同族源地址；多地址网卡与 IPv6 scope 不能按首项反推。
    return route.family === 'IPv6'
      ? { hostAddress: undefined, hostIpv6Address: route.address }
      : { hostAddress: route.address, hostIpv6Address: undefined }
  } finally {
    routeSocket.close()
  }
}
