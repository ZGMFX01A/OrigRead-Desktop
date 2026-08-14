type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type PathToken =
  | { type: 'field'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }

export function queryJsonPath(root: JsonValue, path: string): JsonValue[] {
  const tokens = tokenize(path)
  return tokens.reduce<JsonValue[]>((current, token) => {
    return current.flatMap((element) => readToken(element, token))
  }, [root])
}

export function firstJsonPath(root: JsonValue, path: string | null | undefined): JsonValue | null {
  if (!path?.trim()) return null
  return queryJsonPath(root, path)[0] ?? null
}

export function validateJsonPath(path: string): void {
  tokenize(path)
}

function tokenize(path: string): PathToken[] {
  if (!path.startsWith('$')) throw new Error(`JSONPath 必须以 $ 开头：${path}`)
  const tokens: PathToken[] = []
  let index = 1

  while (index < path.length) {
    const char = path[index]
    if (char === '.') {
      index += 1
      const start = index
      while (index < path.length && path[index] !== '.' && path[index] !== '[') index += 1
      if (index <= start) throw new Error(`JSONPath 字段名不能为空：${path}`)
      tokens.push({ type: 'field', name: path.slice(start, index) })
      continue
    }

    if (char === '[') {
      const end = path.indexOf(']', index)
      if (end <= index) throw new Error(`JSONPath 数组表达式不完整：${path}`)
      const value = path.slice(index + 1, end)
      if (value === '*') {
        tokens.push({ type: 'wildcard' })
      } else {
        if (!/^-?\d+$/.test(value)) throw new Error(`JSONPath 数组下标无效：${path}`)
        tokens.push({ type: 'index', index: Number(value) })
      }
      index = end + 1
      continue
    }

    throw new Error(`不支持的 JSONPath 语法：${path}`)
  }

  return tokens
}

function readToken(element: JsonValue, token: PathToken): JsonValue[] {
  if (token.type === 'field') {
    if (!isJsonObject(element)) return []
    const value = element[token.name]
    return value === undefined ? [] : [value]
  }
  if (token.type === 'index') {
    if (!Array.isArray(element)) return []
    const value = element[token.index]
    return value === undefined ? [] : [value]
  }
  return Array.isArray(element) ? element : []
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { JsonValue }
