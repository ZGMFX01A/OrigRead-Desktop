import type { SyncEndpointSession, SyncSnapshotShardWire } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import type { DesktopSnapshotInstallService } from './desktop-snapshot-install-service'
import type { SyncPagedSnapshotTransfer } from './sync-paged-snapshot-transfer'
import type { SyncCoverage, SyncAuthProtocolObject } from '../../shared/sync-protocol'
import { coverageDominates } from '../../shared/sync-protocol'

/** 产品 Blob 传输只需要一个真实拥有者的索引，不依赖整 lane JSON。 */
export type SnapshotBlobIndex = Pick<SyncSnapshotShardWire, 'replicationLaneId' | 'blobManifestIndexJson' | 'blobReferenceIndexJson'>

export interface PagedSessionSnapshotDependencies {
  genesis: DesktopGenesisSnapshotService
  installer: DesktopSnapshotInstallService
  transfer: SyncPagedSnapshotTransfer
  session: SyncEndpointSession
  authorize(): void
  fetchBlobs(index: SnapshotBlobIndex): Promise<void>
  uploadBlobs(index: SnapshotBlobIndex): Promise<void>
  now: number
}

interface RecoveryOptions {
  localAccountId: number
  syncSpaceId: string
  lanes: ReadonlySet<string>
  target?: SyncPagedSnapshotManifest
  pushOperations(): Promise<void>
  retained(): Promise<SyncCoverage>
  accept(bundleId: string, coverage?: SyncCoverage): Promise<SyncAuthProtocolObject>
}

/** 正式会话仅调度分页契约；LAN 不能借旧 streaming capability 回到聚合正文。 */
export class SyncPagedSessionSnapshots {
  private readonly lazyDownloads = new Map<string, SyncPagedSnapshotManifest>()
  private readonly lazyUploads = new Map<string, SyncPagedSnapshotManifest>()
  private readonly leases = new Map<string, string>()
  constructor(private readonly deps: PagedSessionSnapshotDependencies) {}

  /** 拉取同一完整选定范围，先验作者，再收缺页、验证索引与单拥有者正文。 */
  async latest(lanes: ReadonlySet<string>): Promise<SyncPagedSnapshotManifest | null> {
    const { session } = this.deps
    if (!session.getLatestPagedSnapshot) throw new Error('SNAPSHOT_INCOMPATIBLE: paged manifest fetch is unavailable')
    this.deps.authorize()
    const manifest = await session.getLatestPagedSnapshot({ class: 'WORKING', lanes: [...lanes] })
      ?? await session.getLatestPagedSnapshot({ class: 'GC_BASELINE', lanes: [...lanes] })
    if (!manifest) return null
    if (manifest.lanes.length !== lanes.size || manifest.lanes.some(lane => !lanes.has(lane.replicationLaneId))) {
      throw new Error('SNAPSHOT_INCOMPATIBLE: remote paged Snapshot changed negotiated scope')
    }
    this.deps.installer.verifyPagedAuthor(manifest)
    this.hold(manifest.snapshotBundleId)
    await this.deps.transfer.receive({ manifest, session, authorize: this.deps.authorize, now: this.deps.now })
    this.deps.installer.verifyPaged({ manifest, store: this.deps.genesis.pagedSnapshotStore })
    this.lazyDownloads.set(manifest.snapshotBundleId, manifest)
    for (const index of this.deps.transfer.blobIndexes(manifest)) if (index.replicationLaneId !== 'ARTICLE_STATE') await this.deps.fetchBlobs(index)
    return manifest
  }

  /** 本机发布的原始页逐页发送，持久接收进度和 commit 都绑定最终 bundle ID。 */
  async push(bundleId: string, lanes: ReadonlySet<string>): Promise<string> {
    const manifest = this.deps.genesis.exportPagedManifest({ snapshotBundleId: bundleId, selectedLanes: lanes })
    this.hold(manifest.snapshotBundleId)
    this.deps.installer.verifyPaged({ manifest, store: this.deps.genesis.pagedSnapshotStore })
    for (const index of this.deps.transfer.blobIndexes(manifest)) {
      if (index.replicationLaneId === 'ARTICLE_STATE') { this.lazyUploads.set(manifest.snapshotBundleId, manifest); continue }
      this.deps.authorize()
      await this.deps.uploadBlobs(index)
    }
    await this.deps.transfer.push({ manifest, session: this.deps.session, authorize: this.deps.authorize, now: this.deps.now })
    return manifest.snapshotBundleId
  }

