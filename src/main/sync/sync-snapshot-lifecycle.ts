import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { SNAPSHOT_PAGE_BYTES, type SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { coverageDominates } from '../../shared/sync-protocol'
import { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'
import { clearSnapshotContent, clearSnapshotTail, collectSnapshotSources } from './sync-snapshot-content-cleanup'

/** 分页对象的租约与预约独立于传输；删除只针对已证明被后继覆盖的无引用对象。 */
export class SyncSnapshotLifecycle {
  readonly budget: SyncSnapshotResourceBudget
  private readonly active = new Map<string, Set<string>>()
  constructor(private readonly database: DatabaseSync) {
    this.budget = new SyncSnapshotResourceBudget(database)
    database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_lease(bundle_id TEXT NOT NULL,owner TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(bundle_id,owner));
      CREATE TABLE IF NOT EXISTS sync_snapshot_reservation(bundle_id TEXT PRIMARY KEY,peer TEXT NOT NULL,bytes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_snapshot_job_input(job_id TEXT NOT NULL,bundle_id TEXT NOT NULL,PRIMARY KEY(job_id,bundle_id))`)
  }

  /** 与已有暂存约束一致：每 Peer 512 MiB、全局 1 GiB，失败明确返回容量错误。 */
  reserve(manifest: SyncPagedSnapshotManifest, peer: string, now: number): void {
    const bytes = manifest.lanes.reduce((total, lane) => total + lane.pageHashes.length * SNAPSHOT_PAGE_BYTES, 0)
    this.budget.reserve(manifest.snapshotBundleId, bytes)
    if (this.database.prepare('SELECT 1 FROM sync_snapshot_reservation WHERE bundle_id=?').get(manifest.snapshotBundleId)) return
    const used = this.database.prepare('SELECT COALESCE(SUM(bytes),0) AS total,COALESCE(SUM(CASE WHEN peer=? THEN bytes ELSE 0 END),0) AS own,COUNT(CASE WHEN peer=? THEN 1 END) AS count FROM sync_snapshot_reservation').get(peer, peer)!
    if (!Number.isSafeInteger(bytes) || bytes + Number(used.total) > TOTAL_BYTES || bytes + Number(used.own) > PEER_BYTES || Number(used.count) >= PEER_MANIFESTS) {
      throw new Error('SNAPSHOT_STAGING_LIMIT: paged Snapshot exceeds reserved temporary capacity')
    }
    const path = String(this.database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file ?? '')
    if (path) {
      const disk = statfsSync(path)
      if (disk.bavail * disk.bsize < bytes * STORAGE_COPIES + SNAPSHOT_PAGE_BYTES) throw new Error('SNAPSHOT_STAGING_LIMIT: insufficient free disk space')
    }
    this.database.prepare('INSERT INTO sync_snapshot_reservation VALUES(?,?,?,?)').run(manifest.snapshotBundleId, peer, bytes, now)
  }

  /** 每个真实请求刷新 lease；网络断开后的对象有界保留供下一连接续传。 */
  pin(bundle: string, owner: string = randomUUID(), now = Date.now()): string {
    this.database.prepare(`INSERT INTO sync_snapshot_lease VALUES(?,?,?) ON CONFLICT(bundle_id,owner) DO UPDATE SET expires_at=excluded.expires_at`).run(bundle, owner, now + RETENTION_MS)
    this.database.prepare('UPDATE sync_snapshot_reservation SET updated_at=? WHERE bundle_id=?').run(now, bundle)
    return owner
  }
  /** 会话消费租约直到 finally 释放；超过续传期限的活动会话仍受保护。 */
  hold(bundle: string): string {
    const owner = this.pin(bundle)
    const owners = this.active.get(bundle) ?? new Set<string>()
    owners.add(owner); this.active.set(bundle, owners)
    return owner
  }
  /** 释放当前消费者，不影响其他并发 Peer 的租约。 */
  release(bundle: string, owner: string): void {
    this.database.prepare('DELETE FROM sync_snapshot_lease WHERE bundle_id=? AND owner=?').run(bundle, owner)
    const owners = this.active.get(bundle)
    owners?.delete(owner)
    if (owners?.size === 0) this.active.delete(bundle)
  }
  /** 发布只是中间阶段，尾部和真实正文验收完成前保留容量预约。 */
  published(bundle: string): void { this.database.prepare('UPDATE sync_snapshot_reservation SET updated_at=? WHERE bundle_id=?').run(Date.now(), bundle) }
  /** 安装执行器完成全部 obligations 后解除预约。 */
  completed(bundle: string): void {
    this.budget.complete(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_reservation WHERE bundle_id=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_job_input WHERE job_id=?').run(bundle)
  }

  /** 仅供已核验的私有 capture 重试/丢弃，保留公开清单与保护状态的原有判断。 */
  clearCapture(bundle: string): void { clearSnapshotContent(this.database, bundle) }

  /** 合并两端输入的持久依赖由实际安装完成解除，暂停作业不依赖 lease TTL 保护。 */
  protectInputs(job: string, inputs: ReadonlySet<string>): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS sync_snapshot_job_input(job_id TEXT NOT NULL,bundle_id TEXT NOT NULL,PRIMARY KEY(job_id,bundle_id))')
    for (const bundle of inputs) this.database.prepare('INSERT OR IGNORE INTO sync_snapshot_job_input VALUES(?,?)').run(job, bundle)
  }

  /** 不可比较 heads、恢复 capsule、当前 baseline 和活动 lease 均禁止回收。 */
  collect(input: { now: number; protected: ReadonlySet<string> }): number {
    this.database.prepare('DELETE FROM sync_snapshot_lease WHERE expires_at<=?').run(input.now)
    const pinned = new Set(this.database.prepare('SELECT DISTINCT bundle_id FROM sync_snapshot_lease').all().map(row => String(row.bundle_id)))
    for (const bundle of this.active.keys()) pinned.add(bundle)
    const rows = this.database.prepare('SELECT snapshot_bundle_id,sync_space_id,state,manifest_json,updated_at FROM sync_paged_snapshot').all()
    const verified = rows.filter(row => row.state === 'VERIFIED').map(row => ({ row, manifest: JSON.parse(String(row.manifest_json)) as SyncPagedSnapshotManifest }))
    let removed = 0
    for (const row of rows) {
      const bundle = String(row.snapshot_bundle_id)
      if (pinned.has(bundle) || input.protected.has(bundle) || Number(row.updated_at) > input.now - RETENTION_MS) continue
      if (this.database.prepare('SELECT 1 FROM sync_snapshot_resource_budget WHERE bundle=?').get(bundle)) continue
      if (this.database.prepare('SELECT 1 FROM sync_snapshot_job_input WHERE bundle_id=? LIMIT 1').get(bundle)) continue
      if (row.state === 'VERIFIED') {
        const candidate = verified.find(item => item.row === row)!
        if (!verified.some(other => other !== candidate && Number(other.row.updated_at) > Number(row.updated_at) && this.covers(other.manifest, candidate.manifest))) continue
      }
      this.remove(bundle)
      removed++
    }
    return removed
  }

  /** 比较同策略真实 coverage，并确认后继保留每个 Genesis 身份，不能只看时间戳。 */
  private covers(next: SyncPagedSnapshotManifest, previous: SyncPagedSnapshotManifest): boolean {
    if (next.syncSpaceId !== previous.syncSpaceId || next.policyHash !== previous.policyHash || !coverageDominates(next.coverage, previous.coverage)) return false
    const values = (bundle: string): Set<string> => new Set(this.database.prepare(`SELECT replication_lane_id,record_json FROM sync_paged_snapshot_record
      WHERE snapshot_bundle_id=? AND kind='GENESIS'`).all(bundle).map(row => `${row.replication_lane_id}:${JSON.parse(String(row.record_json)).value.genesisBaselineId}`))
    const retained = values(next.snapshotBundleId)
    return [...values(previous.snapshotBundleId)].every(value => retained.has(value))
  }

  /** 内容与辅助索引一起移除，外部受保护 catalog 由调用者传入，避免猜测 journal 生命周期。 */
  private remove(bundle: string): void {
    clearSnapshotContent(this.database, bundle)
    clearSnapshotTail(this.database, bundle)
    this.database.prepare('DELETE FROM sync_paged_snapshot WHERE snapshot_bundle_id=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_revision WHERE bundle_id=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_reservation WHERE bundle_id=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_batch_progress WHERE job_id=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_resource_usage WHERE bundle=?').run(bundle)
    this.database.prepare('DELETE FROM sync_snapshot_resource_usage_version WHERE bundle=?').run(bundle)
    collectSnapshotSources(this.database)
  }
}
/** 复用现有 LAN 暂存保留时长与资源预算，已发布 heads 不受该容量预约限制。 */
const RETENTION_MS = 24 * 60 * 60 * 1000
/** 单来源未完成接收的最大资源预约。 */
const PEER_BYTES = 512 * 1024 * 1024
/** 所有未完成分页接收共享的最大预约。 */
const TOTAL_BYTES = 1024 * 1024 * 1024
/** 单 Peer 的空清单也占预约名额，防止只传 manifest 堆积元数据。 */
const PEER_MANIFESTS = 16
/** 暂存字节及记录索引均需要空间，另保留一个最大页面的写入余量。 */
const STORAGE_COPIES = 2
