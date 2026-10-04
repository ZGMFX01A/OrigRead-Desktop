import type { DatabaseSync } from 'node:sqlite'

// 同名保存点由 SQLite 按嵌套栈处理，使订阅批次和单来源写入一起提交或回滚。
const SUBSCRIPTION_SAVEPOINT = 'origread_subscription'

/** 只包裹同步 SQLite 操作；异步网络抓取必须在进入事务之前完成。 */
export function libraryTransaction<T>(database: DatabaseSync, work: () => T): T {
  const nested = database.isTransaction
  database.exec(nested ? `SAVEPOINT ${SUBSCRIPTION_SAVEPOINT}` : 'BEGIN IMMEDIATE')
  try {
    const result = work()
    database.exec(nested ? `RELEASE ${SUBSCRIPTION_SAVEPOINT}` : 'COMMIT')
    return result
  } catch (error) {
    // 任何来源、文章或元数据写入失败均回滚，不能返回已经部分落库的成功结果。
    if (nested) {
      database.exec(`ROLLBACK TO ${SUBSCRIPTION_SAVEPOINT}`)
      database.exec(`RELEASE ${SUBSCRIPTION_SAVEPOINT}`)
    } else {
      database.exec('ROLLBACK')
    }
    throw error
  }
}
