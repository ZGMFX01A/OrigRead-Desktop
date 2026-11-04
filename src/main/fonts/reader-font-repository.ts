import { basename, extname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ReaderFontEntry } from '../../shared/reader-font'

export interface StoredReaderFont {
  id: string
  name: string
  cssFamily: string
  fileName: string
}

const ALLOWED_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2'])
const MAX_FONT_BYTES = 30 * 1024 * 1024

export const CUSTOM_FONT_SCHEME = 'origread-font'

export function toCustomFontProtocolUrl(fontId: string): string {
  return `${CUSTOM_FONT_SCHEME}://custom/${encodeURIComponent(fontId)}`
}

export class ReaderFontRepository {
  private readonly registryPath: string

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    this.registryPath = join(directory, 'registry.json')
  }

  /**
   * 字体列表只返回元数据和受控资源协议 URL，不读取文件内容或转为 Base64，
   * 避免多字体时跨进程传输数兆大对象。
   */
  list(): ReaderFontEntry[] {
    return this.load().flatMap((font) => {
      const path = join(this.directory, font.fileName)
      if (!existsSync(path)) return []
      return [{
        id: font.id,
        name: font.name,
        cssFamily: font.cssFamily,
        source: 'custom' as const,
        dataUrl: toCustomFontProtocolUrl(font.id)
      }]
    })
  }

  /**
   * 导入前通过 statSync 预检文件大小，避免将超大文件先完整读入内存；
   * 导入完成后仅组装新字体元数据，不再扫描或加载其他字体。
   */
  importFile(sourcePath: string): ReaderFontEntry {
    const extension = extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('仅支持 TTF / OTF / WOFF / WOFF2 字体文件')
    const stats = statSync(sourcePath)
    if (stats.size === 0 || stats.size > MAX_FONT_BYTES) throw new Error('字体文件为空或超过 30 MB')

    const id = `custom:${randomUUID()}`
    const fileName = `${id.slice('custom:'.length)}${extension}`
    const displayName = basename(sourcePath, extension).trim() || 'Custom Font'
    const cssFamily = `OrigReadCustom_${id.slice('custom:'.length).replaceAll('-', '_')}`

    copyFileSync(sourcePath, join(this.directory, fileName))
    const registry = this.load()
    registry.push({ id, name: displayName, cssFamily, fileName })
    this.save(registry)

    return {
      id,
      name: displayName,
      cssFamily,
      source: 'custom',
      dataUrl: toCustomFontProtocolUrl(id)
    }
  }

  delete(id: string): void {
    if (!id.startsWith('custom:')) throw new Error('内置字体不能删除')
    const registry = this.load()
    const target = registry.find((font) => font.id === id)
    if (!target) return
    rmSync(join(this.directory, target.fileName), { force: true })
    this.save(registry.filter((font) => font.id !== id))
  }

  /**
   * 受控本地协议根据字体 ID 检索资源；严格校验注册表文件名与扩展名，
   * 绝不接受任意磁盘路径或路径穿越。
   */
  resolveFontFilePath(fontId: string): { filePath: string; mime: string } | null {
    if (!fontId || typeof fontId !== 'string') return null
    const registry = this.load()
    const target = registry.find((font) => font.id === fontId)
    if (!target) return null

    // 防止注册表篡改引起的路径穿越
    if (basename(target.fileName) !== target.fileName) return null
    const extension = extname(target.fileName).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) return null

    const fullPath = join(this.directory, target.fileName)
    if (!existsSync(fullPath)) return null

    return {
      filePath: fullPath,
      mime: mimeForExtension(extension)
    }
  }

  private load(): StoredReaderFont[] {
    if (!existsSync(this.registryPath)) return []
    try {
      const value = JSON.parse(readFileSync(this.registryPath, 'utf8')) as unknown
      if (!Array.isArray(value)) return []
      return value.filter(isStoredReaderFont)
    } catch {
      return []
    }
  }

  private save(value: StoredReaderFont[]): void {
    writeFileSync(this.registryPath, JSON.stringify(value, null, 2), 'utf8')
  }
}

function isStoredReaderFont(value: unknown): value is StoredReaderFont {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id.startsWith('custom:')
    && typeof record.name === 'string' && typeof record.cssFamily === 'string' && typeof record.fileName === 'string'
}

export function mimeForExtension(extension: string): string {
  if (extension === '.woff2') return 'font/woff2'
  if (extension === '.woff') return 'font/woff'
  if (extension === '.otf') return 'font/otf'
  return 'font/ttf'
}
