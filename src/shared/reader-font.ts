export interface ReaderFontEntry {
  id: string
  name: string
  cssFamily: string
  source: 'custom'
  dataUrl: string
}

export interface ReaderFontFileResult {
  ok: boolean
  cancelled: boolean
  font: ReaderFontEntry | null
  error: string | null
}

export const BUILTIN_READER_FONTS = [
  { id: 'system', nameKey: 'readerFontSystem', cssFamily: 'inherit' },
  { id: 'sans', nameKey: 'readerFontSans', cssFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif' },
  { id: 'serif', nameKey: 'readerFontSerif', cssFamily: 'ui-serif, Georgia, "Times New Roman", "Songti SC", SimSun, serif' },
  { id: 'mono', nameKey: 'readerFontMono', cssFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace' }
] as const

