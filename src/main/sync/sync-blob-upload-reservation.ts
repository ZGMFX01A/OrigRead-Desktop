import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncBlobUploadReservation, SyncPolicyByLane } from '../../shared/sync-protocol'

// Blob 所属业务域固定，不能把 Chat 内容宣称为启用的 Article lane 绕过暂停策略。
const OWNER_LANES: Readonly<Record<string, string>> = {
  article: 'ARTICLE_STATE', conversation: 'AI_HISTORY', conversation_article: 'AI_HISTORY',
  message: 'AI_HISTORY', tool_call: 'AI_HISTORY', context_ref: 'AI_HISTORY', evidence_block: 'AI_HISTORY',
  citation_ref: 'AI_HISTORY', citation_annotation: 'AI_HISTORY', citation_annotation_ref: 'AI_HISTORY'
}

/** 已通过请求签名鉴权的引用预约；不把预约写成业务引用，Operation/Snapshot 仍须独立验证。 */
export function validateBlobReservation(value: SyncBlobUploadReservation, policy: SyncPolicyByLane): void {
  if (!value || !value.manifest || !/^[0-9a-f]{64}$/.test(value.manifest.hash) ||
    !Number.isSafeInteger(value.manifest.totalBytes) || value.manifest.totalBytes < 0 ||
    !Array.isArray(value.references) || value.references.length === 0) throw new Error('INVALID_BLOB_RESERVATION')
  for (const ref of value.references) {
    if (!ref || ref.hash !== value.manifest.hash || OWNER_LANES[ref.ownerEntityType] !== ref.replicationLaneId ||
      typeof ref.ownerEntitySyncId !== 'string' || !ref.ownerEntitySyncId.trim() ||
      !Number.isSafeInteger(ref.ownerEntityGeneration) || ref.ownerEntityGeneration < 0 ||
      typeof ref.referenceKind !== 'string' || !ref.referenceKind.trim()) throw new Error('INVALID_BLOB_REFERENCE')
  }
  if (!value.references.some((ref) => (policy[ref.replicationLaneId] ?? 'ENABLED') === 'ENABLED')) {
    throw new Error('AUTH_FORBIDDEN: Blob reservation belongs exclusively to disabled lanes')
  }
}

/** 文件预约跟随暂存数据保留，重启后仍能检查空间、Peer、长度和最新 lane 策略。 */
export function saveBlobReservation(options: {
  root: string; space: string; peer: string; value: SyncBlobUploadReservation; policy: SyncPolicyByLane
}): void {
  validateBlobReservation(options.value, options.policy)
  const path = join(options.root, `${options.value.manifest.hash}.reservation`)
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8'))
    if (previous.space !== options.space || previous.peer !== options.peer ||
      previous.value.manifest.totalBytes !== options.value.manifest.totalBytes) throw new Error('BLOB_STAGE_CONFLICT')
  }
  writeFileSync(path, JSON.stringify({ space: options.space, peer: options.peer, value: options.value }))
}

/** 每次状态查询与写块重新检查策略，暂停发生在预约之后也不得继续落盘。 */
export function requireBlobReservation(options: {
  root: string; space: string; peer: string; hash: string; totalBytes?: number; policy: SyncPolicyByLane
}): void {
  const path = join(options.root, `${options.hash}.reservation`)
  if (!existsSync(path)) throw new Error('AUTH_FORBIDDEN: authenticated Blob upload reservation is required')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved.space !== options.space || saved.peer !== options.peer || saved.value.manifest.hash !== options.hash ||
    (options.totalBytes != null && saved.value.manifest.totalBytes !== options.totalBytes)) throw new Error('AUTH_FORBIDDEN: Blob reservation mismatch')
  validateBlobReservation(saved.value, options.policy)
}
