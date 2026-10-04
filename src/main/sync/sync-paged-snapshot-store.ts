import { PAGED_SNAPSHOT_STORE_SCHEMA } from '../database/paged-snapshot-schema'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest, SyncSnapshotBytePage, SyncSnapshotRecord, SyncSnapshotPageStatus } from '../../shared/sync-paged-snapshot'
import { SNAPSHOT_PAGE_BYTES } from '../../shared/sync-paged-snapshot'
import { canonicalJson } from './sync-operation-canonicalizer'
import { verifySnapshotBytePage } from './sync-paged-snapshot-wire'
import { SyncSnapshotRecordPersistence, type PreparedSnapshotRecord } from './sync-snapshot-record-persistence'
import { requireSnapshotAssociations } from './sync-snapshot-associations'
import { SyncSnapshotCandidateCopier, type SnapshotCandidateCopyInput } from './sync-snapshot-candidate-copy'
import { mergeSnapshotFieldEvidence } from './sync-snapshot-rollback-candidate'
import { SyncSnapshotValidationCache } from './sync-snapshot-validation-cache'
import { SyncSnapshotLifecycle } from './sync-snapshot-lifecycle'
import { SyncSnapshotRecordReader, type SnapshotRecordFilter } from './sync-paged-record-read'
import { SyncSnapshotSourcePool } from './sync-snapshot-source-pool'
import { readSnapshotFieldEvidence } from './sync-snapshot-field-evidence-read'
import { SyncSnapshotReceivedIndex } from './sync-snapshot-received-index'
import { snapshotPageStorage } from './sync-snapshot-page-storage'
import { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import { decodeSnapshotRecord } from './sync-snapshot-records'
import { SyncSnapshotScopeCopier, type SnapshotScopeCopy } from './sync-snapshot-scope-copy'
import { associateCapturedSources, type CapturedSourceInput } from './sync-snapshot-captured-sources'

/** 专用快照持久化区；页面完成后仍由安装 journal 持有，普通 Blob TTL 不会删页。 */
export class SyncPagedSnapshotStore {
  private readonly validation: SyncSnapshotValidationCache
  readonly lifecycle: SyncSnapshotLifecycle
  private readonly sources: SyncSnapshotSourcePool
  private readonly persistence: SyncSnapshotRecordPersistence
  private readonly pageStorage: ReturnType<typeof snapshotPageStorage>
  private readonly recordReader: SyncSnapshotRecordReader
  private readonly findSnapshot: ReturnType<DatabaseSync['prepare']>
  private readonly candidateCopier: SyncSnapshotCandidateCopier
  readonly derived: SyncSnapshotDerivedIndex
  private readonly readField: ReturnType<DatabaseSync['prepare']>
  private readonly scopeCopier: SyncSnapshotScopeCopier
  constructor(private readonly database: DatabaseSync) {
    database.exec(PAGED_SNAPSHOT_STORE_SCHEMA)
    this.validation = new SyncSnapshotValidationCache(database)
    this.sources = new SyncSnapshotSourcePool(database)
    this.derived = new SyncSnapshotDerivedIndex(database)
    this.persistence = new SyncSnapshotRecordPersistence(database, this.sources, this.derived)
    this.lifecycle = new SyncSnapshotLifecycle(database)
    this.pageStorage = snapshotPageStorage({ database, budget: this.lifecycle.budget })
    this.recordReader = new SyncSnapshotRecordReader(database)
    this.readField = database.prepare(`SELECT record_json FROM sync_paged_snapshot_record
      WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind='FIELD_VERSION' AND record_key=?`)
    this.findSnapshot = database.prepare('SELECT manifest_json,state,sync_space_id FROM sync_paged_snapshot WHERE snapshot_bundle_id=?')
    this.candidateCopier = new SyncSnapshotCandidateCopier({ database, store: this, sources: this.sources, derived: this.derived })
    this.scopeCopier = new SyncSnapshotScopeCopier({ database, store: this, derived: this.derived })
  }

  /** 固定清单、页和业务索引均未变化时复用验证；与安装/授权状态分离。 */
  reusable(manifest: SyncPagedSnapshotManifest): boolean {
    const stored = this.findSnapshot.get(manifest.snapshotBundleId)
    return stored?.state === 'VERIFIED' &&
      this.validation.reusable(manifest.snapshotBundleId, manifest.rootHash)
  }

  /** 最终事务只读取小型派生索引修订，不展开清单或签名载荷。 */
  derivedRevision(bundle: string): number { return this.validation.revision(bundle) }

  /** 只接续真实 Worker 的完整校验回执；主线程比较标量，不再次扫描原始字节。 */
  acceptPublication(input: { manifest: SyncPagedSnapshotManifest; revision: number }): void {
    const stored = this.find(input.manifest.snapshotBundleId)
    if (stored?.state !== 'VERIFIED' || stored.manifestJson !== canonicalJson(JSON.stringify(input.manifest)))
      throw new Error('REVALIDATION_REQUIRED: Worker publication changed before its exit receipt')
    this.validation.accept({ bundle: input.manifest.snapshotBundleId, root: input.manifest.rootHash, revision: input.revision })
  }

  /** 固定业务记录与原始 cut 同事务提交，后续 Worker 只访问这个私有不可变索引。 */
  freezeCapture(bundle: string, frontiers: string): void {
    this.database.prepare("UPDATE sync_paged_snapshot SET state='FROZEN',manifest_json=? WHERE snapshot_bundle_id=? AND state='CAPTURING'").run(frontiers, bundle)
  }

  /** 恢复合并的私有索引完成后清理，已发布的固定视图禁止走此删除路径。 */
  discardCapture(snapshotBundleId: string): void {
    const current = this.find(snapshotBundleId)
    if (!current) return
    if (current.state !== 'CAPTURING') throw new Error('SNAPSHOT_CONFLICT: published Snapshot cannot be discarded')
    this.lifecycle.clearCapture(snapshotBundleId)
    this.database.prepare('DELETE FROM sync_paged_snapshot WHERE snapshot_bundle_id=?').run(snapshotBundleId)
    this.lifecycle.budget.complete(snapshotBundleId)
  }

  /** 固定视图捕获先写私有区域，生成失败时不能成为可发送的最新快照。 */
  beginCapture(input: { snapshotBundleId: string; syncSpaceId: string; now: number }): void {
    this.lifecycle.budget.reserve(input.snapshotBundleId, 0)
    const existing = this.find(input.snapshotBundleId)
    if (existing && existing.state !== 'CAPTURING') throw new Error('SNAPSHOT_CONFLICT: published Snapshot cannot be replaced')
    if (existing && existing.syncSpaceId !== input.syncSpaceId) throw new Error('SNAPSHOT_CONFLICT: capture retry names another space')
    if (existing) return
    this.database.prepare('INSERT OR REPLACE INTO sync_paged_snapshot VALUES(?,?,?,?,?)')
      .run(input.snapshotBundleId, input.syncSpaceId, '', 'CAPTURING', input.now)
    this.lifecycle.clearCapture(input.snapshotBundleId)
  }

  /** 已验签清单绑定暂存身份；相同 root 可恢复，不允许同一 ID 改写承诺。 */
  beginReceive(manifest: SyncPagedSnapshotManifest, now: number): void {
    const encoded = canonicalJson(JSON.stringify(manifest))
    const existing = this.find(manifest.snapshotBundleId)
    if (existing) {
      if (existing.manifestJson !== encoded) throw new Error('SNAPSHOT_CONFLICT: Snapshot ID already names another signed manifest')
      return
    }
    this.database.prepare('INSERT INTO sync_paged_snapshot VALUES(?,?,?,?,?)')
      .run(manifest.snapshotBundleId, manifest.syncSpaceId, encoded, 'RECEIVING', now)
  }

  /** 只保存与已签名摘要一致的原始页面；重复页面必须逐字节一致。 */
  receivePage(manifest: SyncPagedSnapshotManifest, page: SyncSnapshotBytePage): void {
    const existing = this.find(manifest.snapshotBundleId)
    if (existing?.manifestJson !== canonicalJson(JSON.stringify(manifest))) throw new Error('SNAPSHOT_CONFLICT: page has no matching staged manifest')
    const bytes = verifySnapshotBytePage(manifest, page)
    this.writePage({ snapshotBundleId: manifest.snapshotBundleId, lane: page.replicationLaneId, index: page.pageIndex, bytes })
  }

  /** 捕获与接收共用不可变页面写入，已存在的页不能由重试改变内容。 */
  writePage(input: { snapshotBundleId: string; lane: string; index: number; bytes: Uint8Array }): string {
    return this.pageStorage.write(input)
  }

  /** 一次只读一个字节页；页面序号由清单指定，不从文件名或网络顺序推断。 */
  readPage(snapshotBundleId: string, lane: string, index: number): Buffer {
    return this.pageStorage.read(snapshotBundleId, lane, index)
  }

  /** 缺页可以继续接收，已有页发生字节损坏必须显式报错，不能静默当作缺页。 */
  hasVerifiedPage(input: { manifest: SyncPagedSnapshotManifest; lane: string; index: number }): boolean {
    return this.pageStorage.verified(input)
  }

  /** 网络重试只传缺失页面，续传游标不依赖进程内的已发送字节计数。 */
  pageStatus(manifest: SyncPagedSnapshotManifest): SyncSnapshotPageStatus {
    if (this.reusable(manifest)) return { rootHash: manifest.rootHash,
      receivedPages: Object.fromEntries(manifest.lanes.map(lane => [lane.replicationLaneId, lane.pageHashes.map((_, index) => index)])) }
    const receivedPages: Record<string, number[]> = {}
    for (const lane of manifest.lanes) {
      const received: number[] = []
      for (let index = 0; index < lane.pageHashes.length; index++) {
        if (this.hasVerifiedPage({ manifest, lane: lane.replicationLaneId, index })) received.push(index)
      }
      receivedPages[lane.replicationLaneId] = received
    }
    return { rootHash: manifest.rootHash, receivedPages }
  }

  /** 建立 lane 级记录索引后才允许安装，跨页 field/reference 关联不能只检查当前页。 */
  indexReceived(manifest: SyncPagedSnapshotManifest): void {
    // 旧 VERIFIED 页升级派生索引也会扩张磁盘，不能依赖仅新接收路径创建的预约。
    this.lifecycle.budget.reserve(manifest.snapshotBundleId,
      manifest.lanes.reduce((bytes, lane) => bytes + lane.pageHashes.length * SNAPSHOT_PAGE_BYTES, 0))
    new SyncSnapshotReceivedIndex(this.database, this).build(manifest)
    this.validateAssociations(manifest.snapshotBundleId)
  }

  /** Recovery 未发布索引可补齐同 token 的签名证据，网络不可变页不使用此入口。 */
  mergeFieldRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): void {
    const prepared = this.prepareMergedField(input)
    this.database.prepare(`DELETE FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=?
      AND replication_lane_id=? AND kind='FIELD_VERSION' AND record_key=?`).run(input.snapshotBundleId, input.lane, input.record.key)
    this.writePrepared(prepared)
  }

  /** 冲突来源展开和因果证据合并在批次写事务外完成。 */
  prepareMergedField(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): PreparedSnapshotRecord {
    const row = this.database.prepare(`SELECT rowid,record_json FROM sync_paged_snapshot_record
      WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind='FIELD_VERSION' AND record_key=?`)
      .get(input.snapshotBundleId, input.lane, input.record.key)
    if (!row) return this.prepareRecord(input)
    const old = this.sources.unpack(Number(row.rowid), String(row.record_json))
    const record = { ...input.record, value: mergeSnapshotFieldEvidence(old.value, input.record.value) }
    return this.prepareRecord({ ...input, record })
  }

  /** 私有索引完整后验证发布，未完成 INDEXING 没有业务安装权限。 */
  verifyAndPublish(manifest: SyncPagedSnapshotManifest, now: number): void {
    if (this.reusable(manifest)) return
    if (this.find(manifest.snapshotBundleId)?.state !== 'VERIFIED' || !this.validation.indexed(manifest.snapshotBundleId, manifest.rootHash)) {
      this.indexReceived(manifest)
    }
    this.publish(manifest, now)
  }

  /** 相同记录唯一键只能对应一个规范值；捕获时重复的同值候选不重复输出。 */
  writeRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): boolean {
    return this.persistRecord(input, false)
  }

  /** 私有捕获只复制值；规范化及摘要在 FROZEN 后由 Worker 完成，不作为可导出内容。 */
  captureRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }): boolean {
    if (this.find(input.snapshotBundleId)?.state !== 'CAPTURING') throw new Error('SNAPSHOT_CONFLICT: raw capture requires private staging')
    return this.persistRecord(input, true)
  }

  /** 两种存储共享准备及 SQL 持久化，接收批次应在事务外先准备。 */
  private persistRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }, frozen: boolean): boolean {
    return this.persistence.write(this.persistence.prepare(input, frozen))
  }

  /** 编码、来源摘要及字段转换在写事务之前完成。 */
  prepareRecord(input: { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }, frozen = false): PreparedSnapshotRecord {
    return this.persistence.prepare(input, frozen)
  }

  /** 批次只提交已准备列，游标由调用方以同一事务拥有。 */
  writePrepared(prepared: PreparedSnapshotRecord): boolean { return this.persistence.write(prepared) }
  /** 原来源仍冻结时按轻索引分组关联，记录、来源和断点由同一批事务提交。 */
  associateCapturedSources(input: CapturedSourceInput): void {
    associateCapturedSources({ database: this.database, sources: this.sources, derived: this.derived, budget: this.lifecycle.budget }, input)
  }
  /** 固定查询复制同代次全部候选，完整来源冲突仍在写事务外合并。 */
  copyCandidates(input: SnapshotCandidateCopyInput): void { this.candidateCopier.copy(input) }
  /** 逐条关闭数据库查询再返回记录，避免单条查找或网络等待保留共享连接的旧读快照。 */
  *records(filter: SnapshotRecordFilter): Generator<SyncSnapshotRecord> {
    yield* this.recordReader.read(filter, (id, raw) => this.sources.unpack(id, raw))
  }

  /** 候选导入确实需要实际值，读取紧凑记录但不展开来源；裁决使用 derived.fields。 */
  *compactRecords(filter: SnapshotRecordFilter): Generator<SyncSnapshotRecord> { yield* this.recordReader.read(filter) }

  /** winner 按稳定键只读取一次实际值，来源恢复属于独立完整验证阶段。 */
  fieldRecord(field: SnapshotFieldMetadata): SyncSnapshotRecord {
    const row = this.readField.get(field.bundle, field.lane, field.key)
    if (!row) throw new Error('SNAPSHOT_CORRUPTED: winner record disappeared')
    return decodeSnapshotRecord(String(row.record_json))
  }

  /** 授权、解码和来源恢复按完整来源分组，字段承诺仍逐条独立核对。 */
  evidenceFields(input: { bundle: string; lane: string; sourceAfter?: string }) {
    return readSnapshotFieldEvidence({ database: this.database, sources: this.sources }, input)
  }

  /** 字段分组只读标识，候选的实际大字段值通过记录游标独立读取。 */
  *fieldIds(input: { snapshotBundleId: string; lane: string }): Generator<{ entityType: string; entitySyncId: string; generation: number; fieldId: string }> {
    yield* this.derived.fieldIds(input)
  }

  /** 只在所有页面与跨页关联通过后发布清单，安装状态单独由 durable journal 管理。 */
  publish(manifest: SyncPagedSnapshotManifest, now: number): void {
    const size = Number(this.database.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM sync_paged_snapshot_page WHERE snapshot_bundle_id=?')
      .get(manifest.snapshotBundleId)!.bytes)
    this.lifecycle.budget.reserve(manifest.snapshotBundleId, size)
    const staged = this.find(manifest.snapshotBundleId)
    if (!staged || staged.syncSpaceId !== manifest.syncSpaceId || (!['CAPTURING', 'FROZEN'].includes(staged.state) &&
      staged.manifestJson !== canonicalJson(JSON.stringify(manifest)))) {
      throw new Error('SNAPSHOT_CONFLICT: publication does not match immutable staged Snapshot')
    }
    for (const lane of manifest.lanes) {
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND replication_lane_id=?')
        .get(manifest.snapshotBundleId, lane.replicationLaneId)
      if (Number(count?.count) !== lane.recordCount) throw new Error('SNAPSHOT_CORRUPTED: published Snapshot record count mismatch')
      for (let index = 0; index < lane.pageHashes.length; index++) {
        const hash = this.pageStorage.hash({ bundle: manifest.snapshotBundleId, lane: lane.replicationLaneId, index })
        if (hash !== lane.pageHashes[index]) throw new Error('SNAPSHOT_CORRUPTED: page changed before publication')
      }
    }
    this.validateAssociations(manifest.snapshotBundleId)
    this.database.prepare('UPDATE sync_paged_snapshot SET manifest_json=?,state=?,updated_at=? WHERE snapshot_bundle_id=?')
      .run(canonicalJson(JSON.stringify(manifest)), 'VERIFIED', now, manifest.snapshotBundleId)
    this.validation.mark(manifest.snapshotBundleId, manifest.rootHash)
    this.lifecycle.published(manifest.snapshotBundleId)
  }

  /** 清单可读不代表已安装；调用方仍需检查业务授权与安装 journal。 */
  find(snapshotBundleId: string): { manifestJson: string; state: string; syncSpaceId: string } | null {
    const row = this.findSnapshot.get(snapshotBundleId) as { manifest_json: string; state: string; sync_space_id: string } | undefined
    return row ? { manifestJson: row.manifest_json, state: row.state, syncSpaceId: row.sync_space_id } : null
  }

  /** 私有工作身份的初始时间固定合并 root，重试不改变已经决定的输出。 */
  captureTime(bundle: string): number {
    const row = this.database.prepare('SELECT updated_at FROM sync_paged_snapshot WHERE snapshot_bundle_id=?').get(bundle)
    if (!row) throw new Error('SNAPSHOT_CAPTURE_IDENTITY_MISSING')
    return Number(row.updated_at)
  }

  /** 策略收窄按完整页面和记录逻辑键恢复，来源与轻索引同批提交。 */
  copyScope(input: SnapshotScopeCopy): void { this.scopeCopier.copy(input) }

  /** 完整固定工作索引按 SQL 复制，避免按字段重复恢复并序列化来源正文。 */
  copyIndex(input: { source: string; target: string; lanes: readonly string[] }): void { this.scopeCopier.copyIndex(input) }

  /** 输出按原有排序恢复完整 wire 语义，来源片段不再被逐字段解码。 */
  canonicalRecordFragments(filter: SnapshotRecordFilter): Generator<Iterable<string>> {
    return this.recordReader.render(filter, (rowId, raw) => this.sources.fragments(rowId, raw))
  }

  /** 接收索引按小字节块流式解码，签名页号与全部内容仍由发布校验核对。 */
  *pageChunks(input: { bundle: string; lane: string; count: number }): Generator<Uint8Array> {
    yield* this.pageStorage.laneParts(input)
  }

  /** 独立字段和 Blob 引用必须关联同快照中存在的实体/manifest。 */
  private validateAssociations(snapshotBundleId: string): void {
    this.derived.requireComplete(snapshotBundleId)
    requireSnapshotAssociations({ store: this, database: this.database, bundle: snapshotBundleId })
  }

}
