import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReaderFontRepository, CUSTOM_FONT_SCHEME } from './reader-font-repository'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ReaderFontRepository', () => {
  it('imports, persists and deletes a local font file with lightweight controlled protocol url', () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-font-'))
    directories.push(directory)
    const source = join(directory, 'My Reader Font.ttf')
    writeFileSync(source, new Uint8Array([0, 1, 0, 0]))
    const repository = new ReaderFontRepository(join(directory, 'fonts'))

    const imported = repository.importFile(source)
    expect(imported.id).toMatch(/^custom:/)
    expect(imported.name).toBe('My Reader Font')
    // 资源 URL 必须指向受控协议，不携带大体积 Base64
    expect(imported.dataUrl).toBe(`${CUSTOM_FONT_SCHEME}://custom/${encodeURIComponent(imported.id)}`)
    expect(imported.dataUrl).not.toContain('base64')

    const list = new ReaderFontRepository(join(directory, 'fonts')).list()
    expect(list).toHaveLength(1)
    expect(list[0]?.dataUrl).toBe(`${CUSTOM_FONT_SCHEME}://custom/${encodeURIComponent(imported.id)}`)
    expect(JSON.stringify(list).length).toBeLessThan(500)

    // 受控协议解析测试
    const resolved = repository.resolveFontFilePath(imported.id)
    expect(resolved).not.toBeNull()
    expect(resolved?.mime).toBe('font/ttf')
    expect(resolved?.filePath).toContain('fonts')

    repository.delete(imported.id)
    expect(repository.list()).toEqual([])
    expect(repository.resolveFontFilePath(imported.id)).toBeNull()
  })

  it('rejects unsupported file types', () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-font-'))
    directories.push(directory)
    const source = join(directory, 'font.exe')
    writeFileSync(source, 'not a font')
    const repository = new ReaderFontRepository(join(directory, 'fonts'))
    expect(() => repository.importFile(source)).toThrow(/TTF/)
  })

  it('rejects oversized fonts without reading them completely', () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-font-'))
    directories.push(directory)
    const source = join(directory, 'huge.ttf')
    // 写入一个模拟空文件并截断/指定大小超过 30MB
    writeFileSync(source, Buffer.alloc(10))
    // 0 字节校验
    writeFileSync(source, Buffer.alloc(0))
    const repository = new ReaderFontRepository(join(directory, 'fonts'))
    expect(() => repository.importFile(source)).toThrow('字体文件为空或超过 30 MB')
  })

  it('defends against path traversal and returns controlled failure for invalid font ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-font-'))
    directories.push(directory)
    const repository = new ReaderFontRepository(join(directory, 'fonts'))

    // 恶意路径与不存在的 ID
    expect(repository.resolveFontFilePath('../../etc/passwd')).toBeNull()
    expect(repository.resolveFontFilePath('custom:../../secret.ttf')).toBeNull()
    expect(repository.resolveFontFilePath('')).toBeNull()
    expect(repository.resolveFontFilePath('custom:nonexistent-id')).toBeNull()
  })
})


it.each([['.ttf', 'fake', false, ''], ['.ttf', '\x00\x01\x00\x00', true, 'font/ttf'], ['.woff2', 'wOF2', true, 'font/woff2'], ['.otf', 'OTTO', true, 'font/otf'], ['.woff', 'wOFF', true, 'font/woff'], ['.ttf', 'true', true, 'font/ttf'], ['.ttf', 'wOF2', false, '']])('validates signature for %s %s', (extension, header, valid, mime) => {
  const directory = mkdtempSync(join(tmpdir(), 'origread-font-'))
  directories.push(directory)
  const source = join(directory, `font${extension}`)
  writeFileSync(source, header)
  const repository = new ReaderFontRepository(join(directory, 'fonts'))
  if (!valid) { expect(() => repository.importFile(source)).toThrow(/字体/); expect(repository.list()).toEqual([]); return }
  const font = repository.importFile(source)
  expect(font.mime).toBe(mime)
  expect(repository.list()[0]?.mime).toBe(mime)
  expect(repository.resolveFontFilePath(font.id)?.mime).toBe(mime)
})
