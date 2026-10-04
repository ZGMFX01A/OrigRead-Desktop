import type { SyncEndpointSession, SyncSnapshotShardWire } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotManifest, SyncSnapshotPageStatus } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { setImmediate as yieldSnapshotControl } from 'node:timers/promises'
import { snapshotCheckpoint } from './sync-snapshot-execution'

interface TransferOptions {
  manifest: SyncPagedSnapshotManifest
  session: SyncEndpointSession
  authorize: () => void
  now: number
}

/** 分页会话只保留当前字节页；授权在每次网络访问前重新检查。 */
export class SyncPagedSnapshotTransfer {
  constructor(private readonly store: SyncPagedSnapshotStore) {}

  /** 接收固定清单覆盖的缺失页面，再原子建立跨页业务索引；不聚合 lane 正文。 */
  async receive(options: TransferOptions): Promise<void> {
    const owner = this.store.lifecycle.pin(options.manifest.snapshotBundleId)
    try { await this.receivePinned(options) } finally { this.store.lifecycle.release(options.manifest.snapshotBundleId, owner) }
  }

  /** 持有 lease 时恢复缺页，私有接收预约在发布成功时释放。 */
  private async receivePinned(options: TransferOptions): Promise<void> {
    const { manifest, session, authorize, now } = options
    if (!session.fetchSnapshotPage) throw new Error('SNAPSHOT_INCOMPATIBLE: paged fetch is not supported')
    authorize()
    this.store.beginReceive(manifest, now)
    if (this.store.reusable(manifest)) return
    if (this.store.find(manifest.snapshotBundleId)?.state !== 'VERIFIED') this.store.lifecycle.reserve(manifest, manifest.authorDeviceId, now)
    for (const lane of manifest.lanes) {
      for (let index = 0; index < lane.pageHashes.length; index++) {
        authorize()
        if (this.store.hasVerifiedPage({ manifest, lane: lane.replicationLaneId, index })) continue
        // 请求路径使用策略收窄后的 bundle ID，原始 source ID 不能代替签名视图身份。
        const page = await session.fetchSnapshotPage({ snapshotBundleId: manifest.snapshotBundleId,
          lane: lane.replicationLaneId, pageIndex: index })
        authorize()
        if (page.replicationLaneId !== lane.replicationLaneId || page.pageIndex !== index) {
          throw new Error('SNAPSHOT_CORRUPTED: fetched page identity differs from requested page')
        }
        this.store.receivePage(manifest, page)
        // 已提交单页后让控制请求运行；本地立即返回的会话也不能独占主线程整轮收页。
        await yieldSnapshotControl()
        snapshotCheckpoint()
      }
    }
    authorize()
    await this.publishReceived({ manifest, now })
    authorize()
  }

  /** 嵌入式调用保留正式校验；生产组合层覆盖为真实 Worker，不在 Worker 失败时回落。 */
  protected async publishReceived(input: { manifest: SyncPagedSnapshotManifest; now: number }): Promise<void> {
    this.store.verifyAndPublish(input.manifest, input.now)
  }

  /** 先发送清单，再使用接收端持久化页号续传，最后请求验证和安装。 */
  async push(options: TransferOptions): Promise<void> {
    const owner = this.store.lifecycle.pin(options.manifest.snapshotBundleId)
    try { await this.pushPinned(options) } finally { this.store.lifecycle.release(options.manifest.snapshotBundleId, owner) }
  }

