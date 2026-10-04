import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { publishWindowsFile } from './windows-durable-publish'

/** 同步文件内容；调用者只有在屏障完成后才能签发耐久回执。 */
export function syncFile(path: string): void {
  const descriptor = openSync(path, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/** POSIX 同步目录；Windows 的发布屏障由 publishDurableFile 的写穿句柄完成。 */
export function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/** 平台真实发布屏障完成之后，调用者才可以提交 receipt 或见证。 */
export function publishDurableFile(source: string, target: string): void {
  if (process.platform === 'win32') { publishWindowsFile(source, target); return }
  syncFile(source)
  renameSync(source, target)
  syncDirectory(dirname(target))
}

/** 同目录写入、flush、原子替换，避免进程中止截断现有密文或见证。 */
export function writeDurableFile(path: string, bytes: string | Uint8Array): void {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    publishDurableFile(temporary, path)
  } finally {
    // 写入/替换失败保留原文件，清除尚未发布的私有临时文件。
    rmSync(temporary, { force: true })
  }
}
