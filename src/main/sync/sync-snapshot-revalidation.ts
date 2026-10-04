/** P4 每轮允许一次事务外重新准备；仍竞争时明确交还 MORE_WORK，保留固定输入和断点。 */
export const SNAPSHOT_PUBLICATION_ATTEMPTS = 2

/** 仅修订竞争可重新准备，签名、权限、取消和持久化错误不得转成等待。 */
export function snapshotRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('REVALIDATION_REQUIRED:')
}

/** 达到本轮准备边界后暂停等待稳定事实，不在事务内或后台继续全量验证。 */
export function snapshotNeedsStableInput(): never { throw new Error('MORE_WORK: Snapshot authority or input keeps changing; fixed input is retained') }
