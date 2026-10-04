import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'

/** 网络记录必须有完整、类型严格的业务身份；安装器不推断缺失的代次或字段。 */
export function validateSnapshotRecord(record: SyncSnapshotRecord): void {
  const value = record.value
  switch (record.kind) {
    case 'ENTITY':
      entityIdentity(value); object(value.fields); break
    case 'FIELD_VERSION':
      entityIdentity(value, 'entityGeneration'); text(value.fieldId); text(value.versionToken); text(value.valueJson)
      JSON.parse(value.valueJson as string)
      if (value.causalContextJson != null) { text(value.causalContextJson); JSON.parse(value.causalContextJson as string) }
      if (value.logicalClock != null) integer(value.logicalClock)
      break
    case 'TOMBSTONE':
      entityIdentity(value); text(value.versionToken); integer(value.deletedAt); break
    case 'ALIAS_EDGE':
      text(value.targetEntityType); text(value.leftSyncId); text(value.rightSyncId)
      integer(value.leftGeneration); integer(value.rightGeneration); break
    case 'BLOB_REFERENCE':
      text(value.replicationLaneId); text(value.ownerEntityType); text(value.ownerEntitySyncId)
      integer(value.ownerEntityGeneration); text(value.referenceKind); digest(value.hash); break
    case 'BLOB_MANIFEST':
      digest(value.hash); integer(value.totalBytes); integer(value.referenceCount)
      if (!['SYNC_DURABLE', 'CACHE', 'REHYDRATABLE'].includes(String(value.durability))) fail()
      break
    case 'AUTH_OBJECT':
      text(value.authObjectId); text(value.syncSpaceId); text(value.objectType); integer(value.authEpoch)
      if (value.authSequence != null) integer(value.authSequence)
      text(value.payloadJson); JSON.parse(value.payloadJson as string)
      text(value.authorDeviceId); text(value.authorSignature); break
    case 'GENESIS': text(value.genesisBaselineId); break
  }
}

/** 实体身份必须与索引代次严格一致，字符串数字不能通过网络类型校验。 */
function entityIdentity(value: Record<string, unknown>, generation = 'generation'): void {
  text(value.entityType); text(value.entitySyncId); integer(value[generation])
}

/** 标识不得为空；校验只拒绝无效输入，不替调用方补默认值。 */
function text(value: unknown): void { if (typeof value !== 'string' || !value.trim()) fail() }

/** 序号和代次必须能被两端精确表示。 */
function integer(value: unknown): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail() }

/** 内容摘要使用唯一规范编码，避免同一内容产生不同记录身份。 */
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail() }

/** 字段状态只允许 JSON 对象，不能把数组或 null 当作字段集合。 */
function object(value: unknown): void { if (!value || typeof value !== 'object' || Array.isArray(value)) fail() }

/** 输入错误立即暴露，禁止安装器继续执行部分记录。 */
function fail(): never { throw new Error('SNAPSHOT_CORRUPTED: paged Snapshot record has invalid business fields') }
