import type { DatabaseSync } from 'node:sqlite'

/** 普通编辑携带受影响实体；导入/bootstrap 才使用未指定 scope 的整账户捕获。 */
export interface SyncLibrarySelection {
  groupIds?: readonly string[]
  feedIds?: readonly string[]
  articleIds?: readonly string[]
  articleFeedIds?: readonly string[]
  cascade?: boolean
}

/** 父关系变动会让行离开当前范围，只有业务库中实际消失的行才生成全局删除。 */
export function libraryRowExists(input: { database: DatabaseSync; accountId: number; type: 'group' | 'feed' | 'article'; id: string }): boolean {
  const table = { group: 'groups', feed: 'feeds', article: 'articles' }[input.type]
  return input.database.prepare(`SELECT 1 FROM ${table} WHERE id=? AND account_id=? LIMIT 1`)
    .get(input.id, input.accountId) !== undefined
}

/** 依赖父行随受影响行一起读取，新增 Article/Feed 不会因为缺少父 mapping 而降级。 */
export function libraryRows(input: { database: DatabaseSync; accountId: number; scope?: SyncLibrarySelection; type: 'group' | 'feed' | 'article' }): Record<string, unknown>[] {
  const { database, accountId, scope, type } = input
  const table = { group: 'groups', feed: 'feeds', article: 'articles' }[type]
  if (!scope) return database.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY id`).all(accountId)
  const ids = selections({ database, accountId, scope })
  const chosen = ids[type]
  return database.prepare(`SELECT * FROM ${table} WHERE account_id=? AND id IN(SELECT value FROM json_each(?)) ORDER BY id`)
    .all(accountId, JSON.stringify(chosen))
}

/** SQL 只装入 ID；级联删除仅补充受影响订阅下的文章，正文不会全账户读取。 */
function selections(input: { database: DatabaseSync; accountId: number; scope: SyncLibrarySelection }): Record<'group' | 'feed' | 'article', string[]> {
  const { database, accountId, scope } = input
  const feeds = database.prepare(`SELECT id,group_id FROM feeds WHERE account_id=? AND
    (id IN(SELECT value FROM json_each(?)) OR group_id IN(SELECT value FROM json_each(?)) OR
     id IN(SELECT feed_id FROM articles WHERE account_id=? AND id IN(SELECT value FROM json_each(?))))`)
    .all(accountId, JSON.stringify([...(scope.feedIds ?? []), ...(scope.articleFeedIds ?? [])]),
      JSON.stringify(scope.groupIds ?? []), accountId, JSON.stringify(scope.articleIds ?? []))
  const articles = database.prepare(`SELECT id FROM articles WHERE account_id=? AND
    (id IN(SELECT value FROM json_each(?)) OR feed_id IN(SELECT value FROM json_each(?)))`)
    .all(accountId, JSON.stringify(scope.articleIds ?? []), JSON.stringify(scope.cascade ? feeds.map(row => row.id) : scope.articleFeedIds ?? []))
  return { group: [...new Set([...(scope.groupIds ?? []), ...feeds.map(row => String(row.group_id))])],
    feed: [...new Set([...(scope.feedIds ?? []), ...feeds.map(row => String(row.id))])], article: articles.map(row => String(row.id)) }
}
