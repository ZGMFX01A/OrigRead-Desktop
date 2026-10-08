import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranslationCache, TRANSLATION_TTL, entryKey, sourceHash, type TranslationEntry, type TranslationIdentity } from './translation-cache'

describe('local translation persistence', () => {
  let directory: string
  let now: number
  let alive: boolean
  const identity: TranslationIdentity = { owner: { accountId: 1, feedId: 'feed', articleId: 'article' }, kind: 'LIST',
    sourceHash: sourceHash('Title', 'Preview'), target: { type: 'traditional', provider: 'DEEPL' }, language: 'zh-CN', promptVariant: '' }
  const record = (): TranslationEntry => ({ ...identity, version: 3, key: entryKey(identity), texts: ['标题', '摘要'], sourceLanguage: 'en', createdAt: now, expiresAt: now + TRANSLATION_TTL })
  const store = (): TranslationCache => new TranslationCache(directory, () => alive, () => now)
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'origread-translation-cache-')); now = Date.now(); alive = true })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('reopens files and preserves original selection without renewing expiry', async () => {
    const entry = record(); const first = store()
    expect(await first.write(entry)).toBe(true)
    expect(await first.select(identity.owner, 'LIST', entry.key, false)).toBe(true)
    now += 1000
    const reopened = store()
    expect(await reopened.read(identity)).toEqual(entry)
    expect(await reopened.selected(identity.owner, 'LIST')).toEqual({ entry, show: false })
    now = entry.expiresAt
    expect(await reopened.read(identity)).toBeNull()
    await reopened.maintain()
    expect(await readdir(directory)).toEqual([])
  })
  it('separates account, article, input, target, language and LIST/FULL', async () => {
    const cache = store(); await cache.write(record())
    const variants: TranslationIdentity[] = [
      { ...identity, owner: { ...identity.owner, accountId: 2 } },
      { ...identity, owner: { ...identity.owner, articleId: 'other' } },
      { ...identity, kind: 'FULL' }, { ...identity, sourceHash: sourceHash('Changed', 'Preview') },
      { ...identity, language: 'ja' }, { ...identity, target: { type: 'traditional', provider: 'MICROSOFT' } },
      { ...identity, promptVariant: 'changed-skill' }
    ]
    for (const variant of variants) expect(await cache.read(variant)).toBeNull()
    expect(await cache.read(identity)).not.toBeNull()
  })
  it('refuses deleted owners and removes both result and selection', async () => {
    const cache = store(); await cache.write(record()); alive = false
    expect(await cache.read(identity)).toBeNull()
    expect(await cache.write(record())).toBe(false)
    await cache.maintain()
    expect(await readdir(directory)).toEqual([])
  })
  it('keeps the prior value and removes temporary files on rename failure', async () => {
    const old = record(); await store().write(old)
    const failing = new TranslationCache(directory, () => alive, () => now, undefined, async () => { throw new Error('disk error') })
    expect(await failing.write({ ...old, texts: ['replacement', 'replacement'] })).toBe(false)
    expect(await store().read(identity)).toEqual(old)
    expect((await readdir(directory)).some(name => name.endsWith('.pending'))).toBe(false)
  })
  it('rejects corrupt JSON and interrupted writes when reopened', async () => {
    const entry = record(); await store().write(entry)
    await writeFile(join(directory, `${entry.key}.json`), '{partial')
    await writeFile(join(directory, 'interrupted.pending'), 'partial')
    const reopened = store(); await reopened.maintain()
    expect(await reopened.read(identity)).toBeNull()
    expect(await readdir(directory)).toEqual([])
  })
  it('does not write when a request was already cancelled', async () => {
    expect(await store().write(record(), () => false)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  })
  it('evicts oldest translations within a small test capacity', async () => {
    const first = record(); const bytes = Buffer.byteLength(JSON.stringify(first))
    const cache = new TranslationCache(directory, () => alive, () => now, bytes + 200)
    await cache.write(first); now += 100
    const secondIdentity = { ...identity, owner: { ...identity.owner, articleId: 'second' } }
    const second = { ...record(), ...secondIdentity, key: entryKey(secondIdentity) }
    expect(await cache.write(second)).toBe(true)
    expect(await cache.read(identity)).toBeNull()
    expect(await cache.read(secondIdentity)).toEqual(second)
  })
  it('does not accept traversal in a damaged selection', async () => {
    await store().write(record())
    const selection = (await readdir(directory)).find(name => name.endsWith('.selection.json'))!
    await writeFile(join(directory, selection), JSON.stringify({ key: '../private', show: true }))
    expect(await store().selected(identity.owner, 'LIST')).toBeNull()
    expect((await readFile(join(directory, `${entryKey(identity)}.json`), 'utf8')).length).toBeGreaterThan(0)
  })
})