  /** 同一固定清单的全部请求共享保留租约。 */
  private async pushPinned(options: TransferOptions): Promise<void> {
    const { manifest, session, authorize } = options
    if (!session.pushPagedSnapshotManifest || !session.pushSnapshotPage ||
      !session.getSnapshotPageStatus || !session.commitPagedSnapshot) {
      throw new Error('SNAPSHOT_INCOMPATIBLE: paged upload contract is incomplete')
    }
    authorize()
    await session.pushPagedSnapshotManifest(manifest)
    authorize()
    const status = await session.getSnapshotPageStatus(manifest.snapshotBundleId)
    validatePageStatus(manifest, status)
    for (const lane of manifest.lanes) {
      const received = new Set(status.receivedPages[lane.replicationLaneId])
      for (let index = 0; index < lane.pageHashes.length; index++) {
        authorize()
        if (received.has(index)) continue
        if (!this.store.hasVerifiedPage({ manifest, lane: lane.replicationLaneId, index })) {
          throw new Error('SNAPSHOT_CORRUPTED: local published page is missing')
        }
        await session.pushSnapshotPage({ snapshotBundleId: manifest.snapshotBundleId, page: {
          replicationLaneId: lane.replicationLaneId, pageIndex: index,
          bytesBase64: this.store.readPage(manifest.snapshotBundleId, lane.replicationLaneId, index).toString('base64') } })
      }
    }
    authorize()
    await session.commitPagedSnapshot(manifest.snapshotBundleId)
  }

  /** 每次只适配一个真实 Blob 引用，沿用现有业务 Blob 授权与传输，不伪造旧格式快照。 */
  *blobIndexes(manifest: SyncPagedSnapshotManifest): Generator<Pick<SyncSnapshotShardWire,
    'replicationLaneId' | 'blobManifestIndexJson' | 'blobReferenceIndexJson'>> {
    for (const lane of manifest.lanes) {
      const references = this.store.records({ snapshotBundleId: manifest.snapshotBundleId,
        lane: lane.replicationLaneId, kind: 'BLOB_REFERENCE' })
      for (const reference of references) {
        const blob = this.store.records({ snapshotBundleId: manifest.snapshotBundleId,
          lane: lane.replicationLaneId, kind: 'BLOB_MANIFEST', blobHash: String(reference.value.hash) }).next().value
        if (!blob) throw new Error('SNAPSHOT_CORRUPTED: indexed Blob reference has no manifest')
        yield { replicationLaneId: lane.replicationLaneId, blobManifestIndexJson: JSON.stringify([blob.value]),
          blobReferenceIndexJson: JSON.stringify([reference.value]) }
      }
    }
  }
}

/** 生产传输显式注入锁外执行器，接收完成必须等待它的实际退出回执。 */
export class SyncBackgroundSnapshotTransfer extends SyncPagedSnapshotTransfer {
  constructor(private readonly execution: { store: SyncPagedSnapshotStore;
    publish(input: { manifest: SyncPagedSnapshotManifest; now: number }): Promise<void> }) { super(execution.store) }

  /** 错误直接传回 owner；不存在内联重试或提前释放租约的替代路径。 */
  protected override publishReceived(input: { manifest: SyncPagedSnapshotManifest; now: number }): Promise<void> {
    return this.execution.publish(input)
  }
}

/** 页号必须属于同一个签名 root，未知 lane、重复页和越界值均拒绝。 */
function validatePageStatus(manifest: SyncPagedSnapshotManifest, status: SyncSnapshotPageStatus): void {
  if (status.rootHash !== manifest.rootHash || !status.receivedPages || typeof status.receivedPages !== 'object') {
    throw new Error('SNAPSHOT_CONFLICT: resume status names another signed Snapshot')
  }
  const lanes = new Map(manifest.lanes.map(lane => [lane.replicationLaneId, lane]))
  for (const [id, indices] of Object.entries(status.receivedPages)) {
    const lane = lanes.get(id)
    if (!lane || !Array.isArray(indices) || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= lane.pageHashes.length)) {
      throw new Error('SNAPSHOT_CORRUPTED: invalid persisted page status')
    }
  }
  if (manifest.lanes.some(lane => !Object.hasOwn(status.receivedPages, lane.replicationLaneId))) {
    throw new Error('SNAPSHOT_CORRUPTED: page status omits a signed lane')
  }
}
