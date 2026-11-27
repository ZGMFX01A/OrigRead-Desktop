import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, constants, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactSensitiveText } from '../security/sensitive-text'

export function writeAtomicTextFile(filePath: string, content: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) })
    if (mode !== undefined) chmodSync(temporary, mode)
    renameSync(temporary, filePath)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `原子写入失败，临时文件清理失败：${temporary}`)
    }
    throw error
  }
}

export function backupCorruptFileAndThrow(filePath: string, label: string, cause: unknown): never {
  const backup = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`
  const reason = redactSensitiveText(cause instanceof Error ? cause.message : String(cause))
  try {
    copyFileSync(filePath, backup, constants.COPYFILE_EXCL)
  } catch (backupError) {
    throw new Error(`${label}损坏：${reason}；无法备份到 ${backup}，原文件已保留：${redactSensitiveText(String(backupError))}`)
  }
  throw new Error(`${label}损坏：${reason}；已保留原文件并备份到 ${backup}`)
}