  /** 本轮 metadata 已应用后才按索引流式补齐正文，不在内存收集全部 Blob 引用。 */
  async flushLazyBlobs(): Promise<void> {
    for (const manifest of this.lazyUploads.values()) for (const index of this.deps.transfer.blobIndexes(manifest)) {
      if (index.replicationLaneId === 'ARTICLE_STATE') { this.deps.authorize(); await this.deps.uploadBlobs(index) }
    }
    for (const manifest of this.lazyDownloads.values()) for (const index of this.deps.transfer.blobIndexes(manifest)) {
      if (index.replicationLaneId === 'ARTICLE_STATE') { this.deps.authorize(); await this.deps.fetchBlobs(index) }
    }
    this.lazyUploads.clear(); this.lazyDownloads.clear()
  }

  /** 当前已经收到的精确清单进入安装；调用方处理真实本地 Recovery 要求。 */
  async install(localAccountId: number, manifest: SyncPagedSnapshotManifest): Promise<string> {
    this.hold(manifest.snapshotBundleId)
    this.deps.authorize()
    const result = await this.deps.installer.installPagedAsync({ localAccountId, manifest, store: this.deps.genesis.pagedSnapshotStore,
      now: this.deps.now })
    return result.snapshotBundleId
  }

  /** Genesis 没有操作序号，不能只比较 coverage 判断是否需要接收首次已有库。 */
  hasUnobservedGenesis(manifest: SyncPagedSnapshotManifest, observed: Readonly<Record<string, readonly string[]>>): boolean {
    return manifest.lanes.some(lane => {
      for (const record of this.deps.genesis.pagedSnapshotStore.records({ snapshotBundleId: manifest.snapshotBundleId,
        lane: lane.replicationLaneId, kind: 'GENESIS' })) {
        if (!(observed[lane.replicationLaneId] ?? []).includes(String(record.value.genesisBaselineId))) return true
      }
      return false
    })
  }

  /** 两个真实固定视图总是保留字段候选和 Genesis 观察，零操作的既有库也参与合并。 */
  async mergeLocal(input: Pick<RecoveryOptions, 'localAccountId' | 'syncSpaceId' | 'lanes' | 'target'>): Promise<SyncPagedSnapshotManifest> {
    this.deps.authorize()
    const cut = await this.deps.genesis.runPagedAsync({ localAccountId: input.localAccountId, syncSpaceId: input.syncSpaceId, now: this.deps.now })
    this.hold(cut.snapshotBundleId)
    if (input.target) this.hold(input.target.snapshotBundleId)
    if (!input.target) return this.deps.genesis.exportPagedManifest({ snapshotBundleId: cut.snapshotBundleId, selectedLanes: input.lanes })
    return this.deps.genesis.mergePagedRecoveryAsync({ localBundleId: cut.snapshotBundleId, target: input.target,
      selectedLanes: input.lanes, now: this.deps.now })
  }

  /** 真实历史缺口才请求 OWNER 接受；接受对象绑定提前计算的最终 Recovery ID。 */
  async recover(input: RecoveryOptions): Promise<void> {
    const preview = await this.mergeLocal(input)
    await this.install(input.localAccountId, preview)
    await input.pushOperations()
    if (coverageDominates(await input.retained(), preview.coverage)) {
      await this.push(preview.snapshotBundleId, input.lanes)
      return
    }
    if (!this.deps.session.acceptRecoverySnapshot) throw new Error('REBASE_UNSAFE: paged recovery acceptance is unavailable')
    const finalId = this.deps.genesis.pagedVariantId({ snapshotBundleId: preview.snapshotBundleId,
      selectedLanes: input.lanes, snapshotClass: 'BOOTSTRAP_RECOVERY' })
    const acceptance = await input.accept(finalId, input.target?.coverage)
    const bundleId = this.deps.genesis.promotePaged({ snapshotBundleId: preview.snapshotBundleId, selectedLanes: input.lanes,
      snapshotClass: 'BOOTSTRAP_RECOVERY', checkpointId: acceptance.authObjectId, now: this.deps.now })
    await this.push(bundleId, input.lanes)
    this.deps.authorize()
    await this.deps.session.acceptRecoverySnapshot(bundleId, acceptance)
  }

  /** 任何结束路径均释放本轮根，失败不把正文队列传给下一 Peer。 */
  close(): void {
    for (const [bundle, owner] of this.leases) this.deps.genesis.pagedSnapshotStore.lifecycle.release(bundle, owner)
    this.leases.clear(); this.lazyDownloads.clear(); this.lazyUploads.clear()
  }

  /** 每个根只持有一份消费租约，覆盖后续安装和延迟正文读取。 */
  private hold(bundle: string): void {
    if (!this.leases.has(bundle)) this.leases.set(bundle, this.deps.genesis.pagedSnapshotStore.lifecycle.hold(bundle))
  }
}
