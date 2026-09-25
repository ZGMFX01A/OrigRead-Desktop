import type { SyncCoverageVector, SyncDiscoveredPeer } from './sync-protocol'

export type SyncEndpointKind = 'LAN' | 'SERVER' | 'MANUAL'

export interface SyncEndpointConfig {
  endpointId: string
  syncSpaceId: string
  kind: SyncEndpointKind
  url: string
  displayName: string
  enabled: boolean
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
}

export interface SyncEndpointInput {
  endpointId?: string
  syncSpaceId: string
  kind: SyncEndpointKind
  url: string
  displayName: string
  accessToken?: string
  enabled?: boolean
}

export interface SyncDesktopRunResult {
  endpointId: string
  pushedOperationIds: string[]
  pulledOperationIds: string[]
  appliedOperationIds: string[]
  deferredOperationIds: string[]
  rejectedOperationIds: string[]
  diagnostics: Array<{ code: string; message: string; retryable: boolean; at: number }>
}

export interface SyncDiscoverySnapshot {
  peers: SyncDiscoveredPeer[]
  diagnostic: { code: string; message: string; retryable: boolean; at: number } | null
}
