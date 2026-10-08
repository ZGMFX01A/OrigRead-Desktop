import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranslationOwner, TranslationTarget } from '../../shared/translation'
import { translationTargetKey } from '../../shared/translation'

export const TRANSLATION_TTL = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
export type TranslationKind = 'LIST' | 'FULL'
export interface TranslationEntry {
  version: 3
  key: string
  owner: TranslationOwner
  kind: TranslationKind
  sourceHash: string
  target: TranslationTarget
  language: string
  promptVariant: string
  texts: string[]
  sourceLanguage: string | null
  createdAt: number
  expiresAt: number
}
export type TranslationIdentity = Pick<TranslationEntry, 'owner' | 'kind' | 'sourceHash' | 'target' | 'language' | 'promptVariant'>
export const translationHash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const sourceHash = (title: string, content: string): string => translationHash(JSON.stringify([title, content]))
export const entryKey = (value: TranslationIdentity): string => translationHash(JSON.stringify([
  3, value.owner.accountId, value.owner.feedId, value.owner.articleId, value.kind,
  value.sourceHash, translationTargetKey(value.target), value.language, value.promptVariant
]))
const selectionKey = (owner: TranslationOwner, kind: TranslationKind): string => translationHash(JSON.stringify([owner.accountId, owner.feedId, owner.articleId, kind]))

/** Only local I/O is serialized; the network never holds this queue.
 * Reference: npm/write-file-atomic's staged write, fsync, rename and failure cleanup.
 * Single main-process store, no new dependency or resumable-task journal.
 */
export class TranslationCache {
  private tail: Promise<unknown> = Promise.resolve()
  private indexed = false
  private readonly index = new Map<string, { owner: TranslationOwner; bytes: number; createdAt: number; expiresAt: number }>()
  constructor(
    readonly directory: string,
    private readonly ownerExists: (owner: TranslationOwner) => boolean,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 128 * 1024 * 1024,
    private readonly publish: typeof rename = rename
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work)
    this.tail = pending.catch(() => undefined)
    return pending
  }
  async idle(): Promise<void> { await this.tail }
  read(identity: TranslationIdentity): Promise<TranslationEntry | null> {
    return this.serial(() => this.readKey(entryKey(identity)))
  }
  selected(owner: TranslationOwner, kind: TranslationKind): Promise<{ entry: TranslationEntry; show: boolean } | null> {
    return this.serial(async () => {
      if (!this.ownerExists(owner)) return null
      try {
        const file = this.selectionFile(owner, kind)
        if ((await stat(file)).size > 1024) return null
        const selected = JSON.parse(await readFile(file, 'utf8')) as { key: string; show: boolean }
        if (typeof selected.show !== 'boolean') return null
        const entry = await this.readKey(selected.key)
        if (!entry || selectionKey(entry.owner, entry.kind) !== selectionKey(owner, kind)) return null
        return { entry, show: selected.show }
      } catch { return null }
    })
  }
  write(entry: TranslationEntry, valid: () => boolean = () => true): Promise<boolean> {
    return this.serial(async () => {
      if (!valid() || !this.fresh(entry) || !this.ownerExists(entry.owner)) return false
      try {
        await this.initialize()
        const text = JSON.stringify(entry)
        await this.atomic(this.file(entry.key), text, () => valid() && this.ownerExists(entry.owner))
        this.index.set(entry.key, { owner: entry.owner, bytes: Buffer.byteLength(text), createdAt: entry.createdAt, expiresAt: entry.expiresAt })
        await this.atomic(this.selectionFile(entry.owner, entry.kind), JSON.stringify({ key: entry.key, show: true }), () => valid() && this.ownerExists(entry.owner))
        await this.trim()
        if (!valid() || !this.ownerExists(entry.owner)) { await this.remove(entry.key); return false }
        return this.index.has(entry.key)
      } catch { return false }
    })
  }
  select(owner: TranslationOwner, kind: TranslationKind, key: string, show: boolean): Promise<boolean> {
    return this.serial(async () => {
      const entry = await this.readKey(key)
      if (!entry || selectionKey(entry.owner, entry.kind) !== selectionKey(owner, kind)) return false
      try {
        await this.atomic(this.selectionFile(owner, kind), JSON.stringify({ key, show }), () => this.ownerExists(owner))
        return true
      } catch { return false }
    })
  }
  maintain(): Promise<void> {
    return this.serial(async () => {
      await this.initialize()
      for (const [key, metadata] of this.index) {
        if (metadata.expiresAt <= this.now() || !this.ownerExists(metadata.owner)) await this.remove(key)
      }
      await this.trim()
      for (const name of await readdir(this.directory).catch(() => [] as string[])) {
        if (!name.endsWith('.selection.json')) continue
        const file = join(this.directory, name)
        try {
          if ((await stat(file)).size > 1024) { await unlink(file); continue }
          const selected = JSON.parse(await readFile(file, 'utf8')) as { key: string }
          if (!this.index.has(selected.key)) await unlink(file)
        } catch { await unlink(file).catch(() => undefined) }
      }
    })
  }
  private fresh(entry: TranslationEntry): boolean {
    return entry.version === 3 && Number.isFinite(entry.createdAt) && entry.createdAt <= this.now()
      && entry.expiresAt === entry.createdAt + TRANSLATION_TTL && entry.expiresAt > this.now()
  }
  private async readKey(key: string): Promise<TranslationEntry | null> {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return null
    try {
      const info = await stat(this.file(key))
      if (info.size > MAX_ENTRY_BYTES) { await this.remove(key); return null }
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as TranslationEntry
      if (!this.fresh(entry) || entry.key !== key || entryKey(entry) !== key || !['LIST', 'FULL'].includes(entry.kind)
        || !Array.isArray(entry.texts) || entry.texts.some(value => typeof value !== 'string') || !this.ownerExists(entry.owner)) {
        await this.remove(key); return null
      }
      this.index.set(key, { owner: entry.owner, bytes: info.size, createdAt: entry.createdAt, expiresAt: entry.expiresAt })
      return entry
    } catch { return null }
  }
  private async initialize(): Promise<void> {
    if (this.indexed) return
    await mkdir(this.directory, { recursive: true })
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        if (!await this.readKey(name.slice(0, -5))) await unlink(join(this.directory, name)).catch(() => undefined)
      } else if (name.endsWith('.pending')) await unlink(join(this.directory, name)).catch(() => undefined)
    }
    this.indexed = true
  }
  private async trim(): Promise<void> {
    let bytes = [...this.index.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    if (bytes <= this.maxBytes) return
    for (const [key, entry] of [...this.index].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
      if (bytes <= this.maxBytes) break
      if (await this.remove(key)) bytes -= entry.bytes
    }
  }
  private async remove(key: string): Promise<boolean> {
    try { await unlink(this.file(key)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    this.index.delete(key)
    return true
  }
  private file(key: string): string { return join(this.directory, `${key}.json`) }
  private selectionFile(owner: TranslationOwner, kind: TranslationKind): string { return join(this.directory, `${selectionKey(owner, kind)}.selection.json`) }
  private async atomic(file: string, text: string, valid: () => boolean): Promise<void> {
    if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new Error('Translation cache entry too large')
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `${randomUUID()}.pending`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      if (!valid()) throw new Error('Translation owner/request is no longer valid')
      await this.publish(temporary, file)
      if (!valid()) { await unlink(file).catch(() => undefined); throw new Error('Translation owner/request is no longer valid') }
    } finally { await unlink(temporary).catch(() => undefined) }
  }
}
