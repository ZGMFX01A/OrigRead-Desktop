import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 14
export const DEFAULT_LOCAL_ACCOUNT_ID = 1
export const CURRENT_ACCOUNT_SETTING_KEY = 'account.current_id'

export function defaultGroupId(accountId: number): string {
  return `${accountId}$origread_app_default_group`
}

export const DEFAULT_GROUP_ID = defaultGroupId(DEFAULT_LOCAL_ACCOUNT_ID)

export interface Migration {
  version: number
  up(database: DatabaseSync): void
}
