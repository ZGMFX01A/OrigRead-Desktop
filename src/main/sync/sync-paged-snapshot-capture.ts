import type { DatabaseSync } from 'node:sqlite'
import { snapshotCaptureRecordTable } from './sync-frozen-database-context'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository, SyncFieldVersionRecord } from './sync-state-repository'
import type { DesktopGenesisCut } from './sync-runtime-coordinator'
import type { SyncSnapshotPageWriter } from './sync-snapshot-page-writer'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { canonicalJson, canonicalJsonValue } from './sync-operation-canonicalizer'
import { SyncVersionToken } from './sync-version-token'
import { feedConfigCaptureVariants, type FeedConfigVariant } from './sync-paged-feed-config'
import { captureFieldOperationEvidence } from './sync-paged-operation-evidence'
import { snapshotRollbackCandidate } from './sync-snapshot-rollback-candidate'
import { requireExportableConfig, requireExportableConfigField } from './sync-config-export'
import { commitSnapshotBatch } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'

interface CaptureOptions {
  database: DatabaseSync
  runtime: SyncRuntimeRepository
  state: SyncStateRepository
  cut: DesktopGenesisCut
  writer: SyncSnapshotPageWriter
  store: SyncPagedSnapshotStore
  snapshotBundleId: string
}

/** 捕获期间直接写记录索引与字节页，历史候选和关联元数据不汇总为 lane 数组。 */
export class SyncPagedSnapshotCapture {
  constructor(private readonly options: CaptureOptions) {}

  /** 生产分阶段捕获将 Blob I/O 留在 barrier 外。 */
  get deferBlobIO(): boolean { return this.options.writer.deferred }

  /** 元数据转换和冻结状态都必须消费已经实际提交的输出索引。 */
  flush(): void { this.options.writer.flushCapture() }

  /** Feed 配置按父别名输出各自身份/代次，避免压缩后丢失另一配置的候选。 */
  entityVariants(input: { entityType: string; entitySyncId: string; generation: number; fields: Record<string, unknown> }): FeedConfigVariant[] {
    const config = feedConfigCaptureVariants({ database: this.options.database, space: this.options.cut.syncSpaceId,
      type: input.entityType, fields: input.fields })
    if (config) return config
    return this.entityMembers(input).map(entitySyncId => ({ entitySyncId, generation: input.generation, fields: input.fields }))
  }

  /** 配置删除仍是存活寄存器的真实缺席值，不能因业务配置行消失而丢掉因果身份。 */
  appendAbsentFeedConfigs(accountId: number, consume: (input: { type: string; localId: string; fields: Record<string, unknown> }) => void): void {
    this.options.writer.flushCapture()
    const { database, cut, snapshotBundleId } = this.options
    const rows = database.prepare(`SELECT m.entity_type,m.local_id,m.sync_id,v.field_id,v.value_json
      FROM sync_identity_mapping m JOIN sync_field_version v ON v.sync_space_id=m.sync_space_id
        AND v.entity_type=m.entity_type AND v.entity_sync_id=m.sync_id AND v.entity_generation=m.generation
      WHERE m.sync_space_id=? AND ((m.entity_type='website_parse_preference' AND v.field_id='preference')
        OR (m.entity_type='rsshub_subscription_source' AND v.field_id='source'))`).iterate(cut.syncSpaceId)
    for (const row of rows) {
      if (this.options.store.records({ snapshotBundleId, kind: 'ENTITY', entityType: String(row.entity_type), entitySyncId: String(row.sync_id) }).next().value) continue
      const parent = JSON.parse(String(row.value_json)) as Record<string, unknown>
      if (parent.__syncAbsent !== true) continue
      const alive = database.prepare(`SELECT 1 FROM sync_identity_mapping m JOIN feeds f ON f.id=m.local_id
        WHERE m.sync_space_id=? AND m.entity_type='feed' AND m.generation=? AND f.account_id=? AND (m.sync_id=? OR EXISTS(
          SELECT 1 FROM sync_entity_alias a JOIN sync_entity_alias b ON a.sync_space_id=b.sync_space_id
            AND a.entity_type=b.entity_type AND a.generation=b.generation AND a.canonical_sync_id=b.canonical_sync_id
          WHERE a.sync_space_id=m.sync_space_id AND a.entity_type='feed' AND a.generation=m.generation
            AND a.alias_sync_id=? AND b.alias_sync_id=m.sync_id))`).get(cut.syncSpaceId,
        Number(parent.feedGeneration), accountId, String(parent.feedSyncId), String(parent.feedSyncId))
      if (!alive) continue
      consume({ type: String(row.entity_type), localId: String(row.local_id), fields: { [String(row.field_id)]: {
        feedSyncId: parent.feedSyncId, feedGeneration: parent.feedGeneration, __syncAbsent: true } } })
    }
  }

