import type { SyncPagedSnapshotManifest, SyncSnapshotBytePage } from '../../shared/sync-paged-snapshot'
import type { SyncSnapshotClass } from '../../shared/sync-runtime'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository } from './sync-state-repository'
import type { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import type { DesktopSnapshotInstallService } from './desktop-snapshot-install-service'
import { canonicalJson } from './sync-operation-canonicalizer'
import { parseSyncJson } from './sync-strict-json'
import { verifyPagedSnapshotManifest } from './sync-paged-snapshot-wire'

interface Dependencies {
  runtime: SyncRuntimeRepository
  state: SyncStateRepository
  genesis: DesktopGenesisSnapshotService
  installer: DesktopSnapshotInstallService
  localAccountId(): number
  policy(syncSpaceId: string): Readonly<Record<string, string>>
}

interface RouteRequest {
  method: string
  segments: readonly string[]
  url: URL
  body: Buffer
  syncSpaceId: string
  remoteDeviceId: string
}

interface RouteResponse { status: number; body: unknown }

/** 该入口仅在 listener 完成 TLS、签名、Space 与兼容号认证后调用。 */
export function handlePagedSnapshotRoute(dependencies: Dependencies, request: RouteRequest): RouteResponse | null {
  if (request.segments[3] !== 'snapshots' || request.segments[5] !== 'pages') return null
  if (request.segments[4] === 'latest' && request.method === 'GET') return latest(dependencies, request)
  const action = request.segments[6]
  if (action === 'job-status' || action === 'job-cancel') return control(dependencies, request)
  if (action === 'manifest' && request.method === 'PUT') return stageManifest(dependencies, request)
  if (action === 'commit' && request.method === 'POST') return commit(dependencies, request)
  if (action === 'status' && request.method === 'GET') {
    const manifest = staged(dependencies, request)
    requireAuthor(dependencies, manifest)
    requirePolicy(dependencies, manifest)
    return { status: 200, body: dependencies.genesis.pagedSnapshotStore.pageStatus(manifest) }
  }
  if (request.segments[7] && ['GET', 'PUT'].includes(request.method)) return page(dependencies, request)
  throw new Error('REQUEST_ERROR: unknown paged Snapshot route')
}

/** 页清单按已协商 lane 读取；暂停域不通过另一个 Snapshot 入口重新公开。 */
function latest(dependencies: Dependencies, request: RouteRequest): RouteResponse {
  const snapshotClass = request.url.searchParams.get('class')
  if (snapshotClass && !['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'].includes(snapshotClass)) throw new Error('REQUEST_ERROR: unknown Snapshot class')
  const bundle = dependencies.runtime.findLatestExportableSnapshotBundle(request.syncSpaceId, snapshotClass as SyncSnapshotClass | undefined)
  if (!bundle) return { status: 200, body: null }
  const manifest = dependencies.genesis.exportPagedManifest({ snapshotBundleId: bundle.snapshotBundleId })
  const requested = request.url.searchParams.get('lanes')?.split(',').filter(Boolean)
  const policy = dependencies.policy(request.syncSpaceId)
  const lanes = new Set(manifest.lanes.filter(lane => enabled(policy, lane.replicationLaneId) &&
    (!requested?.length || requested.includes(lane.replicationLaneId))).map(lane => lane.replicationLaneId))
  if (!lanes.has('AUTH') || !lanes.has('CORE_META') || requested?.some(lane => !lanes.has(lane))) return { status: 200, body: null }
  return { status: 200, body: dependencies.genesis.exportPagedManifest({ snapshotBundleId: bundle.snapshotBundleId, selectedLanes: lanes }) }
}

/** 同一 ID 绑定作者清单和 transport peer，续传不得改写来源或固定视图。 */
function stageManifest(dependencies: Dependencies, request: RouteRequest): RouteResponse {
  const manifest = parseSyncJson<SyncPagedSnapshotManifest>(request.body.toString('utf8'))
  requireIdentity(manifest, request)
  requireAuthor(dependencies, manifest)
  requirePolicy(dependencies, manifest)
  dependencies.genesis.pagedSnapshotStore.lifecycle.reserve(manifest, request.remoteDeviceId, Date.now())
  dependencies.genesis.pagedSnapshotStore.lifecycle.pin(manifest.snapshotBundleId, request.remoteDeviceId)
  const existing = dependencies.runtime.findSnapshotStreamStage(request.syncSpaceId, manifest.snapshotBundleId)
  const encoded = canonicalJson(JSON.stringify(manifest))
  if (existing && (existing.transportPeerDeviceId !== request.remoteDeviceId || canonicalJson(existing.manifestJson) !== encoded)) {
    throw new Error('SNAPSHOT_CONFLICT: Snapshot manifest has another transport source')
  }
  dependencies.genesis.pagedSnapshotStore.beginReceive(manifest, Date.now())
  dependencies.runtime.upsertSnapshotStreamStage({ syncSpaceId: request.syncSpaceId, snapshotBundleId: manifest.snapshotBundleId,
    sourceSnapshotBundleId: manifest.sourceSnapshotBundleId, transportPeerDeviceId: request.remoteDeviceId, manifestJson: encoded,
    state: existing?.state ?? 'RECEIVING', createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() })
  return { status: 200, body: { accepted: true } }
}

/** 页身份由 URL 与签名索引共同确定，接收顺序不影响持久页面主键。 */
function page(dependencies: Dependencies, request: RouteRequest): RouteResponse {
  const bundleId = request.segments[4]!
  const lane = request.segments[6]!
  const indexText = request.segments[7]!
  if (!/^(0|[1-9][0-9]*)$/.test(indexText)) throw new Error('REQUEST_ERROR: invalid Snapshot page index')
  const pageIndex = Number(indexText)
  if (request.method === 'GET') {
    const manifest = dependencies.genesis.exportPagedManifest({ snapshotBundleId: bundleId })
    if (manifest.syncSpaceId !== request.syncSpaceId) throw new Error('SPACE_MISMATCH: Snapshot is outside requested Space')
    const origin = dependencies.runtime.findSnapshotBundle(manifest.sourceSnapshotBundleId)
    if (!origin || origin.syncSpaceId !== request.syncSpaceId || !dependencies.runtime.findGenesisSession(origin.genesisSessionId)) {
      throw new Error('SNAPSHOT_INCOMPATIBLE: Snapshot source is not exportable')
    }
    requirePolicy(dependencies, { ...manifest, lanes: manifest.lanes.filter(item => item.replicationLaneId === lane) })
    return { status: 200, body: dependencies.genesis.exportPagedPage({ snapshotBundleId: bundleId, lane, pageIndex }) }
  }
  const manifest = staged(dependencies, request)
  requireAuthor(dependencies, manifest)
  requirePolicy(dependencies, manifest)
  const value = parseSyncJson<SyncSnapshotBytePage>(request.body.toString('utf8'))
  if (value.replicationLaneId !== lane || value.pageIndex !== pageIndex) throw new Error('SNAPSHOT_CORRUPTED: Snapshot page URL and body disagree')
  dependencies.genesis.pagedSnapshotStore.receivePage(manifest, value)
  return { status: 200, body: { accepted: true, pageIndex } }
}

/** 提交前再次验证授权/策略及全部页面，错误不允许进入业务安装事务。 */
function commit(dependencies: Dependencies, request: RouteRequest): RouteResponse {
  const manifest = staged(dependencies, request)
  requireAuthor(dependencies, manifest)
  requirePolicy(dependencies, manifest)
  if (request.url.searchParams.get('jobs') === 'v1') {
    const jobs = dependencies.installer.snapshotJobs
    if (!jobs) throw new Error('SNAPSHOT_WORKER_REQUIRED')
    const status = jobs.submit({ space: request.syncSpaceId, peer: request.remoteDeviceId,
      account: dependencies.localAccountId(), manifest, now: Date.now() })
    const stage = dependencies.runtime.findSnapshotStreamStage(request.syncSpaceId, manifest.snapshotBundleId)!
    if (status.state !== 'COMPLETED') dependencies.runtime.upsertSnapshotStreamStage({ ...stage, state: 'COMMITTING', updatedAt: Date.now() })
    return { status: status.state === 'COMPLETED' ? 200 : 202, body: status }
  }
  const stage = dependencies.runtime.findSnapshotStreamStage(request.syncSpaceId, manifest.snapshotBundleId)!
  if (!['RECEIVING','COMMITTING','READY'].includes(stage.state)) throw new Error('SNAPSHOT_CONFLICT: invalid Snapshot commit state')
  const store = dependencies.genesis.pagedSnapshotStore
  store.verifyAndPublish(manifest, Date.now())
  dependencies.runtime.upsertSnapshotStreamStage({ ...stage, state: 'COMMITTING', updatedAt: Date.now() })
  try {
    const result = dependencies.installer.installPaged({ localAccountId: dependencies.localAccountId(), manifest, store,
      selectedLanes: new Set(manifest.lanes.map(lane => lane.replicationLaneId)) })
    dependencies.runtime.upsertSnapshotStreamStage({ ...stage, state: 'READY', updatedAt: Date.now() })
    return { status: 200, body: { accepted: true, snapshotBundleId: result.snapshotBundleId,
      materializedEntities: result.materializedEntities, lifecycleState: 'STAGING' } }
  } catch (error) {
    // 安装失败保留固定页面及可重试状态，原始错误继续暴露给同步历史。
    dependencies.runtime.upsertSnapshotStreamStage({ ...stage, state: 'RECEIVING', updatedAt: Date.now() })
    throw error
  }
}

/** 控制操作不读取页、Reader/Chat 或业务路由锁，只核对控制库中的认证来源。 */
function control(dependencies: Dependencies, request: RouteRequest): RouteResponse {
  const jobs = dependencies.installer.snapshotJobs
  if (!jobs) throw new Error('SNAPSHOT_WORKER_REQUIRED')
  const input = { space: request.syncSpaceId, peer: request.remoteDeviceId, manifest: { snapshotBundleId: request.segments[4]! } }
  if (request.method === 'GET' && request.segments[6] === 'job-status') return { status: 200, body: jobs.status(input) }
  if (request.method === 'POST' && request.segments[6] === 'job-cancel') return { status: 200, body: jobs.cancel(input) }
  throw new Error('REQUEST_ERROR: invalid job control method')
}

/** 每个页/commit 都必须持有同一已认证来源的清单，不能只靠 bundle ID 访问别人的 stage。 */
function staged(dependencies: Dependencies, request: RouteRequest): SyncPagedSnapshotManifest {
  const stage = dependencies.runtime.findSnapshotStreamStage(request.syncSpaceId, request.segments[4]!)
  if (!stage || stage.transportPeerDeviceId !== request.remoteDeviceId) throw new Error('SNAPSHOT_CONFLICT: Snapshot stage has no matching transport source')
  const manifest = JSON.parse(stage.manifestJson) as SyncPagedSnapshotManifest
  requireIdentity(manifest, request)
  dependencies.genesis.pagedSnapshotStore.lifecycle.pin(manifest.snapshotBundleId, request.remoteDeviceId)
  return manifest
}

/** 清单属于 URL 声明的同一个 Space/bundle，避免跨空间安装。 */
function requireIdentity(manifest: SyncPagedSnapshotManifest, request: RouteRequest): void {
  if (manifest.syncSpaceId !== request.syncSpaceId || manifest.snapshotBundleId !== request.segments[4]) throw new Error('SPACE_MISMATCH: paged Snapshot endpoint identity mismatch')
}

/** 作者必须仍有有效签名权限，传输 peer 的授权不能替代原作者的授权。 */
function requireAuthor(dependencies: Dependencies, manifest: SyncPagedSnapshotManifest): void {
  const author = dependencies.state.findPeer(manifest.syncSpaceId, manifest.authorDeviceId)
  if (!author || author.status !== 'ACTIVE' || !dependencies.runtime.findActiveGrant(manifest.syncSpaceId, manifest.authorDeviceId)) {
    throw new Error('AUTH_REVOKED: paged Snapshot author is not authorized')
  }
  verifyPagedSnapshotManifest(manifest, author.publicKeySpkiBase64)
}

/** 政策在请求时重新读取；已预约页面不能绕过后来暂停的 lane。 */
function requirePolicy(dependencies: Dependencies, manifest: SyncPagedSnapshotManifest): void {
  const policy = dependencies.policy(manifest.syncSpaceId)
  if (manifest.lanes.some(lane => !enabled(policy, lane.replicationLaneId))) throw new Error('LANE_POLICY_BLOCKED: Snapshot contains a disabled lane')
}

/** lane 是否参与当前端点同步由现有策略决定，不由快照传输格式决定。 */
function enabled(policy: Readonly<Record<string, string>>, lane: string): boolean { return !['PAUSED','LOCAL_PURGE','UNSUPPORTED'].includes(policy[lane] ?? 'ENABLED') }
