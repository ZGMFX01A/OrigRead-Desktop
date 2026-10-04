import { SNAPSHOT_PAGE_BYTES, type SyncSnapshotLanePages, type SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { canonicalJson } from './sync-operation-canonicalizer'
import { snapshotRecordKey } from './sync-snapshot-records'
import { appendSnapshotText, snapshotTextEncoder } from './sync-snapshot-utf8-pages'
import { writeSnapshotTextFragments } from './sync-snapshot-text-fragments'

export interface SnapshotWriterStorage {
  writeRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): boolean
  captureRecord?(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): boolean
  flushCapture?(): void
  writePage(input: { snapshotBundleId: string; lane: string; index: number; bytes: Uint8Array }): string
}

interface LaneBuffer {
  bytes: Uint8Array
  length: number
  hashes: string[]
  recordCount: number
}

/** 把逐条业务记录切成固定字节页，单条大记录和 UTF-8 字符均可跨页。 */
export class SyncSnapshotPageWriter {
  private readonly lanes = new Map<string, LaneBuffer>()
  private readonly encoding = snapshotTextEncoder()

  constructor(private readonly options: { snapshotBundleId: string; storage: SnapshotWriterStorage; deferPages?: boolean }) {}

  /** 固定捕获阶段不执行正文文件发布与 hash，稍后只消费冻结索引。 */
  get deferred(): boolean { return this.options.deferPages === true }

  /** 依赖当前输出索引的元数据读取前，先提交已准备的捕获批次。 */
  flushCapture(): void { this.options.storage.flushCapture?.() }

  /** 先登记唯一记录，再增量输出页面；同值候选重试不会扩大快照记录数。 */
  append(input: { lane: string; kind: SyncSnapshotRecord['kind']; value: Record<string, unknown> }): void {
    const record = { kind: input.kind, key: snapshotRecordKey(input.kind, input.value), value: input.value }
    if (this.options.deferPages) {
      if (!this.options.storage.captureRecord) throw new Error('SNAPSHOT_CAPTURE_UNAVAILABLE: immutable staging is required')
      this.options.storage.captureRecord({ snapshotBundleId: this.options.snapshotBundleId, lane: input.lane, record })
      return
    }
    if (!this.options.storage.writeRecord({ snapshotBundleId: this.options.snapshotBundleId, lane: input.lane, record })) return
    this.appendIndexed({ lane: input.lane, fragments: [canonicalJson(JSON.stringify(record))] })
  }

  /** 已提交固定索引的完整规范记录只输出页面，不重新复制候选或展开来源对象。 */
  appendIndexed(input: { lane: string; fragments: Iterable<string> }): void {
    const buffer = this.buffer(input.lane)
    buffer.recordCount++
    writeSnapshotTextFragments({ parts: input.fragments,
      write: text => appendSnapshotText({ text, encoding: this.encoding, buffer }, () => this.flush(input.lane)) })
  }

  /** 每个启用 lane 至少发布一页，包括空 lane；页数不因网络分块而变化。 */
  finish(frontiers: Readonly<Record<string, string>>): SyncSnapshotLanePages[] {
    this.flushCapture()
    return Object.entries(frontiers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([lane, frontierJson]) => {
      const buffer = this.buffer(lane)
      if (buffer.length || !buffer.hashes.length) this.flush(lane)
      return { replicationLaneId: lane, frontierJson, pageHashes: [...buffer.hashes], recordCount: buffer.recordCount }
    })
  }

  /** 分配独立 lane 缓冲，内存只保留各 lane 的当前字节页和轻量摘要。 */
  private buffer(lane: string): LaneBuffer {
    let buffer = this.lanes.get(lane)
    if (!buffer) {
      buffer = { bytes: new Uint8Array(SNAPSHOT_PAGE_BYTES), length: 0, hashes: [], recordCount: 0 }
      this.lanes.set(lane, buffer)
    }
    return buffer
  }

  /** 页面落盘后立即释放原始记录的切片，避免缓冲持有已完成的大字段。 */
  private flush(lane: string): void {
    const buffer = this.buffer(lane)
    const bytes = buffer.bytes.subarray(0, buffer.length)
    const hash = this.options.storage.writePage({ snapshotBundleId: this.options.snapshotBundleId, lane, index: buffer.hashes.length, bytes })
    buffer.hashes.push(hash)
    buffer.length = 0
  }
}
