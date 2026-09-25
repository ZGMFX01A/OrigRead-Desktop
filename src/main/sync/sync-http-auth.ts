import { createHash } from 'node:crypto'

/** 发送方设备 ID 请求头名称 */
export const HEADER_DEVICE_ID = 'x-sync-device-id'

/** 发送方毫秒时间戳请求头名称 */
export const HEADER_TIMESTAMP = 'x-sync-timestamp'

/** 随机 Nonce 请求头名称 */
export const HEADER_NONCE = 'x-sync-nonce'

/** ECDSA P-256 数字签名 Base64 请求头名称 */
export const HEADER_SIGNATURE = 'x-sync-signature'

/** 最大允许的时钟漂移偏差（毫秒），默认 5 分钟 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

/** 空请求体的 SHA-256 小写十六进制摘要值 */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * 计算 Buffer 或字符串的 SHA-256 小写十六进制哈希。
 *
 * @param data 待计算数据（Buffer、Uint8Array 或字符串）
 * @returns 64 位十六进制小写字符串
 */
export function sha256Hex(data?: Buffer | Uint8Array | string | null): string {
  if (!data || (typeof data === 'string' && data.length === 0) || (data instanceof Uint8Array && data.byteLength === 0)) {
    return EMPTY_BODY_SHA256
  }
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 构建规范化的 HTTP 请求签名材料。
 *
 * 格式：
 * ```text
 * $method\n$path\n$timestamp\n$nonce\n$bodySha256
 * ```
 *
 * @param method HTTP 请求方法（大写，如 GET, POST）
 * @param path 请求目标路径和查询参数（如 /v1/spaces/space-1/operations?ranges=%5B%5D）
 * @param timestamp 请求头中的时间戳字符串
 * @param nonce 请求头中的随机 Nonce 字符串
 * @param bodySha256 请求体的 SHA-256 小写十六进制摘要
 * @returns 规范待签名字符串
 */
export function canonicalSigningMaterial(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodySha256: string
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodySha256}`
}

/**
 * 内存 Nonce 查重与防重放缓存。
 */
export class SyncNonceCache {
  private readonly cache = new Map<string, number>()

  constructor(private readonly expirationMs: number = 2 * MAX_CLOCK_SKEW_MS) {}

  /**
   * 检查 Nonce 是否已存在。若不存在则记录并返回 true；若已存在则返回 false。
   *
   * @param nonce 请求中携带的 Nonce
   * @param now 当前时间戳（毫秒）
   * @returns true 表示合法新 Nonce，false 表示检测到重放
   */
  checkAndRecord(nonce: string, now: number = Date.now()): boolean {
    this.cleanupExpired(now)
    if (this.cache.has(nonce)) return false
    this.cache.set(nonce, now)
    return true
  }

  /**
   * 清理过期 Nonce 条目。
   */
  cleanupExpired(now: number = Date.now()): void {
    if (this.cache.size > 1000) {
      const cutoff = now - this.expirationMs
      for (const [nonce, timestamp] of this.cache.entries()) {
        if (timestamp < cutoff) this.cache.delete(nonce)
      }
    }
  }

  /**
   * 清空缓存（测试复位使用）。
   */
  clear(): void {
    this.cache.clear()
  }
}
