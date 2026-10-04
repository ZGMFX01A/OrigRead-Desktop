import { createHash } from 'node:crypto'
import type { SyncOperationRecord } from '../../shared/sync-runtime'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function canonicalJson(value: string): string {
  return stableStringify(JSON.parse(value) as unknown)
}

/** 已解码的 JSON 值直接规范编码，避免再建立一份 stringify/parse 的大对象副本。 */
export function canonicalJsonValue(value: unknown): string { return stableStringify(value) }

export function operationSigningDigest(operation: SyncOperationRecord): string {
  return sha256Hex(operationSigningMaterial(operation))
}

export function operationId(
  syncSpaceId: string,
  actorIncarnationId: string,
  replicationLaneId: string,
  sequence: number
): string {
  if (!syncSpaceId.trim()) throw new Error('syncSpaceId must not be blank')
  if (!actorIncarnationId.trim()) throw new Error('actorIncarnationId must not be blank')
  if (!replicationLaneId.trim()) throw new Error('replicationLaneId must not be blank')
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('sequence must be a positive safe integer')
  let material = 'ORIGREAD_SYNC_OPERATION_ID_V1\n'
  const field = (name: string, value: string): void => {
    material += `${name}=${Buffer.byteLength(value, 'utf8')}:${value}\n`
  }
  field('syncSpaceId', syncSpaceId)
  field('actorIncarnationId', actorIncarnationId)
  field('replicationLaneId', replicationLaneId)
  field('sequence', String(sequence))
  return `op1:${sha256Hex(material)}`
}

export function operationSigningMaterial(operation: SyncOperationRecord): string {
  let result = 'ORIGREAD_SYNC_OPERATION_V1\n'
  const field = (name: string, value: string): void => {
    result += `${name}=${Buffer.byteLength(value, 'utf8')}:${value}\n`
  }
  const nullable = (name: string, value: string | null): void => {
    if (value == null) result += `${name}=-1:\n`
    else field(name, value)
  }

  field('operationId', operation.operationId)
  field('syncSpaceId', operation.syncSpaceId)
  field('authorDeviceId', operation.authorDeviceId)
  field('actorIncarnationId', operation.actorIncarnationId)
  field('replicationLaneId', operation.replicationLaneId)
  field('sequence', String(operation.sequence))
  field('logicalClock', String(operation.logicalClock))
  field('causalContextJson', operation.causalContextJson)
  field('dependencyDotsJson', operation.dependencyDotsJson)
  field('entityType', operation.entityType)
  field('entitySyncId', operation.entitySyncId)
  field('entityGeneration', String(operation.entityGeneration))
  field('operationType', operation.operationType)
  field('payloadSchemaVersion', String(operation.payloadSchemaVersion))
  field('schemaVersion', String(operation.schemaVersion))
  nullable('authGrantId', operation.authGrantId)
  nullable('authEpoch', operation.authEpoch == null ? null : String(operation.authEpoch))
  field('createdWallClock', String(operation.createdWallClock))
  field('payloadHash', operation.payloadHash)
  return result
}

function stableStringify(value: unknown): string {
  if (typeof value === 'string') {
    assertUnicode(value)
    return JSON.stringify(value)
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number is not valid canonical JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${stableStringify(key)}:${stableStringify(object[key])}`).join(',')}}`
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`)
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('Unpaired Unicode surrogate')
    }
  }
}
