import { createHash, type Hash } from 'node:crypto'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { canonicalJsonValue } from './sync-operation-canonicalizer'

interface Input { readonly record: SyncSnapshotRecord; readonly source?: string }

/** 来源使用已经规范化的完整片段；各字段仍按原排序进入同一条 wire 记录。 */
export function* snapshotRecordFragments(input: Input): Generator<string> {
  const record = input.record as unknown as Readonly<Record<string, unknown>>
  let separator = ''
  yield '{'
  for (const key of Object.keys(record).sort()) {
    yield separator; yield canonicalJsonValue(key); yield ':'; separator = ','
    if (key === 'value') yield* valueFragments(input)
    else yield canonicalJsonValue(record[key])
  }
  yield '}'
}

/** 已有紧凑事实只需补完整承诺时逐片段计算摘要，不再次分配整条落盘文本。 */
export function snapshotRecordHash(input: Input): string {
  const digest = createHash('sha256')
  for (const fragment of snapshotRecordFragments(input)) digest.update(fragment, 'utf8')
  return digest.digest('hex')
}

/** 紧凑字段只编码一次，同时生成原完整承诺和落盘文本，不重复转义正文。 */
export function prepareSnapshotRecordEncoding(input: Input): { hash: string; stored: string } {
  if (input.source === undefined) {
    const stored = canonicalJsonValue(input.record)
    return { stored, hash: createHash('sha256').update(stored, 'utf8').digest('hex') }
  }
  const encoding = new PreparedRecordEncoding()
  encoding.appendRecord(input)
  return encoding.finish()
}

/** 缓冲只属于当前记录，输入对象不变；完整来源不会复制到紧凑落盘字符串。 */
class PreparedRecordEncoding {
  private readonly hash: Hash = createHash('sha256')
  private readonly stored: string[] = []

  /** 顶层和扩展字段沿用既有排序，value 内只省略已池化的完整来源。 */
  appendRecord(input: Input): void {
    const record = input.record as unknown as Readonly<Record<string, unknown>>
    let separator = ''
    this.append('{')
    for (const key of Object.keys(record).sort()) {
      this.append(separator); this.append(canonicalJsonValue(key)); this.append(':'); separator = ','
      if (key === 'value') this.appendValue(input)
      else this.append(canonicalJsonValue(record[key]))
    }
    this.append('}')
  }

  /** 非来源片段同时服务摘要和落盘，复用同一份转义后的字段字节。 */
  private append(part: string): void {
    this.hash.update(part, 'utf8')
    this.stored.push(part)
  }

  /** 原完整值与紧凑值各自保持逗号边界，来源省略不能改变其他字段。 */
  private appendValue(input: Input): void {
    let wireSeparator = '', storedSeparator = ''
    this.append('{')
    for (const member of valueMembers(input)) {
      this.hash.update(wireSeparator, 'utf8').update(member.name, 'utf8').update(':', 'utf8').update(member.value, 'utf8')
      wireSeparator = ','
      if (member.source) continue
      this.stored.push(storedSeparator, member.name, ':', member.value)
      storedSeparator = ','
    }
    this.append('}')
  }

  /** 当前记录结束即返回结果，不将正文缓冲保留到下一条记录。 */
  finish(): { hash: string; stored: string } {
    return { hash: this.hash.digest('hex'), stored: this.stored.join('') }
  }
}

/** sourceOperation 的插入位置遵循原 canonical JSON 排序，不改变签名字节。 */
function* valueFragments(input: Input): Generator<string> {
  let separator = ''
  yield '{'
  for (const member of valueMembers(input)) {
    yield separator; yield member.name; yield ':'; separator = ','
    yield member.value
  }
  yield '}'
}

/** 两条输出路径共用规范成员，null、扩展字段和原始排序继续遵循既有编码器。 */
function* valueMembers(input: Input): Generator<{ name: string; value: string; source: boolean }> {
  const value = input.record.value
  const keys = input.source === undefined ? Object.keys(value) : [...Object.keys(value).filter(key => key !== 'sourceOperation'), 'sourceOperation']
  for (const key of keys.sort()) {
    const source = key === 'sourceOperation' && input.source !== undefined
    yield { name: canonicalJsonValue(key), value: source ? input.source! : canonicalJsonValue(value[key]), source }
  }
}
