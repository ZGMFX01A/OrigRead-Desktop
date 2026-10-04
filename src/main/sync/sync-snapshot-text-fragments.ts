import { snapshotCheckpoint } from './sync-snapshot-execution'

/** 仅合并小语法片段；来源或大字段直接送入既有分块 UTF-8 编码器，避免整条 wire 副本。 */
const SMALL_FRAGMENT_CHARS = 2048

/** 原片段顺序和行末换行保持不变，临时拼接只覆盖固定大小的小片段。 */
export function writeSnapshotTextFragments(input: { parts: Iterable<string>; write: (text: string) => void }): void {
  let pending: string[] = [], characters = 0
  const flush = () => {
    if (!pending.length) return
    input.write(pending.join(''))
    pending = []; characters = 0
  }
  for (const part of input.parts) {
    snapshotCheckpoint()
    if (!part.length) continue
    if (part.length >= SMALL_FRAGMENT_CHARS) { flush(); input.write(part); continue }
    if (characters + part.length > SMALL_FRAGMENT_CHARS) flush()
    pending.push(part); characters += part.length
  }
  flush()
  input.write('\n')
}
