import { frozenSnapshotDatabase } from './sync-frozen-database-context'
import type { DatabaseSync } from 'node:sqlite'
import type {
  SyncActorStatus,
  SyncGenesisSessionRecord,
  SyncOperationRecord,
  SyncOutboxRecord,
  SyncReplicationLane,
  SyncSnapshotBundleRecord,
  SyncSnapshotShardRecord,
  SyncSpaceLifecycleState
} from '../../shared/sync-runtime'
import type { SyncAuthProtocolObject, SyncCoverage } from '../../shared/sync-protocol'

export interface SyncLocalSpaceBindingRecord {
  localAccountId: number
  syncSpaceId: string
  lifecycleState: SyncSpaceLifecycleState
  genesisSessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface SyncDeviceIdentityRecord {
  deviceId: string
  witnessId: string
  createdAt: number
  updatedAt: number
}

export interface SyncActorRecord {
  actorIncarnationId: string
  syncSpaceId: string
  deviceId: string
  status: SyncActorStatus
  createdAt: number
  retiredAt: number | null
}

export interface SyncLaneWriterStateRecord {
  syncSpaceId: string
  actorIncarnationId: string
  replicationLaneId: SyncReplicationLane
  lastSequence: number
  updatedAt: number
}

export interface SyncAppliedFrontierRecord {
  syncSpaceId: string
  replicationLaneId: SyncReplicationLane
  actorIncarnationId: string
  appliedPrefix: number
  updatedAt: number
}

export interface ActiveAuthGrant {
  authGrantId: string
  authEpoch: number
  isOwner: boolean
}

export class SyncRuntimeRepository {
  /** 冻结转换只读取当前 cut 的副本，正常业务使用注入的数据库。 */
  private readonly liveDatabase: DatabaseSync
  private get database(): DatabaseSync { return frozenSnapshotDatabase(this.liveDatabase) }
  actorBelongsTo(syncSpaceId: string, actorIncarnationId: string, authorDeviceId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM sync_actor_author
      WHERE sync_space_id=? AND actor_incarnation_id=? AND author_device_id=?`)
      .get(syncSpaceId, actorIncarnationId, authorDeviceId))
  }
  private savepointCounter = 0

  constructor(database: DatabaseSync) {
    this.liveDatabase = database
}

  /** Internal Sync Core handle; business repositories must not depend on this. */
  databaseHandle(): DatabaseSync { return this.database }

  transaction<T>(work: () => T): T {
    const savepoint = `origread_sync_${++this.savepointCounter}`
    this.database.exec(`SAVEPOINT ${savepoint}`)
    try {
      const result = work()
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    }
  }

  findBinding(localAccountId: number): SyncLocalSpaceBindingRecord | null {
    const row = this.database.prepare(`
      SELECT b.* FROM sync_local_space_binding b
      INNER JOIN accounts a ON a.id=b.local_account_id
      WHERE b.local_account_id=?
      LIMIT 1
    `)
      .get(localAccountId) as Record<string, unknown> | undefined
    return row ? toBinding(row) : null
  }

  findBindingBySpace(syncSpaceId: string): SyncLocalSpaceBindingRecord | null {
    const row = this.database.prepare(`
      SELECT b.* FROM sync_local_space_binding b
      INNER JOIN accounts a ON a.id=b.local_account_id
      WHERE b.sync_space_id=?
      LIMIT 1
    `)
      .get(syncSpaceId) as Record<string, unknown> | undefined
    return row ? toBinding(row) : null
  }

  listOrphanBindings(): SyncLocalSpaceBindingRecord[] {
    const rows = this.database.prepare(`
      SELECT b.* FROM sync_local_space_binding b
      LEFT JOIN accounts a ON a.id=b.local_account_id
      WHERE a.id IS NULL
      ORDER BY b.local_account_id
    `).all() as unknown as Array<Record<string, unknown>>
    return rows.map(toBinding)
  }

  upsertBinding(value: SyncLocalSpaceBindingRecord): void {
    this.database.prepare(`
      INSERT INTO sync_local_space_binding(
        local_account_id,sync_space_id,lifecycle_state,genesis_session_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)
      ON CONFLICT(local_account_id) DO UPDATE SET
        sync_space_id=excluded.sync_space_id,
        lifecycle_state=excluded.lifecycle_state,
        genesis_session_id=excluded.genesis_session_id,
        updated_at=excluded.updated_at
    `).run(
      value.localAccountId,
      value.syncSpaceId,
      value.lifecycleState,
      value.genesisSessionId,
      value.createdAt,
      value.updatedAt
    )
  }

  deleteBinding(localAccountId: number): void {
    this.clearSpaceJoinBootstrap(localAccountId)
    this.database.prepare('DELETE FROM sync_local_space_binding WHERE local_account_id=?')
      .run(localAccountId)
  }

  clearSpaceJoinBootstrap(localAccountId: number): void {
    this.database.prepare('DELETE FROM sync_space_join_bootstrap WHERE local_account_id=?')
      .run(localAccountId)
  }

  findDeviceIdentity(): SyncDeviceIdentityRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_device_identity WHERE singleton_id=1')
      .get() as Record<string, unknown> | undefined
    return row ? {
      deviceId: String(row.device_id),
      witnessId: String(row.witness_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    } : null
  }

  replaceDeviceIdentity(value: SyncDeviceIdentityRecord): void {
    this.database.prepare(`
      INSERT INTO sync_device_identity(singleton_id,device_id,witness_id,created_at,updated_at)
      VALUES(1,?,?,?,?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        device_id=excluded.device_id,
        witness_id=excluded.witness_id,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
    `).run(value.deviceId, value.witnessId, value.createdAt, value.updatedAt)
  }

  findActiveActor(syncSpaceId: string): SyncActorRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_actor_incarnation
      WHERE sync_space_id=? AND status='ACTIVE'
      ORDER BY created_at DESC,actor_incarnation_id DESC LIMIT 1
    `).get(syncSpaceId) as Record<string, unknown> | undefined
    return row ? toActor(row) : null
  }

