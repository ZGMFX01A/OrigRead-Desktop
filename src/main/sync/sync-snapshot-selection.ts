/** 可重复读取的有序快照选择器；过滤只保存条件，不聚合整个输入 lane。 */
export function snapshotSelection<T>(read: () => Iterable<T>): SnapshotSelection<T> {
  return {
    [Symbol.iterator]() { return read()[Symbol.iterator]() },
    get length() { let count = 0; for (const _value of read()) count++; return count },
    filter(predicate) { return snapshotSelection(function* () { for (const value of read()) if (predicate(value)) yield value }) },
    at(index) { let current = 0; for (const value of read()) if (current++ === index) return value; return undefined },
    // CONFIG 仓库的替换 API 持有该类规则的产品状态；仅在最终仓库写入边界创建目标集合。
    map(convert) { const result: ReturnType<typeof convert>[] = []; for (const value of read()) result.push(convert(value)); return result }
  }
}

export interface SnapshotSelection<T> extends Iterable<T> {
  readonly length: number
  filter(predicate: (value: T) => boolean): SnapshotSelection<T>
  at(index: number): T | undefined
  map<U>(convert: (value: T) => U): U[]
}
