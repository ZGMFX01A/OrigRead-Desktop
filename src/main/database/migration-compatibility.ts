import type { DatabaseSync } from 'node:sqlite'

export function ensureWebSearchMessageColumns(database: DatabaseSync): void {
  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info('llm_messages')").all() as Array<{ name: string }>).map((column) => column.name)
  )
  const columns: Array<[name: string, definition: string]> = [
    [
      'web_search_status',
      `TEXT CHECK (
        web_search_status IS NULL OR web_search_status IN (
          'NOT_NEEDED','TRIGGERED','SUCCESS','EMPTY_RESULT','FAILED_FALLBACK','FAILED_REQUIRED','CANCELLED'
        )
      )`
    ],
    ['web_search_query', 'TEXT'],
    ['web_search_provider_name', 'TEXT'],
    ['web_search_result_count', 'INTEGER'],
    ['web_search_error_message', 'TEXT']
  ]

  for (const [name, definition] of columns) {
    if (existingColumns.has(name)) continue
    database.exec(`ALTER TABLE llm_messages ADD COLUMN ${name} ${definition}`)
    existingColumns.add(name)
  }
}

export function ensureRssHubDescriptorColumns(database: DatabaseSync): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rsshub_source_urls'")
    .get()
  if (!table) return
  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info('rsshub_source_urls')").all() as Array<{ name: string }>).map((column) => column.name)
  )
  const columns: Array<[name: string, definition: string]> = [
    ['route_path', 'TEXT'],
    ['preferred_instance', 'TEXT'],
    ['last_resolved_instance', 'TEXT'],
    ['last_resolved_url', 'TEXT']
  ]
  for (const [name, definition] of columns) {
    if (existingColumns.has(name)) continue
    database.exec(`ALTER TABLE rsshub_source_urls ADD COLUMN ${name} ${definition}`)
    existingColumns.add(name)
  }
  database.exec('CREATE INDEX IF NOT EXISTS rsshub_source_urls_route_idx ON rsshub_source_urls(route_path)')
}
