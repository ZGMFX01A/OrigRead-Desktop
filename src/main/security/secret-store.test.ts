import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { ElectronSecretStore } from './secret-store'

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString())
} }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) }
})
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'batch2b-secrets-'))
  dirs.push(dir)
  const file = join(dir, 'nested', 'secrets.json')
  return { dir, file, store: new ElectronSecretStore(file) }
}
describe('ElectronSecretStore persistence boundaries', () => {
  it('initializes missing/empty objects and commits via same-directory temporary file and rename', () => {
    const { file, store } = setup()
    expect(store.get('missing')).toBe('')
    store.restoreSnapshot({})
    store.put('first', 'old')
    store.put('second', 'new')
    expect(store.get('first')).toBe('old')
    const call = vi.mocked(renameSync).mock.calls.at(-1)!
    expect(call[0]).toMatch(/secrets\.json\.tmp-\d+-/)
    expect(call[1]).toBe(file)
    expect(vi.mocked(writeFileSync).mock.calls.some((args) => String(args[0]).includes('.tmp-') && typeof args[2] === 'object' && args[2]?.mode === 0o600)).toBe(true)
    expect(readdirSync(join(file, '..'))).toEqual(['secrets.json'])
  })
  it('keeps old bytes and removes temporary output when rename fails', () => {
    const { file, store } = setup()
    store.put('first', 'old')
    const raw = readFileSync(file, 'utf8')
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('rename blocked') })
    expect(() => store.put('second', 'new')).toThrow('rename blocked')
    expect(readFileSync(file, 'utf8')).toBe(raw)
    expect(readdirSync(join(file, '..'))).toEqual(['secrets.json'])
  })
  it.each(['{broken', '[]', 'null', '{"key":42}'])('preserves corrupt state and refuses writes: %s', (raw) => {
    const { file, store } = setup()
    store.restoreSnapshot({})
    writeFileSync(file, raw)
    expect(() => store.get('key')).toThrow(/密钥存储文件损坏.*corrupt-/)
    expect(() => store.put('new', 'new')).toThrow(/损坏/)
    expect(readFileSync(file, 'utf8')).toBe(raw)
    const backups = readdirSync(join(file, '..')).filter((name) => name.includes('.corrupt-'))
    expect(backups.length).toBeGreaterThan(0)
    for (const name of backups) expect(readFileSync(join(file, '..', name), 'utf8')).toBe(raw)
  })
  it('reports unavailable encryption and decryption failures without hiding configured secrets', () => {
    const { file, store } = setup()
    store.put('first', 'old')
    const raw = readFileSync(file, 'utf8')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(store.get('missing')).toBe('')
    expect(() => store.get('first')).toThrow('无法解密')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => { throw new Error('apiKey=hidden decrypt failed') })
    expect(() => store.get('first')).toThrow('无法解密已保存凭据：apiKey=[redacted] decrypt failed')
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })
})
