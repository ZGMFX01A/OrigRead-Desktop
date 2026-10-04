import { SYNC_COMPATIBILITY_VERSION } from '../../shared/sync-protocol'

// LAN 请求级兼容声明，避免旧客户端绕过协商直接读写业务数据。
export const SYNC_COMPATIBILITY_HEADER = 'x-sync-compatibility-version'

/** 兼容号独立于应用版本；缺失或不同版本明确拒绝，不降级旧传输。 */
export function requireSyncCompatibility(remoteVersion: unknown): void {
  if (remoteVersion !== SYNC_COMPATIBILITY_VERSION) {
    throw new Error(`SYNC_VERSION_MISMATCH: 同步协议不兼容，请升级两台设备后重试（本机 ${SYNC_COMPATIBILITY_VERSION}，对端 ${remoteVersion ?? '未声明'}）`)
  }
}

/** 请求头必须是规范整数值，多值/重复头不能算作有效声明。 */
export function requireSyncCompatibilityHeader(value: unknown): void {
  requireSyncCompatibility(value === String(SYNC_COMPATIBILITY_VERSION) ? SYNC_COMPATIBILITY_VERSION : null)
}
