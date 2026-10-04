import { continueSnapshotTrace, snapshotTracePhase, type SnapshotTraceIdentity } from './sync-snapshot-trace'
import { bindSnapshotCancellation } from './sync-snapshot-execution'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSnapshotRecordEncoding } from './sync-snapshot-record-fragments'
import { decodeSnapshotRecord } from './sync-snapshot-records'
import { validateSnapshotRecordLane } from './sync-snapshot-record-lane'
import type { SyncSnapshotLanePages } from '../../shared/sync-paged-snapshot'
import { SyncSnapshotSourcePool, type PreparedSnapshotSource } from './sync-snapshot-source-pool'
import { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'
import { prepareSnapshotFacts, type PreparedSnapshotFacts } from './sync-snapshot-derived-facts'
import { appendSnapshotText, snapshotTextEncoder } from './sync-snapshot-utf8-pages'
import { writeSnapshotTextFragments } from './sync-snapshot-text-fragments'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'

interface Input { trace?: SnapshotTraceIdentity; path: string; bundle: string; frontiers: Record<string, string>;
  pageBytes: number; busyTimeout: number; blobRoot?: string; now: number; cancellation: SharedArrayBuffer }
interface PageBuffer { bytes: Buffer; length: number; hashes: string[] }

/** 数据仅由主进程传入；沿用主库锁等待配置，短事务竞争不能被误判为数据损坏。 */
const input = workerData as Input
bindSnapshotCancellation(input.cancellation)
/** 本连接只处理 FROZEN 私有记录与页面，主进程仅返回签名清单。 */
const database = new DatabaseSync(input.path)
database.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=${input.busyTimeout}`)
/** 冻结 cut 用独立只读连接遍历，页面写入不能升级仍持有旧 WAL 快照的读事务。 */
const reader = new DatabaseSync(input.path, { readOnly: true })
reader.exec(`PRAGMA busy_timeout=${input.busyTimeout}`)
/** 本地紧凑索引在输出时恢复完整来源，不改变线上记录。 */
const sources = new SyncSnapshotSourcePool(reader)
/** 旧冻结记录升级时，来源与原记录、轻索引、断点共用写连接。 */
const sourceWriter = new SyncSnapshotSourcePool(database)
/** 原始字节页写入复用语句，不能为每页保留一个绑定大 BLOB 的原生对象。 */
const insertPage = database.prepare('INSERT INTO sync_paged_snapshot_page VALUES(?,?,?,?,?)')
/** 规范化复用固定查询，不能让每条文本的原生语句等待 GC 才释放。 */
const readRecord = reader.prepare('SELECT record_json FROM sync_paged_snapshot_record WHERE rowid=?')
/** 分页和规范化都复用小型 UTF-8 编码缓冲。 */
const encoding = snapshotTextEncoder()
/** 规范化提交同时重建轻量承诺，不能留下全文已更新而关系索引仍旧的窗口。 */
const derived = new SyncSnapshotDerivedIndex(database)
/** 使用作业已持有的预约，Worker 不创建另一份生命周期预算。 */
const budget = new SyncSnapshotResourceBudget(database, false)
/** 必需 Blob 的 Worker 校验缓冲不随文件总大小增长。 */
const BLOB_HASH_BUFFER_BYTES = 64 * 1024
/** 必需文件依次读取，复用同一原生缓冲而非为每个文件再分配。 */
const blobHashBuffer = Buffer.allocUnsafe(BLOB_HASH_BUFFER_BYTES)
/** 每个提交批次只保留有界记录与原始 UTF-8 载荷预算。 */
const NORMALIZE_BATCH_ROWS = 256
/** 超大单条记录独占批次，不截断原始文本。 */
const NORMALIZE_BATCH_BYTES = 2 * 1024 * 1024
/** 规范化断点绑定 P3 字段与关系派生格式，不接管旧私有游标。 */
const NORMALIZATION_PHASE = 'normalize:v2'
/** 真实执行器循环读取共享取消请求，不依赖父线程 Promise 提前返回。 */
const cancellation = new Int32Array(input.cancellation)

/** 循环与签名等待都响应原空间 owner 的共享取消令牌。 */
function checkpoint(): void {
  if (Atomics.load(cancellation, 0) !== 0) throw new Error('SNAPSHOT_JOB_CANCELLED: worker checkpoint')
}

/** 冻结索引中的必需 AI 文件由 Worker 顺序 hash，发布前不能占用主线程或略过缺失文件。 */
function verifyRequiredBlobs(): void {
  const manifests = reader.prepare("SELECT record_json FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND replication_lane_id='AI_HISTORY' AND kind='BLOB_MANIFEST'").iterate(input.bundle)
  for (const row of manifests) {
    checkpoint()
    const record = decodeSnapshotRecord(String(row.record_json))
    if (!input.blobRoot) throw new Error('Genesis AI_HISTORY Blob store is unavailable')
    const hash = String(record.value.hash)
    const descriptor = openSync(join(input.blobRoot, hash), 'r')
    try {
      const digest = createHash('sha256')
      for (;;) {
        checkpoint()
        const count = readSync(descriptor, blobHashBuffer, 0, blobHashBuffer.length, null)
        if (!count) break
        digest.update(blobHashBuffer.subarray(0, count))
      }
      if (digest.digest('hex') !== hash || fstatSync(descriptor).size !== Number(record.value.totalBytes)) {
        throw new Error(`Genesis AI_HISTORY Blob is invalid: ${hash}`)
      }
    } finally {
      // 缺失、损坏或读取异常直接使 Worker 失败，未发布固定视图留待真实恢复。
      closeSync(descriptor)
    }
  }
}

/** 同一个冻结 cut 的记录先规范化及校验，再写摘要；失败不能发布部分索引。 */
function normalize(): void {
  const state = reader.prepare('SELECT state FROM sync_paged_snapshot WHERE snapshot_bundle_id=?').get(input.bundle)
  if (state?.state !== 'FROZEN') throw new Error('SNAPSHOT_CONFLICT: Worker needs an immutable private cut')
  const update = database.prepare('UPDATE sync_paged_snapshot_record SET record_json=?,content_hash=? WHERE rowid=?')
  const keys = normalizationKeys()
  let after = JSON.parse(snapshotBatchCursor(database, { job: input.bundle, phase: NORMALIZATION_PHASE }) ?? '["","",""]') as [string, string, string]
  for (;;) {
    checkpoint()
    const prepared = prepareNormalization(keys.all(input.bundle, ...after))
    if (!prepared.length) return
    const bytes = prepared.reduce((sum, row) => sum + row.bytes, 0)
    budget.requireRemaining(input.bundle, bytes)
    commitSnapshotBatch(database, { job: input.bundle, phase: NORMALIZATION_PHASE, cursor: prepared.at(-1)!.cursor,
      rows: prepared.length, bytes, budget }, () => {
      for (const row of prepared) {
        checkpoint()
        if (row.source) sourceWriter.persist(row.source)
        update.run(row.encoded, row.hash, row.id); derived.write(row.facts)
      }
    })
    after = JSON.parse(prepared.at(-1)!.cursor) as [string, string, string]
  }
}

/** 恢复选择同时覆盖旧冻结记录缺少轻索引的情况，读取只携带逻辑键和长度。 */
function normalizationKeys(): ReturnType<DatabaseSync['prepare']> {
  return reader.prepare(`SELECT rowid,replication_lane_id,kind,record_key,
    length(CAST(record_json AS BLOB))+COALESCE((SELECT length(CAST(s.envelope_json AS BLOB))
      FROM sync_snapshot_source_link l JOIN sync_snapshot_source s ON s.source_key=l.source_key
      WHERE l.snapshot_bundle_id=sync_paged_snapshot_record.snapshot_bundle_id AND l.replication_lane_id=sync_paged_snapshot_record.replication_lane_id
        AND l.record_key=sync_paged_snapshot_record.record_key),0) AS bytes FROM sync_paged_snapshot_record
    WHERE snapshot_bundle_id=? AND (replication_lane_id,kind,record_key)>(?,?,?) AND (content_hash='' OR
      (kind='FIELD_VERSION' AND NOT EXISTS(SELECT 1 FROM sync_snapshot_field_index f WHERE f.snapshot_bundle_id=sync_paged_snapshot_record.snapshot_bundle_id
        AND f.replication_lane_id=sync_paged_snapshot_record.replication_lane_id AND f.record_key=sync_paged_snapshot_record.record_key)) OR
      (kind='ENTITY' AND NOT EXISTS(SELECT 1 FROM sync_snapshot_entity_index e WHERE e.snapshot_bundle_id=sync_paged_snapshot_record.snapshot_bundle_id
        AND e.replication_lane_id=sync_paged_snapshot_record.replication_lane_id AND e.record_key=sync_paged_snapshot_record.record_key)))
      ORDER BY replication_lane_id,kind,record_key LIMIT ${NORMALIZE_BATCH_ROWS}`)
}

interface Normalized { id: number; encoded: string; hash: string; bytes: number; cursor: string; facts: PreparedSnapshotFacts; source?: PreparedSnapshotSource }

/** 大 DTO 仅在事务外准备；超大单条独占批次，下一条在解码之前判断字节预算。 */
function prepareNormalization(ids: Record<string, import('node:sqlite').SQLOutputValue>[]): Normalized[] {
  const prepared: Normalized[] = []
  let bytes = 0
  for (const row of ids) {
    checkpoint()
    const size = Number(row.bytes)
    if (prepared.length && bytes + size > NORMALIZE_BATCH_BYTES) break
    const stored = String(readRecord.get(row.rowid!)!.record_json), record = decodeSnapshotRecord(stored)
    validateSnapshotRecordLane(String(row.replication_lane_id), record)
    const source = record.value.sourceOperation == null ? undefined : sourceWriter.prepare({ bundle: input.bundle, lane: String(row.replication_lane_id), record })
    const compact = source?.compact ?? record
    const encoded = source ? prepareSnapshotRecordEncoding({ record: compact, source: source.encoded }) : sources.encoding(Number(row.rowid), compact)
    prepared.push({ id: Number(row.rowid), encoded: encoded.stored, hash: encoded.hash, bytes: size, source,
      cursor: JSON.stringify([row.replication_lane_id, row.kind, row.record_key]),
      facts: prepareSnapshotFacts({ bundle: input.bundle, lane: String(row.replication_lane_id), record: compact }) })
    bytes += size
  }
  return prepared
}

/** 页面只保留一个有界缓冲，字节与现有规范记录编码完全一致。 */
function flush(lane: string, buffer: PageBuffer): void {
  checkpoint()
  const bytes = buffer.bytes.subarray(0, buffer.length)
  const hash = createHash('sha256').update(bytes).digest('hex')
  insertPage.run(input.bundle, lane, buffer.hashes.length, hash, bytes)
  buffer.hashes.push(hash); buffer.length = 0
}

/** 超大记录允许跨页，UTF-8 多字节字符使用原始字节切分。 */
function generate(lane: string, frontierJson: string): SyncSnapshotLanePages {
  const buffer: PageBuffer = { bytes: Buffer.allocUnsafe(input.pageBytes), length: 0, hashes: [] }
  let count = 0
  const rows = reader.prepare('SELECT rowid,record_json FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND replication_lane_id=? ORDER BY kind,entity_type,entity_sync_id,generation,record_key').iterate(input.bundle, lane)
  for (const row of rows) {
    checkpoint()
    count++
    writeSnapshotTextFragments({ parts: sources.fragments(Number(row.rowid), String(row.record_json)),
      write: text => appendSnapshotText({ text, encoding, buffer }, () => flush(lane, buffer)) })
  }
  if (buffer.length || !buffer.hashes.length) flush(lane, buffer)
  return { replicationLaneId: lane, frontierJson, pageHashes: buffer.hashes, recordCount: count }
}

/** 先产生原始页，再等待真实主进程签名；不自行生成密钥或替代签名。 */
async function run(): Promise<void> {
  const lanes = snapshotTracePhase('capture.pages', () => {
    snapshotTracePhase('capture.normalize', normalize)
    snapshotTracePhase('capture.verify_blobs', verifyRequiredBlobs)
    database.prepare('DELETE FROM sync_paged_snapshot_page WHERE snapshot_bundle_id=?').run(input.bundle)
    return Object.entries(input.frontiers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([lane, frontier]) => generate(lane, frontier))
  })
  parentPort!.postMessage({ type: 'PAGES', lanes })
  const manifest = await signedManifest()
  checkpoint()
  const store = new SyncPagedSnapshotStore(database)
  snapshotTracePhase('capture.publish-pages', () => store.publish(manifest, input.now))
  checkpoint()
  parentPort!.postMessage({ type: 'PUBLISHED', receipt: { bundle: input.bundle, root: manifest.rootHash,
    revision: store.derivedRevision(input.bundle) } })
}

/** 签名失败明确结束作业；等待期间端口保持存活，但不持有写事务或活动游标。 */
function signedManifest(): Promise<SyncPagedSnapshotManifest> {
  return new Promise((resolve, reject) => parentPort!.once('message', message => {
    if (message.type !== 'MANIFEST' || message.manifest?.snapshotBundleId !== input.bundle)
      reject(new Error('SNAPSHOT_SIGNING_FAILED: fixed-page signature was not returned'))
    else resolve(message.manifest)
  }))
}

try { await continueSnapshotTrace(input.trace, run) }
finally {
  // 完整校验、取消或签名失败都在关闭连接与端口后才产生真实 exit。
  reader.close(); database.close(); parentPort!.close()
}
