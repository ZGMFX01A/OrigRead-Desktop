/** 保留 IPv6 接口 scope；WHATWG URL 只解析去掉 zone 的地址，Socket 使用原始 scope。 */
export class SyncEndpointUrl extends URL {
  readonly zone: string | null

  constructor(value: string, base?: string) {
    const absolute = /^[a-z]+:\/\//i.test(value) || !base ? value : `${base.replace(/\/$/, '')}${value}`
    const scoped = absolute.match(/^(https?:\/\/\[[0-9a-f:]+)%(?:25)?([A-Za-z0-9_.-]+)(\])/i)
    super(scoped ? absolute.replace(scoped[0], `${scoped[1]}${scoped[3]}`) : absolute)
    this.zone = scoped?.[2] ?? null
    if (this.username || this.password) throw new Error('Sync endpoint must not contain URL credentials')
  }

  /** Node Socket 接受 fe80::1%12，不能把 RFC URL 编码的 %25 原样传给 Socket。 */
  get socketHostname(): string {
    return this.hostname.replace(/^\[|\]$/g, '') + (this.zone ? `%${this.zone}` : '')
  }

  override toString(): string {
    const value = super.toString()
    return this.zone ? value.replace(']', `%25${this.zone}]`) : value
  }
}
