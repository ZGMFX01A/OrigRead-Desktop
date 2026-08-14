import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from './migrations'

export class DesktopDatabase {
  readonly connection: DatabaseSync
  readonly schemaVersion: number

  constructor(path: string) {
    this.connection = new DatabaseSync(path, { timeout: 5_000 })
    this.connection.exec('PRAGMA foreign_keys = ON')
    this.connection.exec('PRAGMA journal_mode = WAL')
    this.connection.exec('PRAGMA synchronous = NORMAL')
    this.connection.exec('PRAGMA busy_timeout = 5000')
    this.schemaVersion = applyMigrations(this.connection)
  }

  close(): void {
    if (this.connection.isOpen) {
      this.connection.close()
    }
  }
}

