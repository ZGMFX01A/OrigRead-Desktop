import type { DatabaseSync } from 'node:sqlite'
import { frozenSnapshotDatabase } from '../sync/sync-frozen-database-context'
import { basename } from 'node:path'
import { readUtf8FileOrNull, writeUtf8FileAtomic } from '../utils/atomic-utf8-file'

/** 来源规则的持久化边界；生产 SQLite 与 Outbox 共用事务，独立文件适配用于导入工具。 */
export interface ConfigDocument {
  read(): string | null
  write(value: string): void
}

/** 旧文件只在首次读取时迁入权威库；之后文件不参与配置状态裁决。 */
export class SqliteConfigDocument implements ConfigDocument {
  constructor(private readonly input: { database: DatabaseSync; legacyFile: string }) {}

  read(): string | null {
    const { legacyFile } = this.input
    const database = frozenSnapshotDatabase(this.input.database)
    const key = basename(legacyFile)
    const row = database.prepare('SELECT value FROM local_config_document WHERE key=?').get(key)
    if (row) return String(row.value) || null
    const content = readUtf8FileOrNull(legacyFile)
    this.write(content ?? '')
    return content
  }

  write(value: string): void {
    frozenSnapshotDatabase(this.input.database).prepare('INSERT INTO local_config_document(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(basename(this.input.legacyFile), value)
  }
}

/** 显式文件模式供独立规则文件工具使用；生产组装必须传入 SqliteConfigDocument。 */
export class FileConfigDocument implements ConfigDocument {
  constructor(private readonly file: string) {}
  read(): string | null { return readUtf8FileOrNull(this.file) }
  write(value: string): void { writeUtf8FileAtomic(this.file, value) }
}

/** 构造参数显式选择存储，错误不会在两种模式之间降级。 */
export function configDocument(input: string | ConfigDocument): ConfigDocument {
  return typeof input === 'string' ? new FileConfigDocument(input) : input
}