  /** 同一业务行的每个逻辑身份都进入后续快照，避免压缩后遗失别名的候选历史。 */
  entityMembers(input: { entityType: string; entitySyncId: string; generation: number }): string[] {
    const rows = this.options.database.prepare(`SELECT alias_sync_id FROM sync_entity_alias
      WHERE sync_space_id=? AND entity_type=? AND generation=? AND canonical_sync_id=(
        SELECT canonical_sync_id FROM sync_entity_alias WHERE sync_space_id=? AND entity_type=? AND generation=? AND alias_sync_id=?)
      ORDER BY alias_sync_id`).all(this.options.cut.syncSpaceId, input.entityType, input.generation,
        this.options.cut.syncSpaceId, input.entityType, input.generation, input.entitySyncId)
    return rows.length ? rows.map(row => String(row.alias_sync_id)) : [input.entitySyncId]
  }

  /** 逐条保留已生效历史的全部字段候选，不能只保留 winner 后进行 GC。 */
  retainHistory(): void {
    let pending: SyncFieldVersionRecord[] = [], bytes = 0
    const flush = () => {
      if (!pending.length) return
      const last = pending.at(-1)!
      // 只持有私有来源库事务，字段 DTO 已在外部准备；输出页库不进入此回调。
      commitSnapshotBatch(this.options.database, { job: this.options.snapshotBundleId, phase: 'capture-history',
        cursor: JSON.stringify([last.sourceOperationId, last.fieldId]), budget: this.options.store.lifecycle.budget }, () => {
        for (const field of pending) { snapshotCheckpoint(); this.options.state.retainFieldCandidate(field) }
      })
      pending = []; bytes = 0
    }
    for (const field of this.historyCandidates()) {
      snapshotCheckpoint()
      const size = Buffer.byteLength(JSON.stringify(field))
      if (pending.length && (pending.length === HISTORY_BATCH_ROWS || bytes + size > HISTORY_BATCH_BYTES)) flush()
      pending.push(field); bytes += size
    }
    flush()
  }

