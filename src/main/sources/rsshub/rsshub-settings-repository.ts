import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RssHubInstance, RssHubSettings } from '../../../shared/rsshub'
import { normalizeRssHubInstanceUrl } from './rsshub-route-matcher'

const SETTINGS_KEY = 'rsshub.settings'
const RUNTIME_KEY = 'rsshub.runtime'
const INSTANCE_COOLDOWN_MILLIS = 5 * 60 * 1000

interface RssHubRuntimeState {
  lastSuccessInstance: string | null
  cooldownUntil: Record<string, number>
}

export class RssHubSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(): RssHubSettings {
    const stored = this.readJson(SETTINGS_KEY)
    if (!stored || typeof stored !== 'object') return defaultRssHubSettings()
    const candidate = stored as Partial<RssHubSettings>
    const instances = Array.isArray(candidate.instances)
      ? normalizeInstances(candidate.instances as RssHubInstance[])
      : defaultRssHubInstances()
    return {
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : true,
      instances: instances.length > 0 ? instances : defaultRssHubInstances()
    }
  }

  setEnabled(enabled: boolean): RssHubSettings {
    return this.save({ ...this.current(), enabled })
  }

  addInstance(value: string): RssHubSettings {
    const normalized = requireInstanceUrl(value)
    const current = this.current()
    const existing = current.instances.find((instance) => instance.url === normalized)
    if (existing) {
      return this.save({
        ...current,
        instances: current.instances.map((instance) => instance.id === existing.id ? { ...instance, enabled: true } : instance)
      })
    }
    return this.save({
      ...current,
      instances: [...current.instances, {
        id: `custom-${createHash('sha1').update(normalized).digest('hex').slice(0, 12)}`,
        url: normalized,
        location: '',
        maintainer: '',
        enabled: true,
        builtIn: false
      }]
    })
  }

  setInstanceEnabled(id: string, enabled: boolean): RssHubSettings {
    const current = this.current()
    return this.save({
      ...current,
      instances: current.instances.map((instance) => instance.id === id ? { ...instance, enabled } : instance)
    })
  }

  deleteInstance(id: string): RssHubSettings {
    const current = this.current()
    return this.save({ ...current, instances: current.instances.filter((instance) => instance.id !== id) })
  }

  candidateInstances(now = Date.now()): string[] {
    const settings = this.current()
    if (!settings.enabled) return []
    const runtime = this.runtime()
    return orderRssHubInstances(runtime.lastSuccessInstance, ...settings.instances.filter((instance) => instance.enabled).map((instance) => instance.url))
      .filter((instance) => (runtime.cooldownUntil[instance] ?? 0) <= now)
  }

  recordSuccess(instanceBaseUrl: string): void {
    const normalized = requireInstanceUrl(instanceBaseUrl)
    const runtime = this.runtime()
    delete runtime.cooldownUntil[normalized]
    runtime.lastSuccessInstance = normalized
    this.writeJson(RUNTIME_KEY, runtime)
  }

  recordFailure(instanceBaseUrl: string, now = Date.now()): void {
    const normalized = requireInstanceUrl(instanceBaseUrl)
    const runtime = this.runtime()
    runtime.cooldownUntil[normalized] = now + INSTANCE_COOLDOWN_MILLIS
    this.writeJson(RUNTIME_KEY, runtime)
  }

  restoreDefault(): RssHubSettings {
    this.deleteKey(RUNTIME_KEY)
    return this.save(defaultRssHubSettings())
  }

  private save(settings: RssHubSettings): RssHubSettings {
    const normalized: RssHubSettings = {
      enabled: settings.enabled,
      instances: normalizeInstances(settings.instances)
    }
    this.writeJson(SETTINGS_KEY, normalized)
    return normalized
  }

  private runtime(): RssHubRuntimeState {
    const stored = this.readJson(RUNTIME_KEY) as Partial<RssHubRuntimeState> | null
    return {
      lastSuccessInstance: typeof stored?.lastSuccessInstance === 'string' ? stored.lastSuccessInstance : null,
      cooldownUntil: stored?.cooldownUntil && typeof stored.cooldownUntil === 'object'
        ? { ...stored.cooldownUntil }
        : {}
    }
  }

  private readJson(key: string): unknown | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }

  private writeJson(key: string, value: unknown): void {
    this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now())
  }

  private deleteKey(key: string): void {
    this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }
}

