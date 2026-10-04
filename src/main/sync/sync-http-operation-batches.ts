import type { SyncOperationBatchResult, SyncOperationEnvelope } from '../../shared/sync-protocol'

// 与 Android/Desktop/Server 既有普通业务请求额度一致，按 UTF-8 字节而非操作数量拆批。
const OPERATION_BODY_BYTES = 16 * 1024 * 1024
// 固定 JSON 包装必须与真实发送格式一致，计入接收端字节限制。
const PREFIX = '{"operations":['
const SUFFIX = ']}'

/** 保持签名操作顺序及载荷不变，逐批发送并验证每个真实服务端回执。 */
export async function pushHttpOperationBatches(options: {
  operations: readonly SyncOperationEnvelope[]
  send: (body: string) => Promise<SyncOperationBatchResult>
}): Promise<SyncOperationBatchResult> {
  let result: SyncOperationBatchResult | null = null
  for (const batch of operationBodies(options.operations)) {
    const next = await options.send(batch.body)
    const expected = new Set(batch.ids)
    const receipts = [...next.acceptedOperationIds, ...next.duplicateOperationIds]
    if (receipts.some(id => !expected.has(id))) throw new Error('Remote acknowledged an operation outside the HTTP batch')
    result = combineReceipts(result, next)
    if (next.rejected.length || batch.ids.some(id => !receipts.includes(id))) return result
  }
  if (!result) throw new Error('Operation HTTP batch did not produce a server response')
  return result
}

/** 累计各批真实回执，coverage 和 cursor 使用最后一批服务端返回的状态。 */
function combineReceipts(previous: SyncOperationBatchResult | null, next: SyncOperationBatchResult): SyncOperationBatchResult {
  return { ...next,
    acceptedOperationIds: [...(previous?.acceptedOperationIds ?? []), ...next.acceptedOperationIds],
    duplicateOperationIds: [...(previous?.duplicateOperationIds ?? []), ...next.duplicateOperationIds],
    rejected: [...(previous?.rejected ?? []), ...next.rejected],
  }
}

/** JSON 包装和逗号也计入接收端额度，单条超额必须在发送前明确失败。 */
function* operationBodies(operations: readonly SyncOperationEnvelope[]): Generator<{ body: string; ids: string[] }> {
  const overhead = Buffer.byteLength(PREFIX + SUFFIX, 'utf8')
  let bytes = overhead
  let rows: string[] = []
  let ids: string[] = []
  for (const operation of operations) {
    const row = JSON.stringify(operation)
    const rowBytes = Buffer.byteLength(row, 'utf8')
    if (overhead + rowBytes > OPERATION_BODY_BYTES) throw new Error(`SYNC_OPERATION_TOO_LARGE: ${operation.operationId}`)
    const separatorBytes = rows.length ? Buffer.byteLength(',', 'utf8') : 0
    if (bytes + separatorBytes + rowBytes > OPERATION_BODY_BYTES) {
      yield { body: PREFIX + rows.join(',') + SUFFIX, ids }
      rows = []
      ids = []
      bytes = overhead
    }
    bytes += (rows.length ? Buffer.byteLength(',', 'utf8') : 0) + rowBytes
    rows.push(row)
    ids.push(operation.operationId)
  }
  yield { body: PREFIX + rows.join(',') + SUFFIX, ids }
}
