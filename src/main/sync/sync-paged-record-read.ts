import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { decodeSnapshotRecord } from './sync-snapshot-records'
import { snapshotCheckpoint } from './sync-snapshot-execution'

/** 保持既有业务排序，末尾唯一记录键保证相同实体的候选也能连续读取。 */
const ORDER_COLUMNS = ['replication_lane_id', 'kind', 'entity_type', 'entity_sync_id', 'generation', 'record_key'] as const
/** 只预取轻量索引键，大正文仍逐条读取。 */
const INDEX_BATCH_ROWS = 256

export interface SnapshotRecordFilter {
  readonly snapshotBundleId: string
  readonly lane?: string
  readonly kind?: SyncSnapshotRecord['kind']
  readonly entityType?: string
  readonly entitySyncId?: string
  readonly generation?: number
  readonly fieldId?: string
  readonly blobHash?: string
  /** 安装断点按唯一业务记录键续读，原 wire 输出仍保持既有排序。 */
  readonly stableKeyOrder?: boolean
}

/** 每次 get 完成后才 yield；取首条或跨网络等待都不会留下共享连接的历史读快照。 */
export function* readSnapshotRecords(database: DatabaseSync, filter: SnapshotRecordFilter,
  decode: (rowId: number, raw: string) => SyncSnapshotRecord = (_id, raw) => decodeSnapshotRecord(raw)): Generator<SyncSnapshotRecord> {
  yield* new SyncSnapshotRecordReader(database).read(filter, decode)
}

/** 固定列组合形成有限 SQL 形状；逐实体遍历不会反复分配同一原生语句。 */
export class SyncSnapshotRecordReader {
  private readonly queries = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  private readonly readRecord: ReturnType<DatabaseSync['prepare']>
  constructor(private readonly database: DatabaseSync) {
    this.readRecord = database.prepare('SELECT record_json FROM sync_paged_snapshot_record WHERE rowid=?')
  }

  /** all/get 在 yield 前已完成；嵌套字段裁决复用语句也不会覆盖仍活动的游标。 */
  *read(filter: SnapshotRecordFilter,
    decode: (rowId: number, raw: string) => SyncSnapshotRecord = (_id, raw) => decodeSnapshotRecord(raw)): Generator<SyncSnapshotRecord> {
    yield* this.render(filter, decode)
  }

  /** 输出旧 wire 可以直接规范编码紧凑记录，避免先展开来源再编码整个对象。 */
  *render<T>(filter: SnapshotRecordFilter, decode: (rowId: number, raw: string) => T): Generator<T> {
    const columns = { replication_lane_id: filter.lane, kind: filter.kind, entity_type: filter.entityType,
      entity_sync_id: filter.entitySyncId, generation: filter.generation, field_id: filter.fieldId, blob_hash: filter.blobHash }
    const selected = Object.entries(columns).filter(([, value]) => value !== undefined)
    const where = ['snapshot_bundle_id=?', ...selected.map(([column]) => column + '=?')].join(' AND ')
    const args: SQLInputValue[] = [filter.snapshotBundleId, ...selected.map(([, value]) => value!)]
    const selectedNames = new Set(selected.map(([column]) => column))
    const order = filter.stableKeyOrder ? KEY_ORDER_COLUMNS : ORDER_COLUMNS
    const seekColumns = order.filter(column => !selectedNames.has(column))
    const projection = ['rowid', ...ORDER_COLUMNS].join(',')
    // 精确实体查询先定位业务键，避免排序覆盖索引为每个父实体扫描整个 bundle。
    const index = filter.entityType !== undefined && filter.entitySyncId !== undefined
      ? ' INDEXED BY index_sync_paged_record_business' : ''
    let after: SQLInputValue[] | undefined
    while (true) {
      const seek = after ? continuation(seekColumns, after) : { clause: '', args: [] }
      const batch = this.query(`SELECT ${projection} FROM sync_paged_snapshot_record${index} WHERE ${where}${seek.clause}
        ORDER BY ${order.join(',')} LIMIT ${INDEX_BATCH_ROWS}`).all(...args, ...seek.args)
      if (!batch.length) return
      after = seekColumns.map(column => batch[batch.length - 1]![column] as SQLInputValue)
      for (const key of batch) {
        snapshotCheckpoint()
        const row = this.readRecord.get(key.rowid!)
        if (!row) throw new Error('SNAPSHOT_CORRUPTED: immutable record disappeared')
        yield decode(Number(key.rowid), String(row.record_json))
      }
    }
  }

  /** 缓存键只含固定列名和占位符，业务身份/正文仍全部参数绑定。 */
  private query(sql: string): ReturnType<DatabaseSync['prepare']> {
    let statement = this.queries.get(sql)
    if (!statement) { statement = this.database.prepare(sql); this.queries.set(sql, statement) }
    return statement
  }
}

/** 唯一键排序只供业务恢复断点使用，不改动已发布 wire 页。 */
const KEY_ORDER_COLUMNS = ['replication_lane_id', 'kind', 'record_key'] as const

/** 旧 schema 允许空实体列；保留 SQLite 的 NULL 在前排序，而非将 NULL 与空字符串合并。 */
function continuation(columns: readonly string[], values: readonly SQLInputValue[]): { clause: string; args: SQLInputValue[] } {
  if (values.every(value => value !== null)) {
    return { clause: ` AND (${columns.join(',')})>(${columns.map(() => '?').join(',')})`, args: [...values] }
  }
  const args: SQLInputValue[] = []
  const branches = columns.map((column, index) => {
    const value = values[index]!
    const equal = columns.slice(0, index).map(prefix => prefix + ' IS ?')
    args.push(...values.slice(0, index))
    const greater = value === null ? column + ' IS NOT NULL' : column + '>?'
    if (value !== null) args.push(value)
    return '(' + [...equal, greater].join(' AND ') + ')'
  })
  return { clause: ' AND (' + branches.join(' OR ') + ')', args }
}
