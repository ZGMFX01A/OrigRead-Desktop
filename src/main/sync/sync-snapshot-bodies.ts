import type { DatabaseSync } from 'node:sqlite'
import type { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { createHash } from 'node:crypto'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { statSync } from 'node:fs'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { withSnapshotWriteOwner } from './sync-snapshot-access'
import { SNAPSHOT_PAGE_BYTES } from '../../shared/sync-paged-snapshot'

interface Body { rowid: number; owner_entity_type: string; owner_entity_sync_id: string; owner_entity_generation: number;
  reference_kind: string; hash: string; total_bytes: number; local_id: string; generation: number }
interface Column { table: string; column: string; type: string }
interface Arrival { space: string; type: string; id: string; generation: number; kind: string; hash: string }

/** 完成以当前 winner 对应的真实正文为依据，文件先到与旧 receipt 都走同一验收。 */
export class SyncSnapshotBodies {
  constructor(private readonly database: DatabaseSync, private readonly blobs: DesktopSyncLocalBlobStore | undefined) {
    database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_body_obligation(
      space TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,field TEXT NOT NULL,generation INTEGER NOT NULL,
      hash TEXT NOT NULL,bytes INTEGER NOT NULL,bundle TEXT NOT NULL,state TEXT NOT NULL,
      PRIMARY KEY(space,type,id,field))`)
  }

  /** 固定索引提供正文尺寸，已在磁盘的 hash 不重复预约，多 owner 引用只计一次。 */
  reserve(input: { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore }): void {
    input.store.lifecycle.budget.reserve(input.manifest.snapshotBundleId,
      input.manifest.lanes.reduce((sum, lane) => sum + lane.pageHashes.length * SNAPSHOT_PAGE_BYTES, 0))
    let missing = 0
    const seen = new Set<string>()
    for (const record of input.store.records({ snapshotBundleId: input.manifest.snapshotBundleId, lane: 'AI_HISTORY', kind: 'BLOB_MANIFEST' })) {
      const hash = String(record.value.hash), bytes = Number(record.value.totalBytes)
      if (seen.has(hash)) continue
      seen.add(hash)
      const path = this.blobs?.getBlobPath(hash)
      if (!path || statSync(path).size !== bytes) missing += bytes
    }
    input.store.lifecycle.budget.bodies(input.manifest.snapshotBundleId, missing)
  }

  /** 游标只批读引用元数据，文件与摘要工作在正文 SQL 短事务之外完成。 */
  requireComplete(space: string, bundle: string): void {
    let after = 0
    while (true) {
      snapshotCheckpoint()
      const batch = this.database.prepare(`SELECT r.rowid,r.owner_entity_type,r.owner_entity_sync_id,r.owner_entity_generation,
        r.reference_kind,r.hash,m.total_bytes,i.local_id,i.generation FROM sync_blob_reference r
        LEFT JOIN sync_blob_manifest m ON m.hash=r.hash LEFT JOIN sync_identity_mapping i
          ON i.sync_space_id=r.sync_space_id AND i.entity_type=r.owner_entity_type AND i.sync_id=r.owner_entity_sync_id
        WHERE r.sync_space_id=? AND r.replication_lane_id='AI_HISTORY' AND r.rowid>?
          AND r.reference_kind IN ('context_snapshot','context_prompt_snapshot','evidence_text','citation_quote')
        ORDER BY r.rowid LIMIT ${BATCH_ROWS}`).all(space, after) as unknown as Body[]
      if (!batch.length) return
      for (const body of batch) this.materialize({ space, bundle, body })
      after = batch.at(-1)!.rowid
    }
  }

  /** 文件已验证后只补齐仍然有效的当前 owner，正文先到或 owner 先到使用同一账本。 */
  arrived(input: Arrival): void {
    const row = this.database.prepare(`SELECT r.rowid,r.owner_entity_type,r.owner_entity_sync_id,r.owner_entity_generation,
      r.reference_kind,r.hash,m.total_bytes,i.local_id,i.generation FROM sync_blob_reference r
      JOIN sync_blob_manifest m ON m.hash=r.hash JOIN sync_identity_mapping i ON i.sync_space_id=r.sync_space_id
      AND i.entity_type=r.owner_entity_type AND i.sync_id=r.owner_entity_sync_id
      WHERE r.sync_space_id=? AND r.owner_entity_type=? AND r.owner_entity_sync_id=?
      AND r.owner_entity_generation=? AND r.reference_kind=? AND r.hash=?`)
      .get(input.space, input.type, input.id, input.generation, input.kind, input.hash) as unknown as Body | undefined
    if (!row || !this.current(input.space, row)) return
    const receipt = this.database.prepare('SELECT bundle FROM sync_snapshot_body_obligation WHERE space=? AND type=? AND id=? AND generation=? AND hash=?')
      .get(input.space, input.type, input.id, input.generation, input.hash)
    withSnapshotWriteOwner(input.space, () => this.materialize({ space: input.space, bundle: String(receipt?.bundle ?? 'LIVE_REFERENCE'), body: row }))
  }

  /** 在同一业务写事务重新核对政策、墓碑、映射和 winner，文件准备期间发生的切换不能覆盖新正文。 */
  private current(space: string, body: Body): boolean {
    const setting = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(`sync.lane-policy:${space}`)
    const policy = setting ? JSON.parse(String(setting.value)) as Record<string, string> : {}
    if (policy.AI_HISTORY && policy.AI_HISTORY !== 'ENABLED') return false
    const tombstone = this.database.prepare('SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=?')
      .get(space, body.owner_entity_type, body.owner_entity_sync_id)
    if (tombstone && Number(tombstone.generation) >= Number(body.owner_entity_generation)) return false
    const mapping = this.database.prepare('SELECT local_id,generation FROM sync_identity_mapping WHERE sync_space_id=? AND entity_type=? AND sync_id=?')
      .get(space, body.owner_entity_type, body.owner_entity_sync_id)
    if (!mapping || mapping.local_id !== body.local_id || Number(mapping.generation) !== Number(body.owner_entity_generation)) return false
    const refs = this.database.prepare(`SELECT hash FROM sync_blob_reference WHERE sync_space_id=? AND owner_entity_type=?
      AND owner_entity_sync_id=? AND owner_entity_generation=? AND reference_kind=?`)
      .all(space, body.owner_entity_type, body.owner_entity_sync_id, body.owner_entity_generation, body.reference_kind)
    return refs.length === 1 && refs[0]!.hash === body.hash
  }

  /** 合法零字节正文也核对实际摘要，旧代引用仅由更高代映射明确排除。 */
  private materialize(input: { space: string; bundle: string; body: Body }): void {
    const { body } = input
    if (body.local_id == null || body.total_bytes == null) throw new Error('SNAPSHOT_BODY_OWNER_OR_MANIFEST_MISSING')
    if (Number(body.generation) > Number(body.owner_entity_generation)) return
    if (Number(body.generation) !== Number(body.owner_entity_generation)) throw new Error('SNAPSHOT_BODY_STALE_GENERATION')
    const column = BODY_COLUMNS[body.reference_kind]
    if (!column || column.type !== body.owner_entity_type) throw new Error('SNAPSHOT_BODY_FIELD_UNSUPPORTED')
    const conflict = this.database.prepare(`SELECT 1 FROM sync_blob_reference WHERE sync_space_id=?
      AND owner_entity_type=? AND owner_entity_sync_id=? AND owner_entity_generation=?
      AND reference_kind=? AND hash!=? LIMIT 1`).get(input.space, body.owner_entity_type, body.owner_entity_sync_id,
        body.owner_entity_generation, body.reference_kind, body.hash)
    if (conflict) throw new Error('SNAPSHOT_BODY_WINNER_CONFLICT')
    this.obligation(input, column, 'MISSING')
    try {
      const bytes = this.blobs?.readVerified(body.hash)
      if (!bytes) throw new Error(`SNAPSHOT_BODY_PENDING: ${body.owner_entity_type}/${body.owner_entity_sync_id}`)
      if (bytes.byteLength !== Number(body.total_bytes)) throw new Error('SNAPSHOT_BODY_LENGTH_MISMATCH')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      this.obligation(input, column, 'VERIFIED_FILE')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!this.current(input.space, body)) throw new Error('SNAPSHOT_BODY_CURRENT_REFERENCE_CHANGED')
        this.database.prepare(`UPDATE ${column.table} SET ${column.column}=? WHERE id=?`).run(text, body.local_id)
        const actual = this.database.prepare(`SELECT ${column.column} AS text FROM ${column.table} WHERE id=?`).get(body.local_id)
        if (actual?.text !== text) throw new Error('SNAPSHOT_BODY_WRITE_MISMATCH')
        this.obligation(input, column, 'MATERIALIZED')
        this.database.exec('COMMIT')
      } catch (error) {
        // 业务正文与同库完成回执同时回滚，错误不会产生完成标记。
        this.database.exec('ROLLBACK'); throw error
      }
      this.requireBody(body, column)
    } catch (error) {
      // 错误状态持久保存，实际原因继续交给作业状态及客户端。
      this.obligation(input, column, 'FAILED'); throw error
    }
  }

  /** 只读真实正文列逐条核对长度与摘要，不使用 MATERIALIZED 状态替代数据证据。 */
  private requireBody(body: Body, column: Column): void {
    const row = this.database.prepare(`SELECT ${column.column} AS text FROM ${column.table} WHERE id=?`).get(body.local_id)
    if (typeof row?.text !== 'string') throw new Error('SNAPSHOT_BODY_PENDING: materialized column missing')
    const bytes = Buffer.from(row.text, 'utf8')
    if (bytes.length !== Number(body.total_bytes) || createHash('sha256').update(bytes).digest('hex') !== body.hash) throw new Error('SNAPSHOT_BODY_CORRUPTED')
  }

  /** 每条义务绑定当前空间、代次、字段与 winner，旧回执不能满足新 winner。 */
  private obligation(input: { space: string; bundle: string; body: Body }, column: Column, state: string): void {
    const body = input.body
    this.database.prepare('INSERT OR REPLACE INTO sync_snapshot_body_obligation VALUES(?,?,?,?,?,?,?,?,?)')
      .run(input.space, body.owner_entity_type, body.owner_entity_sync_id, column.column, body.owner_entity_generation,
        body.hash, body.total_bytes, input.bundle, state)
  }
}

/** 当前支持的 AI 正文字段，SQL 标识符只来自固定白名单。 */
const BODY_COLUMNS: Readonly<Record<string, Column>> = {
  context_snapshot: { table: 'llm_context_refs', column: 'content_snapshot', type: 'context_ref' },
  context_prompt_snapshot: { table: 'llm_context_refs', column: 'prompt_content_snapshot', type: 'context_ref' },
  evidence_text: { table: 'llm_evidence_blocks', column: 'text_snapshot', type: 'evidence_block' },
  citation_quote: { table: 'llm_citation_refs', column: 'quote_snapshot', type: 'citation_ref' }
}
/** 当前拥有者引用每批只保留轻量元数据。 */
const BATCH_ROWS = 256
