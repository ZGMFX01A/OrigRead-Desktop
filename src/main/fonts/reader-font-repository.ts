import { basename, extname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ReaderFontEntry } from '../../shared/reader-font'

interface StoredReaderFont {
  id: string
  name: string
  cssFamily: string
  fileName: string
}

const ALLOWED_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2'])
const MAX_FONT_BYTES = 30 * 1024 * 1024

export class ReaderFontRepository {
  private readonly registryPath: string

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    this.registryPath = join(directory, 'registry.json')
  }

  list(): ReaderFontEntry[] {
    return this.load().flatMap((font) => {
      const path = join(this.directory, font.fileName)
      if (!existsSync(path)) return []
      const bytes = readFileSync(path)
      return [{
        id: font.id,
        name: font.name,
        cssFamily: font.cssFamily,
        source: 'custom' as const,
        dataUrl: `data:${mimeForExtension(extname(font.fileName))};base64,${bytes.toString('base64')}`
      }]
    })
  }

  importFile(sourcePath: string): ReaderFontEntry {
    const extension = extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('仅支持 TTF / OTF / WOFF / WOFF2 字体文件')
    const sourceBytes = readFileSync(sourcePath)
    if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > MAX_FONT_BYTES) throw new Error('字体文件为空或超过 30 MB')
    const id = `custom:${randomUUID()}`
    const fileName = `${id.slice('custom:'.length)}${extension}`
    const displayName = basename(sourcePath, extension).trim() || 'Custom Font'
    const cssFamily = `OrigReadCustom_${id.slice('custom:'.length).replaceAll('-', '_')}`
    copyFileSync(sourcePath, join(this.directory, fileName))
    const registry = this.load()
    registry.push({ id, name: displayName, cssFamily, fileName })
    this.save(registry)
    return this.list().find((font) => font.id === id)!
  }

  delete(id: string): void {
    if (!id.startsWith('custom:')) throw new Error('内置字体不能删除')
    const registry = this.load()
    const target = registry.find((font) => font.id === id)
    if (!target) return
    rmSync(join(this.directory, target.fileName), { force: true })
    this.save(registry.filter((font) => font.id !== id))
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

function mimeForExtension(extension: string): string {
  if (extension === '.woff2') return 'font/woff2'
  if (extension === '.woff') return 'font/woff'
  if (extension === '.otf') return 'font/otf'
  return 'font/ttf'
}