  /** 全部原操作候选先编码为不可变 DTO，保留历史不能把赢家当作全部 effect。 */
  private *historyCandidates(): Generator<SyncFieldVersionRecord> {
    const { runtime, state, cut } = this.options
    for (const operation of runtime.iterateOperationsForSnapshot(cut.syncSpaceId)) {
      const inboxState = state.findInboxState(operation.operationId)
      if (operation.buildStatus === 'REJECTED' || (inboxState != null && inboxState !== 'APPLIED')) continue
      const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>
      const fields = operation.operationType === 'FIELD_SET' ? { [String(payload.field)]: payload.value }
        : ['UPSERT', 'RELATION_SET'].includes(operation.operationType) ? (payload.fields ?? payload) as Record<string, unknown> : {}
      for (const [fieldId, value] of Object.entries(fields)) {
        yield { syncSpaceId: cut.syncSpaceId, entityType: operation.entityType,
          entitySyncId: operation.entitySyncId, entityGeneration: operation.entityGeneration, fieldId,
          versionToken: SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence),
          valueJson: canonicalJsonValue(value), sourceOperationId: operation.operationId,
          causalContextJson: operation.causalContextJson, logicalClock: operation.logicalClock, updatedAt: cut.capturedAt }
      }
    }
  }

  /** 当前实体的字段候选通过数据库索引逐条读取，跨页后仍与同一实体代次绑定。 */
  appendCandidates(input: { lane: SyncReplicationLane; entityType: string; entitySyncId: string; generation: number }): void {
    const candidates = this.options.state.iterateEntityFieldCandidates({ syncSpaceId: this.options.cut.syncSpaceId,
      entityType: input.entityType, entitySyncId: input.entitySyncId, generation: input.generation })
    for (const row of candidates) {
      this.appendVersion({ lane: input.lane, value: { ...row } })
      // 历史 Genesis 候选跨固定视图保留时，其基线也必须随页面传给后续本地操作。
      if (SyncVersionToken.source(row.versionToken) === 'GENESIS') this.append({ lane: input.lane,
        kind: 'GENESIS', value: { genesisBaselineId: row.versionToken.split('|')[1]! } })
    }
  }

  /** 当前 winner 与历史候选使用同一证据编码，避免同 token 一次带签名、一次不带签名。 */
  appendVersion(input: { lane: SyncReplicationLane; value: Record<string, unknown> }): void {
    const row = input.value
    const predecessor = snapshotRollbackCandidate({ database: this.options.database, space: this.options.cut.syncSpaceId,
      lane: input.lane, value: row })
    if (predecessor) {
      this.append({ lane: input.lane, kind: 'FIELD_VERSION', value: predecessor })
      this.append({ lane: input.lane, kind: 'GENESIS', value: { genesisBaselineId: String(predecessor.versionToken).split('|')[1]! } })
    }
    this.append({ lane: input.lane, kind: 'FIELD_VERSION', value: {
      entityType: row.entityType, entitySyncId: row.entitySyncId, entityGeneration: row.entityGeneration,
      fieldId: row.fieldId, versionToken: row.versionToken, valueJson: row.valueJson,
      causalContextJson: SyncVersionToken.source(String(row.versionToken)) === 'GENESIS' || row.causalContextJson == null
        ? null : canonicalJson(String(row.causalContextJson)),
      logicalClock: SyncVersionToken.source(String(row.versionToken)) === 'GENESIS' ? null : row.logicalClock ?? null,
      ...(this.options.writer.deferred ? {} : captureFieldOperationEvidence({ database: this.options.database,
        runtime: this.options.runtime, space: this.options.cut.syncSpaceId, value: row })) } })
  }

  /** 验证过的 AUTH ledger 拆成独立对象，避免一个 ledger 超过网络页面大小。 */
  appendAuth(): void {
    let rootFound = false
    for (const object of this.options.runtime.iterateAuthForSnapshot(this.options.cut.syncSpaceId)) {
      rootFound ||= object.objectType === 'SPACE_ROOT'
      this.append({ lane: 'AUTH', kind: 'AUTH_OBJECT', value: { ...object } })
    }
    if (!rootFound) throw new Error('Genesis AUTH Snapshot requires a verified SPACE_ROOT')
  }

  /** 删除、别名和正文引用逐条落盘；只导出已捕获实体的当前有效引用。 */
  appendLaneMetadata(input: { lane: SyncReplicationLane; entityTypes: readonly string[] }): void {
    const { database, cut } = this.options
    for (const type of input.entityTypes) {
      const rows = database.prepare(`SELECT entity_type,entity_sync_id,generation,version_token,deleted_at
        FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? ORDER BY entity_sync_id`).iterate(cut.syncSpaceId, type)
      for (const row of rows) this.append({ lane: input.lane, kind: 'TOMBSTONE', value: {
        entityType: row.entity_type, entitySyncId: row.entity_sync_id, generation: row.generation,
        versionToken: row.version_token, deletedAt: row.deleted_at } })
    }
    if (input.lane === 'CORE_META') this.appendAliases()
    this.appendBlobs(input.lane)
    // 新固定视图已经包含以前发布/安装的 Genesis 知识，不能只携带本次新基线身份。
    for (const baseline of this.options.runtime.observedGenesisBaselinesByLane(cut.syncSpaceId)[input.lane] ?? []) {
      this.append({ lane: input.lane, kind: 'GENESIS', value: { genesisBaselineId: baseline } })
    }
    this.append({ lane: input.lane, kind: 'GENESIS', value: { genesisBaselineId: cut.genesisBaselineId } })
  }

  /** 别名边保留双方代次，不能把不同 incarnation 的身份意外归并。 */
  private appendAliases(): void {
    const rows = this.options.database.prepare(`SELECT * FROM sync_alias_edge WHERE sync_space_id=?
      ORDER BY entity_type,left_sync_id,left_generation,right_sync_id,right_generation`).iterate(this.options.cut.syncSpaceId)
    for (const row of rows) this.append({ lane: 'CORE_META', kind: 'ALIAS_EDGE', value: {
      targetEntityType: row.entity_type, leftSyncId: row.left_sync_id, leftGeneration: row.left_generation,
      rightSyncId: row.right_sync_id, rightGeneration: row.right_generation } })
  }

  /** 引用过滤在持久索引执行，避免全库 owner/hash 集合占用内存。 */
  private appendBlobs(lane: string): void {
    this.options.writer.flushCapture()
    const { database, cut, snapshotBundleId } = this.options
    const rows = database.prepare(`SELECT r.*,e.entity_sync_id AS captured_owner FROM sync_blob_reference r
      JOIN ${snapshotCaptureRecordTable()} e ON e.snapshot_bundle_id=? AND e.replication_lane_id=r.replication_lane_id
        AND e.kind='ENTITY' AND e.entity_type=r.owner_entity_type AND e.generation=r.owner_entity_generation
        AND (e.entity_sync_id=r.owner_entity_sync_id OR EXISTS(
          SELECT 1 FROM sync_entity_alias a JOIN sync_entity_alias b ON a.sync_space_id=b.sync_space_id
            AND a.entity_type=b.entity_type AND a.generation=b.generation AND a.canonical_sync_id=b.canonical_sync_id
          WHERE a.sync_space_id=r.sync_space_id AND a.entity_type=r.owner_entity_type AND a.generation=r.owner_entity_generation
            AND a.alias_sync_id=r.owner_entity_sync_id AND b.alias_sync_id=e.entity_sync_id))
      WHERE r.sync_space_id=? AND r.replication_lane_id=? ORDER BY r.hash,r.reference_kind,e.entity_sync_id`)
      .iterate(snapshotBundleId, cut.syncSpaceId, lane)
    for (const row of rows) this.append({ lane, kind: 'BLOB_REFERENCE', value: { replicationLaneId: lane,
      ownerEntityType: row.owner_entity_type, ownerEntitySyncId: row.captured_owner,
      ownerEntityGeneration: row.owner_entity_generation, referenceKind: row.reference_kind, hash: row.hash } })
    this.options.writer.flushCapture()
    // 别名身份也是真实协议 owner，引用计数按当前输出索引重新计算，不能复用全库计数。
    const manifests = database.prepare(`SELECT m.*,COUNT(*) AS captured_count FROM sync_blob_manifest m
      JOIN ${snapshotCaptureRecordTable()} r ON r.blob_hash=m.hash WHERE r.snapshot_bundle_id=?
      AND r.replication_lane_id=? AND r.kind='BLOB_REFERENCE' GROUP BY m.hash ORDER BY m.hash`).iterate(snapshotBundleId, lane)
    for (const row of manifests) this.append({ lane, kind: 'BLOB_MANIFEST', value: { hash: row.hash,
      totalBytes: row.total_bytes, mediaType: row.media_type, compression: row.compression,
      encryptionInfoJson: row.encryption_info_json, availabilityPolicy: row.availability_policy,
      durability: row.durability, referenceCount: row.captured_count } })
  }

  /** 同值候选只写一次，不同值使用相同唯一键时由存储层明确拒绝。 */
  append(input: { lane: string; kind: SyncSnapshotRecord['kind']; value: Record<string, unknown> }): void {
    if (input.kind === 'ENTITY') requireExportableConfig(String(input.value.entityType), input.value.fields)
    if (input.kind === 'FIELD_VERSION') requireExportableConfigField({ type: String(input.value.entityType),
      field: String(input.value.fieldId), valueJson: String(input.value.valueJson) })
    this.options.writer.append(input)
  }
}

/** 历史保留和其他快照批次使用同一记录预算。 */
const HISTORY_BATCH_ROWS = 256
/** 标准字段 DTO 字节预算，单条合法大字段独占提交。 */
const HISTORY_BATCH_BYTES = 2 * 1024 * 1024
