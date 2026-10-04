import { statSync } from 'node:fs'

/** 校验结果绑定文件身份/纳秒时间戳，替换、修改及大小变化均失效。 */
export class BlobFileVerification {
  private readonly stamps = new Map<string, string>()

  /** 同一不可变对象的后续 Range 复用一次完整校验，接收端仍验证最终整文件。 */
  verify(input: { hash: string; path: string; digest(): string; force?: boolean }): boolean {
    const before = this.stamp(input.path)
    if (!input.force && this.stamps.get(input.path) === `${input.hash}:${before}`) return true
    if (input.digest() !== input.hash || this.stamp(input.path) !== before) {
      this.stamps.delete(input.path)
      return false
    }
    this.stamps.set(input.path, `${input.hash}:${before}`)
    return true
  }

  /** 恢复/删除或替换对象后显式撤销校验缓存。 */
  invalidate(path: string): void { this.stamps.delete(path) }

  private stamp(path: string): string {
    const stat = statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  }
}
