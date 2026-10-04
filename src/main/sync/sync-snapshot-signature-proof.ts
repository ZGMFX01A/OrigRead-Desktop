import type { DatabaseSync } from 'node:sqlite'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { operationRecordFromWire, operationRecordFromVerifiedWire, verifySyncOperationSignature } from './sync-operation-wire'
import { snapshotTraceWork } from './sync-snapshot-trace'

/** 完整 wire 格式及原作者签名的验证版本；规则变化必须递增。 */
const SIGNATURE_VALIDATOR_VERSION = 1
/** 查询随连接回收，内存不保存所有来源对象或载荷。 */
const statements = new WeakMap<DatabaseSync, ReturnType<typeof prepare>>()

/** 只复用完整签名对象、公钥与验证版本的不可变事实，当前授权和 Dot 检查由调用者继续执行。 */
export function decodeSnapshotSignature(input: { database: DatabaseSync; envelope: SyncOperationEnvelope; publicKey: string }): SyncOperationRecord {
  const queries = queriesFor(input.database)
  const sourceKey = sha256Hex(canonicalJson(JSON.stringify(input.envelope)))
  const keyDigest = sha256Hex(input.publicKey)
  if (queries.proof.get(sourceKey, keyDigest, SIGNATURE_VALIDATOR_VERSION)) return operationRecordFromVerifiedWire(input.envelope)
  const operation = operationRecordFromWire(input.envelope)
  if (!verifySyncOperationSignature(input.envelope, input.publicKey)) throw new Error('AUTH_FAILED: invalid Snapshot operation signature')
  snapshotTraceWork({ signatureChecks: 1 })
  // 只为仍被真实来源池持有的对象保存证明，来源生命周期回收同时删除证明。
  queries.save.run(sourceKey, keyDigest, SIGNATURE_VALIDATOR_VERSION, sourceKey)
  return operation
}

/** 固定查询不绑定或保留完整 payload，证明数量受真实来源池生命周期约束。 */
function queriesFor(database: DatabaseSync): ReturnType<typeof prepare> {
  let queries = statements.get(database)
  if (!queries) { queries = prepare(database); statements.set(database, queries) }
  return queries
}

/** proof 不能独立于来源存在，旧 GC 或来源 SQL 变化必须失效。 */
function prepare(database: DatabaseSync) {
  return {
    proof: database.prepare(`SELECT 1 FROM sync_snapshot_source_proof p JOIN sync_snapshot_source s ON s.source_key=p.source_key
      WHERE p.source_key=? AND p.public_key_digest=? AND p.validator_version=?`),
    save: database.prepare(`INSERT OR IGNORE INTO sync_snapshot_source_proof SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sync_snapshot_source WHERE source_key=?)`)
  }
}
