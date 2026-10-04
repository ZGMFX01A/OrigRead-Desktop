import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface SyncRunHistoryRecord {
  runId: string
  syncSpaceId: string
  endpointId: string | null
  remoteDeviceId: string | null
  transport: string | null
  stage: string
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  startedAt: number
  finishedAt: number | null
  pushedOperations: number
  pulledOperations: number
  appliedOperations: number
  rejectedOperations: number
  blobBytesSent: number
  blobBytesReceived: number
  retryAttempt: number
  errorCode: string | null
  errorMessage: string | null
}

export interface SyncSessionProgress {
  stage: string
  remoteDeviceId?: string | null
  pushedOperations?: number
  pulledOperations?: number
  appliedOperations?: number
  rejectedOperations?: number
  blobBytesSent?: number
  blobBytesReceived?: number
}

export class DesktopSyncRunHistory {
  constructor(private readonly database: DatabaseSync) {}

  start(syncSpaceId: string, endpointId: string | null, transport: string | null, remoteDeviceId: string | null): SyncRunHistoryRecord {
    const previous = endpointId ? this.latestForEndpoint(endpointId) : null
    const record: SyncRunHistoryRecord = {
      runId: randomUUID(), syncSpaceId, endpointId, remoteDeviceId, transport,
      stage: 'CONNECTING', status: 'RUNNING', startedAt: Date.now(), finishedAt: null,
      pushedOperations: 0, pulledOperations: 0, appliedOperations: 0, rejectedOperations: 0,
      blobBytesSent: 0, blobBytesReceived: 0,
      retryAttempt: previous?.status === 'FAILED' ? previous.retryAttempt + 1 : 0,
      errorCode: null, errorMessage: null
    }
    this.upsert(record)
    return record
  }

  progress(record: SyncRunHistoryRecord, progress: SyncSessionProgress): SyncRunHistoryRecord {
    const updated: SyncRunHistoryRecord = {
      ...record,
      remoteDeviceId: progress.remoteDeviceId ?? record.remoteDeviceId,
      stage: progress.stage,
      pushedOperations: progress.pushedOperations ?? record.pushedOperations,
      pulledOperations: progress.pulledOperations ?? record.pulledOperations,
      appliedOperations: progress.appliedOperations ?? record.appliedOperations,
      rejectedOperations: progress.rejectedOperations ?? record.rejectedOperations,
      blobBytesSent: progress.blobBytesSent ?? record.blobBytesSent,
      blobBytesReceived: progress.blobBytesReceived ?? record.blobBytesReceived
    }
    this.upsert(updated)
    return updated
  }

  succeed(record: SyncRunHistoryRecord, stage = 'COMPLETED'): SyncRunHistoryRecord {
    const updated = { ...record, stage, status: 'SUCCEEDED' as const, finishedAt: Date.now(), errorCode: null, errorMessage: null }
    this.upsert(updated)
    this.prune(500)
    return updated
  }

  fail(record: SyncRunHistoryRecord, error: unknown, stage = record.stage): SyncRunHistoryRecord {
    const message = error instanceof Error ? error.message : String(error)
    const updated = {
      ...record, stage, status: 'FAILED' as const, finishedAt: Date.now(),
      errorCode: syncRunErrorCode(error), errorMessage: message.slice(0, 1000)
    }
    this.upsert(updated)
    this.prune(500)
    return updated
  }

  list(syncSpaceId: string, limit = 100): SyncRunHistoryRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.database.prepare(
      'SELECT * FROM sync_run_history WHERE sync_space_id=? ORDER BY started_at DESC,run_id DESC LIMIT ?'
    ).all(syncSpaceId, safeLimit) as unknown as SyncRunHistoryRow[]
    return rows.map(fromRow)
  }

  private latestForEndpoint(endpointId: string): SyncRunHistoryRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM sync_run_history WHERE endpoint_id=? ORDER BY started_at DESC,run_id DESC LIMIT 1'
    ).get(endpointId) as SyncRunHistoryRow | undefined
    return row ? fromRow(row) : null
  }

  private upsert(record: SyncRunHistoryRecord): void {
    this.database.prepare(
      'INSERT INTO sync_run_history(' +
      'run_id,sync_space_id,endpoint_id,remote_device_id,transport,stage,status,started_at,finished_at,' +
      'pushed_operations,pulled_operations,applied_operations,rejected_operations,blob_bytes_sent,blob_bytes_received,' +
      'retry_attempt,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(run_id) DO UPDATE SET remote_device_id=excluded.remote_device_id,stage=excluded.stage,' +
      'status=excluded.status,finished_at=excluded.finished_at,pushed_operations=excluded.pushed_operations,' +
      'pulled_operations=excluded.pulled_operations,applied_operations=excluded.applied_operations,' +
      'rejected_operations=excluded.rejected_operations,blob_bytes_sent=excluded.blob_bytes_sent,' +
      'blob_bytes_received=excluded.blob_bytes_received,retry_attempt=excluded.retry_attempt,' +
      'error_code=excluded.error_code,error_message=excluded.error_message'
    ).run(
      record.runId, record.syncSpaceId, record.endpointId, record.remoteDeviceId, record.transport,
      record.stage, record.status, record.startedAt, record.finishedAt, record.pushedOperations,
      record.pulledOperations, record.appliedOperations, record.rejectedOperations,
      record.blobBytesSent, record.blobBytesReceived, record.retryAttempt, record.errorCode, record.errorMessage
    )
  }

  private prune(keep: number): void {
    this.database.prepare(
      'DELETE FROM sync_run_history WHERE run_id IN (' +
      'SELECT run_id FROM sync_run_history ORDER BY started_at DESC,run_id DESC LIMIT -1 OFFSET ?)'
    ).run(keep)
  }
}

interface SyncRunHistoryRow {
  run_id: string
  sync_space_id: string
  endpoint_id: string | null
  remote_device_id: string | null
  transport: string | null
  stage: string
  status: SyncRunHistoryRecord['status']
  started_at: number
  finished_at: number | null
  pushed_operations: number
  pulled_operations: number
  applied_operations: number
  rejected_operations: number
  blob_bytes_sent: number
  blob_bytes_received: number
  retry_attempt: number
  error_code: string | null
  error_message: string | null
}

function fromRow(row: SyncRunHistoryRow): SyncRunHistoryRecord {
  return {
    runId: row.run_id, syncSpaceId: row.sync_space_id, endpointId: row.endpoint_id,
    remoteDeviceId: row.remote_device_id, transport: row.transport, stage: row.stage, status: row.status,
    startedAt: Number(row.started_at), finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    pushedOperations: Number(row.pushed_operations), pulledOperations: Number(row.pulled_operations),
    appliedOperations: Number(row.applied_operations), rejectedOperations: Number(row.rejected_operations),
    blobBytesSent: Number(row.blob_bytes_sent), blobBytesReceived: Number(row.blob_bytes_received),
    retryAttempt: Number(row.retry_attempt), errorCode: row.error_code, errorMessage: row.error_message
  }
}

function syncRunErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = message.split(':', 1)[0]?.trim() ?? ''
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(prefix)) return prefix
  return error instanceof Error ? error.name.toUpperCase().slice(0, 64) : 'SYNC_FAILED'
}
