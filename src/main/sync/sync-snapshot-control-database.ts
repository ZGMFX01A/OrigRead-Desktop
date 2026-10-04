import { DatabaseSync } from 'node:sqlite'

/** 主线程读进度与 Worker 写围栏共享控制库，沿用业务库的 WAL/FULL 耐久模式。 */
export function openSnapshotControlDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(`${path}.snapshot-jobs`)
  try {
    // 回滚日志模式会让短状态读阻塞围栏提交；WAL 保留原子提交且允许两者并行。
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    return database
  } catch (error) {
    // 初始化失败尚未移交连接，关闭原生资源并暴露真实存储错误。
    database.close()
    throw error
  }
}
