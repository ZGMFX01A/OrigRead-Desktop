import { createHash, createPublicKey, verify } from 'node:crypto'
import { PAGED_SNAPSHOT_FORMAT, SNAPSHOT_PAGE_BYTES, type SyncPagedSnapshotManifest, type SyncSnapshotBytePage } from '../../shared/sync-paged-snapshot'
import { SYNC_REPLICATION_LANES } from '../../shared/sync-runtime'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { decodePagedFrontier } from './sync-paged-frontier'

/** 清单签名与旧整包快照分域，防止不同格式之间复用签名。 */
const SIGNING_DOMAIN = 'ORIGREAD_SNAPSHOT_PAGED_V1'

/** P-256 重签产生不同签名字节；同一固定视图复用已发布签名，真实内容变化仍拒绝。 */
export function reusePublishedPagedManifest(input: { rooted: SyncPagedSnapshotManifest; existingJson?: string }): SyncPagedSnapshotManifest | null {
  if (!input.existingJson) return null
  const published = JSON.parse(input.existingJson) as SyncPagedSnapshotManifest
  if (canonicalJson(JSON.stringify({ ...published, authorSignature: '' })) !== canonicalJson(JSON.stringify(input.rooted))) {
    throw new Error('SNAPSHOT_CONFLICT: Snapshot ID names another fixed view')
  }
  return published
}

/** root 绑定完整固定视图、策略、逐页摘要和覆盖度，不依赖业务数据的内存聚合。 */
export function pagedSnapshotRoot(manifest: SyncPagedSnapshotManifest): string {
  const { rootHash: _root, authorSignature: _signature, ...content } = manifest
  return sha256Hex(canonicalJson(JSON.stringify(content)))
}

/** 作者签名只覆盖已提交的页面索引，页面字节由索引中的 SHA-256 验证。 */
export function pagedSnapshotSigningMaterial(manifest: SyncPagedSnapshotManifest): string {
  const { authorSignature: _signature, ...content } = manifest
  return SIGNING_DOMAIN + '\n' + canonicalJson(JSON.stringify(content))
}

/** 在接收页面或执行安装前核验格式、必需 lane、固定 frontier 与作者承诺。 */
export function verifyPagedSnapshotManifest(manifest: SyncPagedSnapshotManifest, authorKey: string): void {
  if (manifest.formatVersion !== PAGED_SNAPSHOT_FORMAT) throw new Error('SNAPSHOT_INCOMPATIBLE: unsupported paged Snapshot format')
  if (!manifest.snapshotBundleId || !manifest.sourceSnapshotBundleId || !manifest.syncSpaceId || !manifest.genesisBaselineId || !manifest.crossDbCutId || !manifest.policyHash) {
    throw new Error('SNAPSHOT_CORRUPTED: paged Snapshot identity is incomplete')
  }
  const seen = new Set<string>()
  for (const lane of manifest.lanes) {
    if (!SYNC_REPLICATION_LANES.includes(lane.replicationLaneId as typeof SYNC_REPLICATION_LANES[number]) || seen.has(lane.replicationLaneId)) {
      throw new Error('SNAPSHOT_CORRUPTED: duplicate or unsupported paged Snapshot lane')
    }
    seen.add(lane.replicationLaneId)
    const frontier = decodePagedFrontier(lane)
    if (canonicalJson(JSON.stringify(frontier)) !== canonicalJson(JSON.stringify(manifest.coverage[lane.replicationLaneId]))) {
      throw new Error('SNAPSHOT_CORRUPTED: paged Snapshot frontier and coverage disagree')
    }
    if (!lane.pageHashes.length || lane.pageHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) || !Number.isSafeInteger(lane.recordCount) || lane.recordCount < 0) {
      throw new Error('SNAPSHOT_CORRUPTED: invalid paged Snapshot index')
    }
  }
  if (Object.keys(manifest.coverage).some(lane => !seen.has(lane))) throw new Error('SNAPSHOT_CORRUPTED: coverage names an absent lane')
  if (!['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'].includes(manifest.snapshotClass) ||
    !Number.isSafeInteger(manifest.capturedAt) || manifest.capturedAt < 0 || !manifest.authorDeviceId) {
    throw new Error('SNAPSHOT_CORRUPTED: invalid paged Snapshot metadata')
  }
  for (const lane of ['AUTH', 'CORE_META', ...manifest.requiredCoreShardIds]) {
    if (!seen.has(lane)) throw new Error('SNAPSHOT_CORRUPTED: required paged Snapshot lane is missing')
  }
  if (pagedSnapshotRoot(manifest) !== manifest.rootHash) throw new Error('SNAPSHOT_CORRUPTED: paged Snapshot root mismatch')
  const key = createPublicKey({ key: Buffer.from(authorKey, 'base64'), format: 'der', type: 'spki' })
  if (!verify('sha256', Buffer.from(pagedSnapshotSigningMaterial(manifest), 'utf8'), key, Buffer.from(manifest.authorSignature, 'base64'))) {
    throw new Error('SNAPSHOT_CORRUPTED: paged Snapshot author signature mismatch')
  }
}

/** 严格 Base64 解码和摘要校验，非法编码、替换页和索引越界均暴露为错误。 */
export function verifySnapshotBytePage(manifest: SyncPagedSnapshotManifest, page: SyncSnapshotBytePage): Buffer {
  const lane = manifest.lanes.find(value => value.replicationLaneId === page.replicationLaneId)
  if (!lane || !Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0 || page.pageIndex >= lane.pageHashes.length) {
    throw new Error('SNAPSHOT_CORRUPTED: page does not belong to the signed Snapshot index')
  }
  const bytes = Buffer.from(page.bytesBase64, 'base64')
  if (bytes.length > SNAPSHOT_PAGE_BYTES || bytes.toString('base64') !== page.bytesBase64 || createHash('sha256').update(bytes).digest('hex') !== lane.pageHashes[page.pageIndex]) {
    throw new Error('SNAPSHOT_CORRUPTED: Snapshot page byte digest mismatch')
  }
  return bytes
}
