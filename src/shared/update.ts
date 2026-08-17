export type UpdateCheckStatus = 'latest' | 'available' | 'unavailable' | 'error'

export type UpdateErrorCode =
  | 'REPOSITORY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'DISABLED'

export interface DesktopReleaseAsset {
  id: number
  name: string
  size: number
  downloadUrl: string
}

export interface DesktopReleaseInfo {
  tagName: string
  version: string
  title: string
  notes: string
  publishedDate: string
  releasePageUrl: string
  asset: DesktopReleaseAsset | null
}

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  currentVersion: string
  checkedAt: number
  release: DesktopReleaseInfo | null
  errorCode: UpdateErrorCode | null
  errorMessage: string | null
}

export interface UpdateDownloadResult {
  cancelled: boolean
  path: string | null
  error: string | null
}

