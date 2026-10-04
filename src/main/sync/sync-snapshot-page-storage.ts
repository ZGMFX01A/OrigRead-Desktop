import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { snapshotCheckpoint } from './sync-snapshot-execution'

interface PageInput { snapshotBundleId: string; lane: string; index: number; bytes: Uint8Array }
interface PageKey { bundle: string; lane: string; index: number }
interface Input { database: DatabaseSync; budget: Pick<SyncSnapshotResourceBudget, 'requireRemaining'> }
/** 本地校验/解码只取小块；512 KiB 仍是原签名网络页，不改变 wire 承诺。 */
const PAGE_READ_BYTES = 32 * 1024

/** 注入同库容量核对；原始页读取与校验共享固定语句和有界字节块。 */
export function snapshotPageStorage(input: Input): SyncSnapshotPageStorage { return new SyncSnapshotPageStorage(input) }

/** 原始页复用固定语句和字节缓冲，不逐块积累等待 GC 的外部 ArrayBuffer。 */
class SyncSnapshotPageStorage {
  private readonly queries: Readonly<Record<'existing' | 'read' | 'metadata' | 'part' | 'insert', ReturnType<DatabaseSync['prepare']>>>
  private readonly hashBuffer = Buffer.alloc(PAGE_READ_BYTES)
  constructor(private readonly input: Input) {
    const database = input.database, key = 'WHERE snapshot_bundle_id=? AND replication_lane_id=? AND page_index=?'
    this.queries = {
      existing: database.prepare(`SELECT content_hash FROM sync_paged_snapshot_page ${key}`),
      read: database.prepare(`SELECT bytes FROM sync_paged_snapshot_page ${key}`),
      metadata: database.prepare(`SELECT length(bytes) AS size FROM sync_paged_snapshot_page ${key}`),
      part: database.prepare(`SELECT hex(substr(bytes,?,?)) AS hex_bytes FROM sync_paged_snapshot_page ${key}`),
      insert: database.prepare('INSERT OR IGNORE INTO sync_paged_snapshot_page VALUES(?,?,?,?,?)')
    }
  }

  /** 每条 lane 只拥有一个缓冲；索引解码同步消费块内容，不能跨迭代保存借用视图。 */
  *laneParts(input: { bundle: string; lane: string; count: number }): Generator<Uint8Array> {
    const buffer = Buffer.alloc(PAGE_READ_BYTES)
    for (let index = 0; index < input.count; index++) yield* this.parts({ ...input, index }, buffer)
  }

  /** SQL hex 仅作为本地搬运表示，原字节同步写回缓冲；get 完成后才交给原 UTF-8 解码器。 */
  private *parts(page: PageKey, buffer: Buffer): Generator<Uint8Array> {
    const row = this.queries.metadata.get(page.bundle, page.lane, page.index)
    if (!row) throw new Error('SNAPSHOT_CORRUPTED: required Snapshot page is missing')
    const size = Number(row.size)
    for (let offset = 0; offset < size; offset += PAGE_READ_BYTES) {
      snapshotCheckpoint()
      const part = this.queries.part.get(offset + 1, PAGE_READ_BYTES, page.bundle, page.lane, page.index)
      if (!part) throw new Error('SNAPSHOT_CORRUPTED: immutable Snapshot page disappeared')
      const written = buffer.write(String(part.hex_bytes), 0, PAGE_READ_BYTES, 'hex')
      if (written !== Math.min(PAGE_READ_BYTES, size - offset)) throw new Error('SNAPSHOT_CORRUPTED: Snapshot page chunk length differs')
      yield buffer.subarray(0, written)
    }
  }

  /** 原始页每个字节都进入同一个摘要，小块边界不参与签名材料。 */
  hash(page: PageKey): string {
    const digest = createHash('sha256')
    for (const bytes of this.parts(page, this.hashBuffer)) digest.update(bytes)
    return digest.digest('hex')
  }

  /** 原始页面不可替换，容量核对在实际写入之前执行。 */
  write(page: PageInput): string {
    this.input.budget.requireRemaining(page.snapshotBundleId, page.bytes.byteLength)
    const hash = createHash('sha256').update(page.bytes).digest('hex')
    const row = this.queries.existing.get(page.snapshotBundleId, page.lane, page.index)
    if (row && row.content_hash !== hash) throw new Error('SNAPSHOT_CONFLICT: immutable page content changed')
    this.queries.insert.run(page.snapshotBundleId, page.lane, page.index, hash, page.bytes)
    return hash
  }

  /** BLOB 已由 SQLite 分配为独立数组，视图无需再次复制整个页面。 */
  read(bundle: string, lane: string, index: number): Buffer {
    const row = this.queries.read.get(bundle, lane, index) as { bytes: Uint8Array } | undefined
    if (!row) throw new Error('SNAPSHOT_CORRUPTED: required Snapshot page is missing')
    return Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength)
  }

  /** 缺页可以续传，已有页损坏必须暴露失败。 */
  verified(page: { manifest: SyncPagedSnapshotManifest; lane: string; index: number }): boolean {
    const row = this.queries.existing.get(page.manifest.snapshotBundleId, page.lane, page.index)
    if (!row) return false
    const expected = page.manifest.lanes.find(lane => lane.replicationLaneId === page.lane)?.pageHashes[page.index]
    if (!expected || row.content_hash !== expected || this.hash({ bundle: page.manifest.snapshotBundleId, lane: page.lane, index: page.index }) !== expected)
      throw new Error('SNAPSHOT_CORRUPTED: persisted Snapshot page differs from signed index')
    return true
  }
}
