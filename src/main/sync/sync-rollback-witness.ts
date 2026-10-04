import type { SecretStore } from '../security/secret-store'

interface SyncRollbackWitnessV1 {
  schemaVersion: 1
  profileBinding: string
  deviceId: string | null
  deviceWitnessId: string | null
  actorLaneHighWater: Record<string, number>
}

const KEY = 'sync.rollback-witness.v1'

export class DesktopSyncRollbackWitnessStore {
  constructor(
    private readonly secretStore: SecretStore,
    private readonly profileBinding: string
  ) {}

  snapshot(): SyncRollbackWitnessV1 {
    return this.load()
  }

  replaceDevice(deviceId: string, witnessId: string): void {
    const current = this.load()
    this.write({ ...current, deviceId, deviceWitnessId: witnessId })
  }

  highWater(actorIncarnationId: string, replicationLaneId: string): number | null {
    return this.load().actorLaneHighWater[this.key(actorIncarnationId, replicationLaneId)] ?? null
  }

  laneHighWater(actorIncarnationId: string): Record<string, number> {
    const prefix = `${actorIncarnationId}|`
    return Object.fromEntries(
      Object.entries(this.load().actorLaneHighWater)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value])
    )
  }

  reserveSequence(actorIncarnationId: string, replicationLaneId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('sequence must be a positive safe integer')
    const current = this.load()
    const key = this.key(actorIncarnationId, replicationLaneId)
    const existing = current.actorLaneHighWater[key] ?? 0
    if (sequence !== existing + 1) {
      throw new Error(`Non-contiguous rollback witness reservation for ${key}: existing=${existing} requested=${sequence}`)
    }
    this.write({
      ...current,
      actorLaneHighWater: { ...current.actorLaneHighWater, [key]: sequence }
    })
  }

  private load(): SyncRollbackWitnessV1 {
      const raw = this.secretStore.get(KEY)
      // 损坏或解密失败不能伪装为首次安装，否则会静默更换已配对设备身份。
      if (!raw && this.secretStore.contains(KEY)) throw new Error('Sync rollback witness cannot be decrypted')
      if (!raw) return this.empty()
      const parsed = JSON.parse(raw) as Partial<SyncRollbackWitnessV1>
      if (parsed.schemaVersion !== 1) throw new Error('Unsupported Sync rollback witness schema')
      if (typeof parsed.profileBinding !== 'string' ||
        !(parsed.deviceId === null || (typeof parsed.deviceId === 'string' && parsed.deviceId.trim())) ||
        !(parsed.deviceWitnessId === null || (typeof parsed.deviceWitnessId === 'string' && parsed.deviceWitnessId.trim())) ||
        (parsed.deviceId === null) !== (parsed.deviceWitnessId === null) ||
        !parsed.actorLaneHighWater || typeof parsed.actorLaneHighWater !== 'object' || Array.isArray(parsed.actorLaneHighWater) ||
        Object.values(parsed.actorLaneHighWater).some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error('Invalid Sync rollback witness content')
      }
      if (parsed.profileBinding !== this.profileBinding) return this.empty()
      return {
        schemaVersion: 1,
        profileBinding: this.profileBinding,
        deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : null,
        deviceWitnessId: typeof parsed.deviceWitnessId === 'string' ? parsed.deviceWitnessId : null,
        actorLaneHighWater: parsed.actorLaneHighWater && typeof parsed.actorLaneHighWater === 'object'
          ? parsed.actorLaneHighWater as Record<string, number>
          : {}
      }
  }

  private write(value: SyncRollbackWitnessV1): void {
    this.secretStore.put(KEY, JSON.stringify(value))
  }

  private empty(): SyncRollbackWitnessV1 {
    return {
      schemaVersion: 1,
      profileBinding: this.profileBinding,
      deviceId: null,
      deviceWitnessId: null,
      actorLaneHighWater: {}
    }
  }

  private key(actorIncarnationId: string, replicationLaneId: string): string {
    return `${actorIncarnationId}|${replicationLaneId}`
  }
}
