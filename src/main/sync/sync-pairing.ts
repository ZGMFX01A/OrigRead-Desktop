import { createHash } from 'node:crypto'

export interface SyncHandshakeHello {
  protocolVersion: number
  syncSpaceId: string
  deviceId: string
  ephemeralPublicKey: string
  nonce: string
}

export interface SyncHandshakeTranscript {
  initiator: SyncHandshakeHello
  responder: SyncHandshakeHello
  staticIdentityKeys: string[]
}

/** Pairing is interactive: discovery only supplies a candidate endpoint. */
export function syncHandshakeTranscriptHash(transcript: SyncHandshakeTranscript): string {
  const canonical = JSON.stringify({
    initiator: transcript.initiator,
    responder: transcript.responder,
    staticIdentityKeys: [...transcript.staticIdentityKeys].sort()
  })
  return createHash('sha256').update(`ORIGREAD_SYNC_HANDSHAKE_V1\n${canonical}`, 'utf8').digest('hex')
}

export function syncSasCode(transcript: SyncHandshakeTranscript): string {
  const digest = syncHandshakeTranscriptHash(transcript)
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`.toUpperCase()
}

export function syncDeviceFingerprint(staticIdentityKeySpkiBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(staticIdentityKeySpkiBase64, 'base64')).digest('hex')
  return digest.match(/.{1,4}/g)?.slice(0, 8).join(':').toUpperCase() ?? ''
}
