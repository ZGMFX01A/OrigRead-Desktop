import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createConfigurationBackupFixture } from './configuration-backup-test-support'
import { JsonArticleParser } from '../sources/json/json-article-parser'
import { JsonSourceService } from '../sources/json/json-source-service'
import { JsonSubscriptionService } from '../sources/json/json-subscription-service'
import type { JsonRule } from '../../shared/json-source'

type Fixture = ReturnType<typeof createConfigurationBackupFixture>

/** 关闭真实数据库并清理本用例创建的规则文件。 */
async function withBackup(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'origread-json-binding-backup-'))
  const fixture = createConfigurationBackupFixture(directory)
  try { await run(fixture) } finally {
    fixture.database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** 用成功探测的自定义规则订阅；目录随后变更，快照必须独立保存。 */
async function subscribeJson(fixture: Fixture) {
  const source = new JsonSourceService(fixture.jsonRules, new JsonArticleParser(),
    async () => '[{"id":1,"link":"https://example.com/1","title":{"rendered":"One"}}]')
  const wordpress = (await source.probe('https://example.com/wp-json/wp/v2/posts'))!
  const rule = { ...wordpress.rule, id: 'confirmed-api', endpoint: '/api/news' }
  fixture.jsonRules.saveRule(rule)
  const probe = (await source.probe('https://example.com/api/news'))!
  const subscription = new JsonSubscriptionService(fixture.library, source)
  const added = await subscription.add(probe)
  fixture.jsonRules.saveRule({ ...rule, itemsPath: '$.missing[*]' })
  return { feedId: added.feedId, rule: probe.rule, subscription }
}

describe('JSON 来源绑定的完整配置备份', () => {
  it('规则目录变更后，备份仍携带每个来源当时确认的规则', async () => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = JSON.parse(fixture.backup.exportBackup())
    expect(backup.jsonRules.subscriptions?.[saved.feedId]?.rule).toEqual(saved.rule)
    expect(backup.jsonRules.subscriptions?.[saved.feedId]?.endpointUrl).toBe('https://example.com/api/news')
    expect(backup.jsonRules.subscriptions?.[saved.feedId]?.rule.dateTimeZone).toBe('UTC')
  }))

  it('恢复到新的来源 ID 后沿用已确认规则，不重新选择目录规则', async () => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = fixture.backup.exportBackup()
    fixture.library.deleteFeed(saved.feedId)
    fixture.backup.restoreBackup(backup)
    const restored = fixture.library.findFeedByUrl('https://example.com/api/news')!
    expect(restored.id).not.toBe(saved.feedId)
    expect((await saved.subscription.refresh(restored.id)).fetchedArticles).toBe(1)
    expect(fixture.library.getJsonFeedRule(restored.id)).toEqual(saved.rule)
  }))

  it.each(['missing-feed', 'invalid-rule'])('无效绑定在写入前明确拒绝：%s', async (failure) => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = JSON.parse(fixture.backup.exportBackup())
    const binding = { sourcePageUrl: 'https://example.com/api/news', endpointUrl: 'https://example.com/api/news',
      importedRule: true, rule: failure === 'invalid-rule' ? { ...saved.rule, itemsPath: 'invalid path' } : saved.rule }
    backup.jsonRules.subscriptions = { [failure === 'missing-feed' ? 'absent' : saved.feedId]: binding }
    const before = fixture.library.snapshot()
    expect(() => fixture.backup.restoreBackup(JSON.stringify(backup))).toThrow()
    expect(fixture.library.snapshot()).toEqual(before)
    expect(fixture.library.getJsonFeedRule(saved.feedId)).toEqual(saved.rule)
  }))

  it('恢复会合并的跟踪参数地址存在规则冲突时，在写入前拒绝', async () => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = JSON.parse(fixture.backup.exportBackup())
    const original = backup.subscriptions.feeds.find((feed: { id: string }) => feed.id === saved.feedId)
    const duplicateUrl = `${original.url}?utm_source=other`
    backup.subscriptions.feeds.push({ ...original, id: 'duplicate-json', url: duplicateUrl })
    backup.jsonRules.subscriptions['duplicate-json'] = {
      ...backup.jsonRules.subscriptions[saved.feedId], endpointUrl: duplicateUrl,
      rule: { ...saved.rule, itemsPath: '$.different[*]' }
    }
    const before = fixture.library.snapshot()
    const rulesBefore = fixture.jsonRules.exportRules()
    expect(() => fixture.backup.restoreBackup(JSON.stringify(backup))).toThrow('冲突规则绑定')
    expect(fixture.library.snapshot()).toEqual(before)
    expect(fixture.jsonRules.exportRules()).toBe(rulesBefore)
    expect(fixture.library.getJsonFeedRule(saved.feedId)).toEqual(saved.rule)
  }))

  it('等价地址携带相同绑定时，正常合并并保留确认规则', async () => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = JSON.parse(fixture.backup.exportBackup())
    const original = backup.subscriptions.feeds.find((feed: { id: string }) => feed.id === saved.feedId)
    const duplicateUrl = `${original.url}?utm_source=other`
    backup.subscriptions.feeds.push({ ...original, id: 'duplicate-json', url: duplicateUrl })
    backup.jsonRules.subscriptions['duplicate-json'] = {
      ...backup.jsonRules.subscriptions[saved.feedId], sourcePageUrl: duplicateUrl, endpointUrl: duplicateUrl
    }
    fixture.library.deleteFeed(saved.feedId)
    fixture.backup.restoreBackup(JSON.stringify(backup))
    const restored = fixture.library.findFeedByUrl(original.url)!
    expect(fixture.library.listFeeds().filter((feed) => feed.sourceType === 'json')).toHaveLength(1)
    expect(fixture.library.getJsonFeedRule(restored.id)).toEqual(saved.rule)
    expect((await saved.subscription.refresh(restored.id)).fetchedArticles).toBe(1)
  }))

  it('恢复后续配置失败时，来源绑定与 SQLite 数据共同回滚', async () => withBackup(async (fixture) => {
    const saved = await subscribeJson(fixture)
    const backup = JSON.parse(fixture.backup.exportBackup())
    const nextRule: JsonRule = { ...saved.rule, name: 'Changed binding' }
    backup.jsonRules.subscriptions = { [saved.feedId]: { sourcePageUrl: 'https://example.com/api/news',
      endpointUrl: 'https://example.com/api/news', importedRule: true, rule: nextRule } }
    let ruleAtFailure: JsonRule | null = null
    fixture.customization.update = () => {
      ruleAtFailure = fixture.library.getJsonFeedRule(saved.feedId)
      throw new Error('Late configuration failure')
    }
    await expect(async () => fixture.backup.restoreBackup(JSON.stringify(backup))).rejects.toThrow('Late configuration failure')
    expect(ruleAtFailure).toEqual(nextRule)
    expect(fixture.library.getJsonFeedRule(saved.feedId)).toEqual(saved.rule)
  }))
})
