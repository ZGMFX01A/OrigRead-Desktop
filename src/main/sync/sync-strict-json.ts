/** 与 canonical profile 相同的嵌套预算，解析前拒绝重复属性，避免原始证据被覆盖。 */
const MAX_JSON_NESTING = 64
interface Container { object: boolean; keyExpected: boolean; keys: Set<string> }

/** 保留原 JSON 表示；词法检查后由标准 parser 验证完整 JSON 语法。 */
export function parseSyncJson<T = unknown>(raw: string): T {
  const stack: Container[] = []
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]
    if (character === '"') {
      const end = stringEnd(raw, index)
      const container = stack.at(-1)
      if (container?.object && container.keyExpected) {
        const key = JSON.parse(raw.slice(index, end + 1)) as string
        if (container.keys.has(key)) throw new Error('INVALID_OPERATION: duplicate JSON property')
        container.keys.add(key)
        container.keyExpected = false
      }
      index = end
    } else if (character === '{' || character === '[') {
      stack.push({ object: character === '{', keyExpected: character === '{', keys: new Set() })
      if (stack.length > MAX_JSON_NESTING) throw new Error('INVALID_OPERATION: JSON nesting exceeds canonical profile')
    } else if (character === '}' || character === ']') {
      stack.pop()
    } else if (character === ',' && stack.at(-1)?.object) {
      stack.at(-1)!.keyExpected = true
    }
  }
  return JSON.parse(raw) as T
}

/** 跳过转义字符，属性名使用标准 JSON 解码后判重，识别 a 与 \u0061。 */
function stringEnd(raw: string, start: number): number {
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === '\\') index++
    else if (raw[index] === '"') return index
  }
  throw new Error('INVALID_OPERATION: unterminated JSON string')
}
