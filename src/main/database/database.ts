import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from './migrations'
import { guardedSnapshotDatabase, SnapshotInstallFence } from '../sync/sync-snapshot-access'

export class DesktopDatabase {
  readonly connection: DatabaseSync
  readonly schemaVersion: number

  constructor(path: string) {
    const connection = new DatabaseSync(path, { timeout: 5_000 })
    this.connection = path === ':memory:' ? connection : guardedSnapshotDatabase(connection, new SnapshotInstallFence(path))
    this.connection.exec('PRAGMA foreign_keys = ON')
    this.connection.exec('PRAGMA journal_mode = WAL')
    this.connection.exec('PRAGMA synchronous = FULL')
    this.connection.exec('PRAGMA busy_timeout = 5000')
    this.schemaVersion = applyMigrations(this.connection)
  }

  close(): void {
    if (this.connection.isOpen) {
      this.connection.close()
    }
  }
}

