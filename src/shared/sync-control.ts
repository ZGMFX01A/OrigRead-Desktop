import type { SyncCoverageVector, SyncDiscoveredPeer } from './sync-protocol'

export type SyncEndpointKind = 'LAN' | 'SERVER' | 'MANUAL'

export interface SyncEndpointConfig {
  endpointId: string
  syncSpaceId: string
  kind: SyncEndpointKind
  url: string
  displayName: string
  enabled: boolean
  localBindAddress?: string | null
  lastError: string | null
}

export interface SyncPeerRegistration {
  syncSpaceId: string
  deviceId: string
  publicKeySpkiBase64: string
  authEpoch?: number
}

export interface SyncDesktopStatus {
  localAccountId: number
  syncSpaceId: string | null
  lifecycleState: string | null
  deviceId: string | null
  coverage: SyncCoverageVector | null
  endpoints: SyncEndpointConfig[]
  lastDiagnostics: string[]
  isLanRequested?: boolean
  isLanEnabled?: boolean
  lanPort?: number | null
  lanSuspendedReason?: string | null
  snapshotInstalling?: boolean
}

export interface SyncRunHistorySummary {
  runId: string
  syncSpaceId: string
  endpointId: string | null
  remoteDeviceId: string | null
  transport: string | null
  stage: string
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  startedAt: number
  finishedAt: number | null
  pushedOperations: number
  pulledOperations: number
  appliedOperations: number
  rejectedOperations: number
  blobBytesSent: number
  blobBytesReceived: number
  retryAttempt: number
  errorCode: string | null
  errorMessage: string | null
}

export interface SyncTrustedDeviceSummary {
  id: string
  syncSpaceId: string
  deviceId: string
  staticPublicKey: string
  fingerprint: string
  displayName: string
  platform: string
  trustState: 'TRUSTED' | 'REVOKED' | 'PROVISIONAL'
  pairedAt: number
  lastSeenAt: number
  authEpoch: number
  isOwner?: boolean
}

export interface SyncNetworkDiagnostics {
  interfaces: Array<{ name: string; address: string; family: string; internal: boolean }>
  hasUsableLanAddress: boolean
  multicastBindOk: boolean
  firewallSuspected: boolean
  warnings: string[]
}

export interface SyncEndpointInput {
  endpointId?: string
  syncSpaceId: string
  kind: SyncEndpointKind
  url: string
  displayName: string
  accessToken?: string
  enabled?: boolean
  localBindAddress?: string | null
}

export interface SyncDesktopRunResult {
  endpointId: string
  pushedOperationIds: string[]
  pulledOperationIds: string[]
  appliedOperationIds: string[]
  deferredOperationIds: string[]
  rejectedOperationIds: string[]
  blobBytesSent: number
  blobBytesReceived: number
  diagnostics: Array<{ code: string; message: string; retryable: boolean; at: number }>
}

export interface SyncDiscoverySnapshot {
  peers: SyncDiscoveredPeer[]
  diagnostic: { code: string; message: string; retryable: boolean; at: number } | null
}
