import type { DatabaseSync } from 'node:sqlite'

import type { LibraryRepository } from './library-repository'
import { ARTICLE_ID_QUERY_CHUNK_SIZE } from './library-rows'

/** 按归档清理职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryArchive {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  deleteNonStarredArticlesForAccount(accountId: number): void {
    this.database.prepare('DELETE FROM articles WHERE account_id = ? AND is_starred = 0').run(accountId)
  }

  isArchivedLink(feedId:string,link:string|null|undefined):boolean {
    if(!link)return false
    return this.database.prepare('SELECT 1 AS found FROM archived_articles WHERE feed_id=? AND link=?')
      .get(feedId,link)!==undefined
  }

  archivedLinks(feedId: string, links: Array<string | null | undefined>): Set<string> {
    const candidates = [...new Set(links.filter((link): link is string => Boolean(link)))]
    if (candidates.length === 0) return new Set()
    const archived = new Set<string>()
    for (let offset = 0; offset < candidates.length; offset += ARTICLE_ID_QUERY_CHUNK_SIZE) {
      const chunk = candidates.slice(offset, offset + ARTICLE_ID_QUERY_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.database.prepare(
        `SELECT link FROM archived_articles WHERE feed_id = ? AND link IN (${placeholders})`
      ).all(feedId, ...chunk) as unknown as Array<{ link: string }>
      for (const row of rows) archived.add(row.link)
    }
    return archived
  }

  archiveExpiredArticlesForAccount(accountId:number,keepArchivedMillis:number,now=Date.now()):number {
    if(keepArchivedMillis<=0)return 0
    const cutoff=now-keepArchivedMillis
    const rows=this.database.prepare(`
      SELECT id,feed_id,url FROM articles
      WHERE account_id=? AND COALESCE(published_at,created_at)<? AND is_unread=0 AND is_starred=0
    `).all(accountId,cutoff) as unknown as Array<{id:string;feed_id:string;url:string|null}>
    if(rows.length===0)return 0
    const insert=this.database.prepare(`
      INSERT INTO archived_articles(feed_id,link,archived_at) VALUES(?,?,?)
      ON CONFLICT(feed_id,link) DO UPDATE SET archived_at=excluded.archived_at
    `)
    const remove=this.database.prepare('DELETE FROM articles WHERE account_id=? AND id=?')
    const insertIdentity=this.database.prepare(`
      INSERT INTO archived_article_ids(feed_id,article_id,archived_at) VALUES(?,?,?)
      ON CONFLICT(feed_id,article_id) DO UPDATE SET archived_at=excluded.archived_at
    `)
    this.library.transaction(() => {
      for(const row of rows){
        if(row.url)insert.run(row.feed_id,row.url,now)
        insertIdentity.run(row.feed_id,row.id,now)
        remove.run(accountId,row.id)
      }
    })
    return rows.length
  }

  /** 无链接文章按稳定 ID 查询归档墓碑，仍分批处理完整候选集合。 */
  archivedArticleIds(feedId: string, ids: string[]): Set<string> {
    const archived = new Set<string>()
    for (let offset = 0; offset < ids.length; offset += ARTICLE_ID_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ARTICLE_ID_QUERY_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.database.prepare(
        `SELECT article_id FROM archived_article_ids WHERE feed_id = ? AND article_id IN (${placeholders})`
      ).all(feedId, ...chunk) as unknown as Array<{ article_id: string }>
      for (const row of rows) archived.add(row.article_id)
    }
    return archived
  }
}
