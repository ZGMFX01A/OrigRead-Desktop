export interface OpmlImportResult {
  groupsAdded: number
  feedsAdded: number
  feedsSkipped: number
}

export interface OpmlImportFileResult {
  ok: boolean
  cancelled: boolean
  path: string | null
  importResult?: OpmlImportResult
  error: string | null
}

export interface OpmlExportFileResult {
  ok: boolean
  cancelled: boolean
  path: string | null
  error: string | null
}