export function orderRssHubInstances(...values: Array<string | null | undefined>): string[] {
  const result: string[] = []
  for (const value of values) {
    if (!value) continue
    const normalized = normalizeRssHubInstanceUrl(value)
    if (normalized && !result.includes(normalized)) result.push(normalized)
  }
  return result
}

export function defaultRssHubSettings(): RssHubSettings {
  return { enabled: true, instances: defaultRssHubInstances() }
}

export function defaultRssHubInstances(): RssHubInstance[] {
  return [
    instance('official', 'https://rsshub.app', '🇺🇸 美国', 'DIYgod'),
    instance('rssforever', 'https://rsshub.rssforever.com', '🇦🇪 阿联酋', 'Stille'),
    instance('slarker', 'https://hub.slarker.me', '🇺🇸 美国', 'Slarker'),
    instance('pseudoyu', 'https://rsshub.pseudoyu.com', '🇫🇷 法国', 'pseudoyu'),
    instance('rsstips', 'https://rsshub.rss.tips', '🇺🇸 美国', 'AboutRSS'),
    instance('ktachibana', 'https://rsshub.ktachibana.party', '🇺🇸 美国', 'KTachibanaM'),
    instance('owonz', 'https://rss.owo.nz', '🇩🇪 德国', 'Vincent Yang'),
    instance('wudifeixue', 'https://rss.wudifeixue.com', '🇨🇦 加拿大', 'wudifeixue'),
    instance('henry', 'https://rsshub.henry.wang', '🇬🇧 英国', 'HenryQW'),
    instance('umzzz', 'https://rsshub.umzzz.com', '🇭🇰 香港', 'nesay'),
    instance('isrss', 'https://rsshub.isrss.com', '🇺🇸 美国', 'isRSS'),
    instance('emailonce', 'https://rsshub.email-once.com', '🇭🇰 香港', 'EmailOnce'),
    instance('datuan', 'https://rss.datuan.dev', '🇻🇳 越南', 'Tuấn Dev'),
    instance('cups', 'https://rsshub.cups.moe', '🇺🇸 美国', 'FunnyCups'),
    instance('spriple', 'https://rss.spriple.org', '🇨🇳 中国', 'Spriple'),
    instance('virworks', 'https://rsshub-balancer.virworks.moe', '🇺🇳 多地负载均衡', 'chesha1')
  ]
}

function instance(id: string, url: string, location: string, maintainer: string): RssHubInstance {
  return { id, url, location, maintainer, enabled: true, builtIn: true }
}

function normalizeInstances(instances: RssHubInstance[]): RssHubInstance[] {
  const result: RssHubInstance[] = []
  for (const candidate of instances) {
    if (!candidate || typeof candidate.url !== 'string') continue
    const url = normalizeRssHubInstanceUrl(candidate.url)
    if (!url || result.some((instance) => instance.url === url)) continue
    result.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `custom-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
      url,
      location: typeof candidate.location === 'string' ? candidate.location : '',
      maintainer: typeof candidate.maintainer === 'string' ? candidate.maintainer : '',
      enabled: candidate.enabled !== false,
      builtIn: candidate.builtIn === true
    })
  }
  return result
}

function requireInstanceUrl(value: string): string {
  const normalized = normalizeRssHubInstanceUrl(value)
  if (!normalized) throw new TypeError(`无效的 RSSHub 实例地址：${value}`)
  return normalized
}