  listActors(syncSpaceId: string): SyncActorRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_actor_incarnation
      WHERE sync_space_id=?
      ORDER BY created_at ASC,actor_incarnation_id ASC
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toActor)
  }

  findActor(actorIncarnationId: string): SyncActorRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_actor_incarnation WHERE actor_incarnation_id=? LIMIT 1
    `).get(actorIncarnationId) as Record<string, unknown> | undefined
    return row ? toActor(row) : null
  }

  insertActor(value: SyncActorRecord): void {
    this.database.prepare(`
      INSERT INTO sync_actor_incarnation(
        actor_incarnation_id,sync_space_id,device_id,status,created_at,retired_at
      ) VALUES(?,?,?,?,?,?)
    `).run(
      value.actorIncarnationId,
      value.syncSpaceId,
      value.deviceId,
      value.status,
      value.createdAt,
      value.retiredAt
    )
  }

  retireActor(actorIncarnationId: string, retiredAt: number): void {
    this.database.prepare(`
      UPDATE sync_actor_incarnation SET status='RETIRED',retired_at=?
      WHERE actor_incarnation_id=? AND status='ACTIVE'
    `).run(retiredAt, actorIncarnationId)
  }

  listWriterStates(syncSpaceId: string, actorIncarnationId: string): SyncLaneWriterStateRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_lane_writer_state
      WHERE sync_space_id=? AND actor_incarnation_id=?
      ORDER BY replication_lane_id ASC
    `).all(syncSpaceId, actorIncarnationId) as unknown as Array<Record<string, unknown>>
    return rows.map(toWriterState)
  }

  findWriterState(syncSpaceId: string, actorIncarnationId: string, lane: SyncReplicationLane): SyncLaneWriterStateRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_lane_writer_state
      WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=?
    `).get(syncSpaceId, actorIncarnationId, lane) as Record<string, unknown> | undefined
    return row ? toWriterState(row) : null
  }

  upsertWriterState(value: SyncLaneWriterStateRecord): void {
    this.database.prepare(`
      INSERT INTO sync_lane_writer_state(
        sync_space_id,actor_incarnation_id,replication_lane_id,last_sequence,updated_at
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(sync_space_id,actor_incarnation_id,replication_lane_id) DO UPDATE SET
        last_sequence=excluded.last_sequence,updated_at=excluded.updated_at
    `).run(value.syncSpaceId, value.actorIncarnationId, value.replicationLaneId, value.lastSequence, value.updatedAt)
  }

  listAppliedFrontiers(syncSpaceId: string): SyncAppliedFrontierRecord[] {
    const rows = this.database.prepare(`
      SELECT sync_space_id,replication_lane_id,actor_incarnation_id,applied_prefix,updated_at
      FROM sync_coverage WHERE sync_space_id=?
      ORDER BY replication_lane_id ASC,actor_incarnation_id ASC
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      syncSpaceId: String(row.sync_space_id),
      replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
      actorIncarnationId: String(row.actor_incarnation_id),
      appliedPrefix: Number(row.applied_prefix),
      updatedAt: Number(row.updated_at)
    }))
  }

  insertOutbox(value: SyncOutboxRecord): void {
    this.database.prepare(`
      INSERT INTO sync_outbox(
        outbox_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,
        entity_type,entity_sync_id,entity_generation,mutation_type,payload_schema_version,
        payload_json,causal_context_json,observed_entity_version_json,status,created_at,updated_at
        ,genesis_included_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      value.outboxId,
      value.syncSpaceId,
      value.actorIncarnationId,
      value.replicationLaneId,
      value.sequence,
      value.entityType,
      value.entitySyncId,
      value.entityGeneration,
      value.mutationType,
      value.payloadSchemaVersion,
      value.payloadJson,
      value.causalContextJson,
      value.observedEntityVersionJson,
      value.status,
      value.createdAt,
      value.updatedAt,
      value.genesisIncludedAt
    )
  }

  listPendingOutbox(syncSpaceId: string, limit = 100): SyncOutboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_outbox
      WHERE sync_space_id=? AND status='PENDING_BUILD'
        AND genesis_included_at IS NULL
      ORDER BY created_at,actor_incarnation_id,replication_lane_id,sequence LIMIT ?
    `).all(syncSpaceId, limit) as unknown as Array<Record<string, unknown>>
    return rows.map(toOutbox)
  }

  listGenesisCandidates(syncSpaceId: string): SyncOutboxRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_outbox
      WHERE sync_space_id=?
        AND status IN ('PENDING_BUILD','BUILT')
        AND genesis_included_at IS NULL
      ORDER BY created_at,actor_incarnation_id,replication_lane_id,sequence
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toOutbox)
  }

  markOutboxBuilt(outboxId: string, updatedAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE sync_outbox SET status='BUILT',updated_at=?
      WHERE outbox_id=? AND status='PENDING_BUILD'
    `).run(updatedAt, outboxId)
    return Number(result.changes) === 1
  }

  markOutboxGenesisIncluded(outboxId: string, includedAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE sync_outbox
      SET status='BUILT',genesis_included_at=?,updated_at=?
      WHERE outbox_id=? AND status IN ('PENDING_BUILD','BUILT') AND genesis_included_at IS NULL
    `).run(includedAt, includedAt, outboxId)
    return Number(result.changes) === 1
  }

  upsertGenesisSession(value: SyncGenesisSessionRecord): void {
    this.database.prepare(`
      INSERT INTO sync_genesis_session(
        genesis_session_id,sync_space_id,genesis_baseline_id,cross_db_cut_id,stage,
        captured_at,lane_frontiers_json,error_message,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(genesis_session_id) DO UPDATE SET
        sync_space_id=excluded.sync_space_id,
        genesis_baseline_id=excluded.genesis_baseline_id,
        cross_db_cut_id=excluded.cross_db_cut_id,
        stage=excluded.stage,
        captured_at=excluded.captured_at,
        lane_frontiers_json=excluded.lane_frontiers_json,
        error_message=excluded.error_message,
        updated_at=excluded.updated_at
    `).run(
      value.genesisSessionId,
      value.syncSpaceId,
      value.genesisBaselineId,
      value.crossDbCutId,
      value.stage,
      value.capturedAt,
      value.laneFrontiersJson,
      value.errorMessage,
      value.createdAt,
      value.updatedAt
    )
  }

  findGenesisSession(genesisSessionId: string): SyncGenesisSessionRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM sync_genesis_session WHERE genesis_session_id=? LIMIT 1'
    ).get(genesisSessionId) as Record<string, unknown> | undefined
    return row ? toGenesisSession(row) : null
  }

  findLatestGenesisSession(syncSpaceId: string): SyncGenesisSessionRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_genesis_session
      WHERE sync_space_id=?
      ORDER BY updated_at DESC,genesis_session_id DESC LIMIT 1
    `).get(syncSpaceId) as Record<string, unknown> | undefined
    return row ? toGenesisSession(row) : null
  }

  /** 本地捕获与已安装分页基线都必须进入后续操作的因果上下文。 */
  observedGenesisBaselinesByLane(syncSpaceId: string): Record<string, string[]> {
    const observed = new Map<string, Set<string>>()
    const latest = this.findLatestGenesisSession(syncSpaceId)
    if (latest && ['SNAPSHOT_BUILT', 'TAIL_REPLAY', 'ACTIVE'].includes(latest.stage)) {
      for (const lane of ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH']) {
        observed.set(lane, new Set([latest.genesisBaselineId]))
      }
    }
    const rows = this.database.prepare(`
      SELECT replication_lane_id,genesis_coverage_json
      FROM sync_snapshot_shard
      WHERE sync_space_id=?
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    for (const row of rows) {
      const lane = String(row.replication_lane_id)
      let baselines: unknown = []
      try { baselines = JSON.parse(String(row.genesis_coverage_json ?? '[]')) } catch { baselines = [] }
      if (!Array.isArray(baselines)) continue
      const values = observed.get(lane) ?? new Set<string>()
      for (const baseline of baselines) if (typeof baseline === 'string' && baseline) values.add(baseline)
      if (values.size) observed.set(lane, values)
    }
    // 只使用已入业务快照 journal 的记录；已收到但未安装的页面不能变成因果观察。
    const paged = this.database.prepare(`SELECT r.replication_lane_id,
      json_extract(r.record_json,'$.value.genesisBaselineId') AS baseline
      FROM sync_paged_snapshot_record r JOIN sync_snapshot_bundle b ON b.snapshot_bundle_id=r.snapshot_bundle_id
      WHERE b.sync_space_id=? AND r.kind='GENESIS' AND (
        EXISTS(SELECT 1 FROM sync_genesis_session g WHERE g.genesis_session_id=b.genesis_session_id
          AND g.sync_space_id=b.sync_space_id AND g.genesis_baseline_id=b.genesis_baseline_id)
        OR EXISTS(SELECT 1 FROM sync_recovery_capsule c WHERE c.sync_space_id=b.sync_space_id
          AND c.target_snapshot_bundle_id=b.snapshot_bundle_id AND c.reason IN ('SNAPSHOT_BASELINE_READY','SNAPSHOT_INSTALL_READY')))
      ORDER BY r.replication_lane_id,r.record_key`).iterate(syncSpaceId)
    for (const row of paged) {
      const lane = String(row.replication_lane_id)
      const values = observed.get(lane) ?? new Set<string>()
      values.add(String(row.baseline))
      observed.set(lane, values)
    }
    return Object.fromEntries(
      [...observed.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([lane, values]) => [lane, [...values].sort()])
    )
  }

  upsertSnapshotBundle(value: SyncSnapshotBundleRecord): void {
    this.database.prepare(`
      INSERT INTO sync_snapshot_bundle(
        snapshot_bundle_id,sync_space_id,genesis_session_id,genesis_baseline_id,
        snapshot_class,auth_stability_checkpoint_id,root_hash,policy_hash,captured_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_bundle_id) DO UPDATE SET
        sync_space_id=excluded.sync_space_id,
        genesis_session_id=excluded.genesis_session_id,
        genesis_baseline_id=excluded.genesis_baseline_id,
        snapshot_class=excluded.snapshot_class,
        auth_stability_checkpoint_id=excluded.auth_stability_checkpoint_id,
        root_hash=excluded.root_hash,
        policy_hash=excluded.policy_hash,
        captured_at=excluded.captured_at,
        created_at=excluded.created_at
    `).run(
      value.snapshotBundleId,
      value.syncSpaceId,
      value.genesisSessionId,
      value.genesisBaselineId,
      value.snapshotClass,
      value.authStabilityCheckpointId ?? null,
      value.rootHash,
      value.policyHash,
      value.capturedAt,
      value.createdAt
    )
  }

  findSnapshotBundle(snapshotBundleId: string): SyncSnapshotBundleRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM sync_snapshot_bundle WHERE snapshot_bundle_id=? LIMIT 1'
    ).get(snapshotBundleId) as Record<string, unknown> | undefined
    return row ? toSnapshotBundle(row) : null
  }

  findLatestSnapshotBundle(
    syncSpaceId: string,
    snapshotClass?: SyncSnapshotBundleRecord['snapshotClass']
  ): SyncSnapshotBundleRecord | null {
    const row = snapshotClass
      ? this.database.prepare(
          'SELECT * FROM sync_snapshot_bundle WHERE sync_space_id=? AND snapshot_class=? ' +
          'ORDER BY created_at DESC,snapshot_bundle_id DESC LIMIT 1'
        ).get(syncSpaceId, snapshotClass) as Record<string, unknown> | undefined
      : this.database.prepare(
          'SELECT * FROM sync_snapshot_bundle WHERE sync_space_id=? ' +
          'ORDER BY created_at DESC,snapshot_bundle_id DESC LIMIT 1'
        ).get(syncSpaceId) as Record<string, unknown> | undefined
    return row ? toSnapshotBundle(row) : null
  }

  findLatestExportableSnapshotBundle(
    syncSpaceId: string,
    snapshotClass?: SyncSnapshotBundleRecord['snapshotClass']
  ): SyncSnapshotBundleRecord | null {
    const classClause = snapshotClass ? 'AND b.snapshot_class=?' : ''
    const sql =
      'SELECT b.* FROM sync_snapshot_bundle b ' +
      'INNER JOIN sync_genesis_session g ON g.genesis_session_id=b.genesis_session_id ' +
      'WHERE b.sync_space_id=? ' + classClause +
      ' ORDER BY b.created_at DESC,b.snapshot_bundle_id DESC LIMIT 1'
    const row = (snapshotClass
      ? this.database.prepare(sql).get(syncSpaceId, snapshotClass)
      : this.database.prepare(sql).get(syncSpaceId)) as Record<string, unknown> | undefined
    return row ? toSnapshotBundle(row) : null
  }

  upsertSnapshotShard(value: SyncSnapshotShardRecord): void {
    this.database.prepare(`
      INSERT INTO sync_snapshot_shard(
        snapshot_bundle_id,sync_space_id,replication_lane_id,frontier_json,entity_state_json,
        field_version_state_json,causal_metadata_json,genesis_coverage_json,
        deletion_generation_summary_json,blob_manifest_index_json,blob_reference_index_json,content_hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_bundle_id,replication_lane_id) DO UPDATE SET
        sync_space_id=excluded.sync_space_id,
        frontier_json=excluded.frontier_json,
        entity_state_json=excluded.entity_state_json,
        field_version_state_json=excluded.field_version_state_json,
        causal_metadata_json=excluded.causal_metadata_json,
        genesis_coverage_json=excluded.genesis_coverage_json,
        deletion_generation_summary_json=excluded.deletion_generation_summary_json,
        blob_manifest_index_json=excluded.blob_manifest_index_json,
        blob_reference_index_json=excluded.blob_reference_index_json,
        content_hash=excluded.content_hash,
        created_at=excluded.created_at
    `).run(
      value.snapshotBundleId,
      value.syncSpaceId,
      value.replicationLaneId,
      value.frontierJson,
      value.entityStateJson,
      value.fieldVersionStateJson,
      value.causalMetadataJson,
      value.genesisCoverageJson,
      value.deletionGenerationSummaryJson,
      value.blobManifestIndexJson,
      value.blobReferenceIndexJson,
      value.contentHash,
      value.createdAt
    )
  }

  listSnapshotShards(snapshotBundleId: string): SyncSnapshotShardRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_snapshot_shard
      WHERE snapshot_bundle_id=?
      ORDER BY replication_lane_id ASC
    `).all(snapshotBundleId) as unknown as Array<Record<string, unknown>>
    return rows.map(toSnapshotShard)
  }

  listSnapshotShardDescriptors(snapshotBundleId: string): Array<{
    replicationLaneId: SyncReplicationLane
    frontierJson: string
    contentHash: string
  }> {
    const rows = this.database.prepare(`
      SELECT replication_lane_id,frontier_json,content_hash
      FROM sync_snapshot_shard
      WHERE snapshot_bundle_id=?
      ORDER BY replication_lane_id ASC
    `).all(snapshotBundleId) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
      frontierJson: String(row.frontier_json),
      contentHash: String(row.content_hash)
    }))
  }

  findSnapshotShard(snapshotBundleId: string, lane: SyncReplicationLane | string): SyncSnapshotShardRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_snapshot_shard
      WHERE snapshot_bundle_id=? AND replication_lane_id=?
      LIMIT 1
    `).get(snapshotBundleId, lane) as Record<string, unknown> | undefined
    return row ? toSnapshotShard(row) : null
  }

  upsertSnapshotStreamStage(value: {
    syncSpaceId: string
    snapshotBundleId: string
    sourceSnapshotBundleId: string
    transportPeerDeviceId: string
    manifestJson: string
    state: string
    createdAt: number
    updatedAt: number
  }): void {
    this.database.prepare(`
      INSERT INTO sync_snapshot_stream_stage(
        sync_space_id,snapshot_bundle_id,source_snapshot_bundle_id,transport_peer_device_id,
        manifest_json,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,snapshot_bundle_id) DO UPDATE SET
        source_snapshot_bundle_id=excluded.source_snapshot_bundle_id,
        transport_peer_device_id=excluded.transport_peer_device_id,
        manifest_json=excluded.manifest_json,
        state=excluded.state,
        updated_at=excluded.updated_at
    `).run(
      value.syncSpaceId,
      value.snapshotBundleId,
      value.sourceSnapshotBundleId,
      value.transportPeerDeviceId,
      value.manifestJson,
      value.state,
      value.createdAt,
      value.updatedAt
    )
  }

  findSnapshotStreamStage(syncSpaceId: string, snapshotBundleId: string): {
    syncSpaceId: string
    snapshotBundleId: string
    sourceSnapshotBundleId: string
    transportPeerDeviceId: string
    manifestJson: string
    state: string
    createdAt: number
    updatedAt: number
  } | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_snapshot_stream_stage
      WHERE sync_space_id=? AND snapshot_bundle_id=?
      LIMIT 1
    `).get(syncSpaceId, snapshotBundleId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      syncSpaceId: String(row.sync_space_id),
      snapshotBundleId: String(row.snapshot_bundle_id),
      sourceSnapshotBundleId: String(row.source_snapshot_bundle_id),
      transportPeerDeviceId: String(row.transport_peer_device_id),
      manifestJson: String(row.manifest_json),
      state: String(row.state),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  upsertSnapshotStreamShard(value: {
    syncSpaceId: string
    snapshotBundleId: string
    replicationLaneId: string
    contentHash: string
    shardJson: string
    updatedAt: number
  }): void {
    this.database.prepare(`
      INSERT INTO sync_snapshot_stream_shard(
        sync_space_id,snapshot_bundle_id,replication_lane_id,content_hash,shard_json,updated_at
      ) VALUES(?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,snapshot_bundle_id,replication_lane_id) DO UPDATE SET
        content_hash=excluded.content_hash,
        shard_json=excluded.shard_json,
        updated_at=excluded.updated_at
    `).run(
      value.syncSpaceId,
      value.snapshotBundleId,
      value.replicationLaneId,
      value.contentHash,
      value.shardJson,
      value.updatedAt
    )
  }

  findSnapshotStreamShard(syncSpaceId: string, snapshotBundleId: string, lane: string): {
    contentHash: string
    shardJson: string
    updatedAt: number
  } | null {
    const row = this.database.prepare(`
      SELECT content_hash,shard_json,updated_at
      FROM sync_snapshot_stream_shard
      WHERE sync_space_id=? AND snapshot_bundle_id=? AND replication_lane_id=?
      LIMIT 1
    `).get(syncSpaceId, snapshotBundleId, lane) as Record<string, unknown> | undefined
    return row
      ? {
          contentHash: String(row.content_hash),
          shardJson: String(row.shard_json),
          updatedAt: Number(row.updated_at)
        }
      : null
  }

  countSnapshotStreamShards(syncSpaceId: string, snapshotBundleId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM sync_snapshot_stream_shard
      WHERE sync_space_id=? AND snapshot_bundle_id=?
    `).get(syncSpaceId, snapshotBundleId) as { count: number | bigint }
    return Number(row.count)
  }

  deleteSnapshotStreamStage(syncSpaceId: string, snapshotBundleId: string): void {
    this.database.prepare(
      'DELETE FROM sync_snapshot_stream_shard WHERE sync_space_id=? AND snapshot_bundle_id=?'
    ).run(syncSpaceId, snapshotBundleId)
    this.database.prepare(
      'DELETE FROM sync_snapshot_stream_stage WHERE sync_space_id=? AND snapshot_bundle_id=?'
    ).run(syncSpaceId, snapshotBundleId)
  }

  deleteExpiredSnapshotStreamStages(cutoff: number): number {
    // 分页清单的续传 journal 随安装/恢复生命周期保留，不沿用旧整 shard 传输的 TTL。
    return this.transaction(() => {
      this.database.prepare(`
        DELETE FROM sync_snapshot_stream_shard
        WHERE EXISTS (
          SELECT 1 FROM sync_snapshot_stream_stage s
          WHERE s.sync_space_id = sync_snapshot_stream_shard.sync_space_id
            AND s.snapshot_bundle_id = sync_snapshot_stream_shard.snapshot_bundle_id
            AND s.updated_at < ?
            AND json_extract(s.manifest_json, '$.formatVersion') IS NOT 3
        )
      `).run(cutoff)
      const result = this.database.prepare(
        "DELETE FROM sync_snapshot_stream_stage WHERE updated_at < ? AND json_extract(manifest_json, '$.formatVersion') IS NOT 3"
      ).run(cutoff)
      return Number(result.changes)
    })
  }

  upsertGenesisOperationCoverage(operationId: string, genesisSessionId: string, includedAt: number): void {
    this.database.prepare(`
      INSERT INTO sync_genesis_operation_coverage(operation_id,genesis_session_id,included_at)
      VALUES(?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET
        genesis_session_id=excluded.genesis_session_id,
        included_at=excluded.included_at
    `).run(operationId, genesisSessionId, includedAt)
  }

  insertOperationIgnore(value: SyncOperationRecord): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO sync_operation_log(
        operation_id,sync_space_id,author_device_id,actor_incarnation_id,replication_lane_id,sequence,
        logical_clock,causal_context_json,dependency_dots_json,entity_type,entity_sync_id,entity_generation,
        operation_type,payload_schema_version,payload_json,schema_version,auth_grant_id,auth_epoch,
        created_wall_clock,payload_hash,signing_digest,author_signature,build_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      value.operationId, value.syncSpaceId, value.authorDeviceId, value.actorIncarnationId,
      value.replicationLaneId, value.sequence, value.logicalClock, value.causalContextJson,
      value.dependencyDotsJson, value.entityType, value.entitySyncId, value.entityGeneration,
      value.operationType, value.payloadSchemaVersion, value.payloadJson, value.schemaVersion,
      value.authGrantId, value.authEpoch, value.createdWallClock, value.payloadHash,
      value.signingDigest, value.authorSignature, value.buildStatus, value.createdAt, value.updatedAt
    )
    return Number(result.changes) === 1
  }

  findOperation(operationId: string): SyncOperationRecord | null {
    const row = this.database.prepare('SELECT * FROM sync_operation_log WHERE operation_id=? LIMIT 1')
      .get(operationId) as Record<string, unknown> | undefined
    return row ? toOperation(row) : null
  }

  findOperationByDot(
    actorIncarnationId: string,
    replicationLaneId: SyncReplicationLane,
    sequence: number
  ): SyncOperationRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM sync_operation_log
      WHERE actor_incarnation_id=? AND replication_lane_id=? AND sequence=?
      LIMIT 1
    `).get(actorIncarnationId, replicationLaneId, sequence) as Record<string, unknown> | undefined
    return row ? toOperation(row) : null
  }

  listOperationsByStatus(
    syncSpaceId: string,
    buildStatus: SyncOperationRecord['buildStatus'],
    limit = 100
  ): SyncOperationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_operation_log
      WHERE sync_space_id=? AND build_status=?
        AND NOT EXISTS (
          SELECT 1 FROM sync_genesis_operation_coverage coverage
          WHERE coverage.operation_id=sync_operation_log.operation_id
        )
      ORDER BY actor_incarnation_id,replication_lane_id,sequence
      LIMIT ?
    `).all(syncSpaceId, buildStatus, limit) as unknown as Array<Record<string, unknown>>
    return rows.map(toOperation)
  }

  listSignedOperations(syncSpaceId: string, limit = 10_000): SyncOperationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_operation_log
      WHERE sync_space_id=? AND build_status='SIGNED'
      ORDER BY replication_lane_id,actor_incarnation_id,sequence
      LIMIT ?
    `).all(syncSpaceId, limit) as unknown as Array<Record<string, unknown>>
    return rows.map(toOperation)
  }

  listAllOperationsForRecovery(syncSpaceId: string): SyncOperationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_operation_log
      WHERE sync_space_id=?
      ORDER BY replication_lane_id,actor_incarnation_id,sequence
    `).all(syncSpaceId) as unknown as Array<Record<string, unknown>>
    return rows.map(toOperation)
  }

  /** 固定视图捕获按游标读取历史，避免一次装载全部 operation payload。 */
  *iterateOperationsForSnapshot(syncSpaceId: string): Generator<SyncOperationRecord> {
    const rows = this.database.prepare(`SELECT * FROM sync_operation_log WHERE sync_space_id=?
      ORDER BY replication_lane_id,actor_incarnation_id,sequence`).iterate(syncSpaceId)
    for (const row of rows) yield toOperation(row)
  }

  /** AUTH 对象逐条导出，整个 ledger 不再作为不可拆的大型快照实体。 */
  *iterateAuthForSnapshot(syncSpaceId: string): Generator<SyncAuthProtocolObject> {
    const rows = this.database.prepare(`SELECT auth_object_json FROM sync_auth_ledger WHERE sync_space_id=?
      ORDER BY auth_epoch,json_extract(auth_object_json,'$.authSequence'),auth_object_id`).iterate(syncSpaceId)
    for (const row of rows) yield JSON.parse(String(row.auth_object_json)) as SyncAuthProtocolObject
  }

  listRelayRange(
    syncSpaceId: string,
    actorIncarnationId: string,
    replicationLaneId: string,
    fromSequence: number,
    toSequence: number,
    limit = 500
  ): SyncOperationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM sync_operation_log
      WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=?
        AND sequence >= ? AND sequence <= ?
        AND NOT EXISTS (SELECT 1 FROM sync_inbox_operation inbox WHERE inbox.operation_id=sync_operation_log.operation_id AND inbox.state='REJECTED')
      ORDER BY sequence ASC
      LIMIT ?
    `).all(syncSpaceId, actorIncarnationId, replicationLaneId, fromSequence, toSequence, limit) as unknown as Array<Record<string, unknown>>
    return rows.map(toOperation)
  }

  /** 计算本地已签名的所有操作的连续序列号覆盖度 */
  getSignedCoverage(syncSpaceId: string): SyncCoverage {
    const rows = this.database.prepare(`
      SELECT replication_lane_id, actor_incarnation_id, sequence
      FROM sync_operation_log
      WHERE sync_space_id=? AND build_status='SIGNED'
        AND NOT EXISTS (SELECT 1 FROM sync_inbox_operation i WHERE i.operation_id=sync_operation_log.operation_id AND i.state='REJECTED')
      ORDER BY replication_lane_id, actor_incarnation_id, sequence ASC
    `).all(syncSpaceId) as unknown as Array<{ replication_lane_id: string; actor_incarnation_id: string; sequence: number }>

    const result: SyncCoverage = {}
    for (const row of rows) {
      result[row.replication_lane_id] ??= {}
      const current = result[row.replication_lane_id]![row.actor_incarnation_id] ?? 0
      if (row.sequence === current + 1) {
        result[row.replication_lane_id]![row.actor_incarnation_id] = row.sequence
      }
    }
    return result
  }

  /**
   * 按照远端已确认的覆盖度，查询本地尚未推送的已签名操作（支持大日志分批推进读取）。
   */
  listPushableOperations(syncSpaceId: string, remoteReceived: SyncCoverage, limit = 500, include: (operation: SyncOperationRecord) => boolean = () => true): SyncOperationRecord[] {
    const frontiers = Object.entries(remoteReceived).flatMap(([lane, actors]) => Object.entries(actors).map(([actor, prefix]) => [lane, actor, prefix]))
    const values = frontiers.length ? frontiers.map(() => '(?,?,?)').join(',') : "(NULL,NULL,0)"
    const result: SyncOperationRecord[] = []
    let cursor: [string, string, number] = ['', '', 0]
    while (result.length < limit) {
      const rows = this.database.prepare(`WITH remote(lane,actor,prefix) AS (VALUES ${values})
        SELECT log.* FROM sync_operation_log log LEFT JOIN remote
          ON remote.lane=log.replication_lane_id AND remote.actor=log.actor_incarnation_id
        WHERE log.sync_space_id=? AND log.build_status='SIGNED' AND log.sequence>COALESCE(remote.prefix,0)
          AND (log.replication_lane_id,log.actor_incarnation_id,log.sequence)>(?,?,?)
          AND NOT EXISTS(SELECT 1 FROM sync_inbox_operation i WHERE i.operation_id=log.operation_id AND i.state='REJECTED')
          AND NOT EXISTS(SELECT 1 FROM sync_actor_isolation q WHERE q.sync_space_id=log.sync_space_id AND q.actor_incarnation_id=log.actor_incarnation_id)
        ORDER BY log.replication_lane_id,log.actor_incarnation_id,log.sequence LIMIT ?`)
        .all(...frontiers.flat(), syncSpaceId, ...cursor, limit) as unknown as Array<Record<string, unknown>>
      if (!rows.length) break
      for (const row of rows) {
        const operation = toOperation(row)
        cursor = [operation.replicationLaneId, operation.actorIncarnationId, operation.sequence]
        if (include(operation)) result.push(operation)
        if (result.length === limit) return result
      }
    }
    return result
  }

  markOperationSigned(
    operationId: string,
    expectedSigningDigest: string,
    authorSignature: string,
    updatedAt: number
  ): boolean {
    const result = this.database.prepare(`
      UPDATE sync_operation_log
      SET author_signature=?,build_status='SIGNED',updated_at=?
      WHERE operation_id=?
        AND signing_digest=?
        AND build_status='AWAITING_SIGNATURE'
        AND author_signature IS NULL
    `).run(authorSignature, updatedAt, operationId, expectedSigningDigest)
    return Number(result.changes) === 1
  }

  /**
   * 持久化写入或更新 AUTH 协议对象到本地 sync_auth_ledger 表。
   */
  upsertAuthObject(object: SyncAuthProtocolObject, now = Date.now()): void {
    this.database.prepare(`
      INSERT INTO sync_auth_ledger (
        auth_object_id, sync_space_id, auth_epoch, auth_object_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(auth_object_id) DO UPDATE SET
        auth_object_json=excluded.auth_object_json,
        updated_at=excluded.updated_at
    `).run(object.authObjectId, object.syncSpaceId, object.authEpoch, JSON.stringify(object), now)
  }

  /**
   * 读取指定 Sync Space 下所有已持久化的 AUTH 协议对象，严格按 epoch 和 objectId 升序排列。
   */
  listAuthObjects(syncSpaceId: string): SyncAuthProtocolObject[] {
    const rows = this.database.prepare(`
      SELECT auth_object_json FROM sync_auth_ledger
      WHERE sync_space_id = ?
      ORDER BY auth_epoch ASC, auth_object_id ASC
    `).all(syncSpaceId) as unknown as Array<{ auth_object_json: string }>
    return rows.map((r) => JSON.parse(r.auth_object_json) as SyncAuthProtocolObject)
      .sort((a, b) => a.authEpoch - b.authEpoch || (a.authSequence ?? 0) - (b.authSequence ?? 0))
  }

  /**
   * 计算并返回指定设备在目标 Sync Space 下当前生效的活跃 AUTH Grant。
   *
   * @param syncSpaceId 同步空间 ID
   * @param deviceId 设备 ID
   * @return 若当前设备拥有合法活跃授权，返回 ActiveAuthGrant；若未授权或已被撤销，返回 null
   */
  findActiveGrant(syncSpaceId: string, deviceId: string): ActiveAuthGrant | null {
    const objects = this.listAuthObjects(syncSpaceId)
    return computeActiveGrant(objects, deviceId)
  }
}

function toBinding(row: Record<string, unknown>): SyncLocalSpaceBindingRecord {
  return {
    localAccountId: Number(row.local_account_id),
    syncSpaceId: String(row.sync_space_id),
    lifecycleState: String(row.lifecycle_state) as SyncSpaceLifecycleState,
    genesisSessionId: row.genesis_session_id == null ? null : String(row.genesis_session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function toActor(row: Record<string, unknown>): SyncActorRecord {
  return {
    actorIncarnationId: String(row.actor_incarnation_id),
    syncSpaceId: String(row.sync_space_id),
    deviceId: String(row.device_id),
    status: String(row.status) as SyncActorStatus,
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at == null ? null : Number(row.retired_at)
  }
}

function toWriterState(row: Record<string, unknown>): SyncLaneWriterStateRecord {
  return {
    syncSpaceId: String(row.sync_space_id),
    actorIncarnationId: String(row.actor_incarnation_id),
    replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
    lastSequence: Number(row.last_sequence),
    updatedAt: Number(row.updated_at)
  }
}

function toOutbox(row: Record<string, unknown>): SyncOutboxRecord {
  return {
    outboxId: String(row.outbox_id),
    syncSpaceId: String(row.sync_space_id),
    actorIncarnationId: String(row.actor_incarnation_id),
    replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
    sequence: Number(row.sequence),
    entityType: String(row.entity_type),
    entitySyncId: String(row.entity_sync_id),
    entityGeneration: Number(row.entity_generation),
    mutationType: String(row.mutation_type) as SyncOutboxRecord['mutationType'],
    payloadSchemaVersion: Number(row.payload_schema_version),
    payloadJson: String(row.payload_json),
    causalContextJson: String(row.causal_context_json),
    observedEntityVersionJson: row.observed_entity_version_json == null ? null : String(row.observed_entity_version_json),
    status: String(row.status) as SyncOutboxRecord['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    genesisIncludedAt: row.genesis_included_at == null ? null : Number(row.genesis_included_at)
  }
}

function toGenesisSession(row: Record<string, unknown>): SyncGenesisSessionRecord {
  return {
    genesisSessionId: String(row.genesis_session_id),
    syncSpaceId: String(row.sync_space_id),
    genesisBaselineId: String(row.genesis_baseline_id),
    crossDbCutId: String(row.cross_db_cut_id),
    stage: String(row.stage) as SyncGenesisSessionRecord['stage'],
    capturedAt: row.captured_at == null ? null : Number(row.captured_at),
    laneFrontiersJson: String(row.lane_frontiers_json),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function toSnapshotBundle(row: Record<string, unknown>): SyncSnapshotBundleRecord {
  return {
    snapshotBundleId: String(row.snapshot_bundle_id),
    syncSpaceId: String(row.sync_space_id),
    genesisSessionId: String(row.genesis_session_id),
    genesisBaselineId: String(row.genesis_baseline_id),
    snapshotClass: String(row.snapshot_class) as SyncSnapshotBundleRecord['snapshotClass'],
    authStabilityCheckpointId: row.auth_stability_checkpoint_id == null ? null : String(row.auth_stability_checkpoint_id),
    rootHash: String(row.root_hash),
    policyHash: String(row.policy_hash),
    capturedAt: Number(row.captured_at),
    createdAt: Number(row.created_at)
  }
}

function toSnapshotShard(row: Record<string, unknown>): SyncSnapshotShardRecord {
  return {
    snapshotBundleId: String(row.snapshot_bundle_id),
    syncSpaceId: String(row.sync_space_id),
    replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
    frontierJson: String(row.frontier_json),
    entityStateJson: String(row.entity_state_json),
    fieldVersionStateJson: String(row.field_version_state_json),
    causalMetadataJson: String(row.causal_metadata_json),
    genesisCoverageJson: String(row.genesis_coverage_json),
    deletionGenerationSummaryJson: String(row.deletion_generation_summary_json),
    blobManifestIndexJson: String(row.blob_manifest_index_json ?? '[]'),
    blobReferenceIndexJson: String(row.blob_reference_index_json ?? '[]'),
    contentHash: String(row.content_hash),
    createdAt: Number(row.created_at)
  }
}

function toOperation(row: Record<string, unknown>): SyncOperationRecord {
  return {
    operationId: String(row.operation_id),
    syncSpaceId: String(row.sync_space_id),
    authorDeviceId: String(row.author_device_id),
    actorIncarnationId: String(row.actor_incarnation_id),
    replicationLaneId: String(row.replication_lane_id) as SyncReplicationLane,
    sequence: Number(row.sequence),
    logicalClock: Number(row.logical_clock),
    causalContextJson: String(row.causal_context_json),
    dependencyDotsJson: String(row.dependency_dots_json),
    entityType: String(row.entity_type),
    entitySyncId: String(row.entity_sync_id),
    entityGeneration: Number(row.entity_generation),
    operationType: String(row.operation_type) as SyncOperationRecord['operationType'],
    payloadSchemaVersion: Number(row.payload_schema_version),
    payloadJson: String(row.payload_json),
    schemaVersion: Number(row.schema_version),
    authGrantId: row.auth_grant_id == null ? null : String(row.auth_grant_id),
    authEpoch: row.auth_epoch == null ? null : Number(row.auth_epoch),
    createdWallClock: Number(row.created_wall_clock),
    payloadHash: String(row.payload_hash),
    signingDigest: String(row.signing_digest),
    authorSignature: row.author_signature == null ? null : String(row.author_signature),
    buildStatus: String(row.build_status) as SyncOperationRecord['buildStatus'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/**
 * 依据 R10-R13 AUTH 规范，从全量有序的 AUTH 协议对象历史中推导指定设备的生效 Grant。
 *
 * 核心规则：
 * 1. SPACE_ROOT: 设定初始 Owner 及其 Grant；
 * 2. MEMBER_GRANT: 授权新 Member 及其 Grant；
 * 3. OWNER_TRANSFER / OWNER_RECOVERY: 变更 Owner 及其生效 Grant；
 * 4. MEMBER_REVOKE: 撤销指定 Member 授权；
 * 5. 若目标设备当前被撤销或未被授权，返回 null。
 */
export function computeActiveGrant(objects: SyncAuthProtocolObject[], deviceId: string): ActiveAuthGrant | null {
  if (objects.length === 0) return null

  const sorted = [...objects].sort((a, b) => a.authEpoch - b.authEpoch || (a.authSequence ?? 0) - (b.authSequence ?? 0))

  let currentOwner = ''
  let currentOwnerGrantId = ''
  let currentEpoch = 0
  const activeGrants = new Map<string, { authGrantId: string; authEpoch: number }>()
  const revoked = new Set<string>()

  for (const obj of sorted) {
    currentEpoch = Math.max(currentEpoch, obj.authEpoch)

    switch (obj.objectType) {
      case 'SPACE_ROOT':
        currentOwner = obj.ownerDeviceId
        currentOwnerGrantId = obj.authObjectId
        activeGrants.set(obj.ownerDeviceId, { authGrantId: obj.authObjectId, authEpoch: obj.authEpoch })
        revoked.delete(obj.ownerDeviceId)
        break
      case 'OWNER_TRANSFER':
      case 'OWNER_RECOVERY':
        if (obj.targetDeviceId) {
          currentOwner = obj.targetDeviceId
          currentOwnerGrantId = obj.authObjectId
          activeGrants.set(obj.targetDeviceId, { authGrantId: obj.authObjectId, authEpoch: obj.authEpoch })
          revoked.delete(obj.targetDeviceId)
        }
        break
      case 'MEMBER_GRANT':
        if (obj.targetDeviceId) {
          activeGrants.set(obj.targetDeviceId, { authGrantId: obj.authObjectId, authEpoch: obj.authEpoch })
          revoked.delete(obj.targetDeviceId)
        }
        break
      case 'MEMBER_REVOKE':
        if (obj.targetDeviceId) {
          revoked.add(obj.targetDeviceId)
          activeGrants.delete(obj.targetDeviceId)
        }
        break
      case 'AUTH_STABILITY_CHECKPOINT':
        break
    }
  }

  if (revoked.has(deviceId)) {
    return null
  }

  if (deviceId === currentOwner && currentOwnerGrantId) {
    return {
      authGrantId: currentOwnerGrantId,
      authEpoch: currentEpoch,
      isOwner: true
    }
  }

  const memberGrant = activeGrants.get(deviceId)
  if (memberGrant) {
    return {
      authGrantId: memberGrant.authGrantId,
      authEpoch: currentEpoch,
      isOwner: false
    }
  }

  return null
}
