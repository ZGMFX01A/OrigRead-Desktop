import type { DatabaseSync } from 'node:sqlite'
import type { ArticleRecord } from '../../shared/library'

import type { LibraryRepository } from './library-repository'
import { PreparedStatement, toSqlBoolean, ARTICLE_ID_QUERY_CHUNK_SIZE } from './library-rows'

/** 按文章写入职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryWriter {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  setArticleFullContent(articleId: string, html: string | null): void {
    const accountId = this.library.getCurrentAccountId()
    this.database
      .prepare('UPDATE articles SET full_content_html = ?, updated_at = ? WHERE account_id = ? AND id = ?')
      .run(html, Date.now(), accountId, articleId)
  }

  deleteArticlesByFeed(feedId: string, includeStarred = false): void {
    this.database
      .prepare(`DELETE FROM articles WHERE feed_id = ?${includeStarred ? '' : ' AND is_starred = 0'}`)
      .run(feedId)
  }

  upsertArticle(article: ArticleRecord): void {
    this.runArticleUpsert(this.prepareArticleUpsert(), article)
  }

  prepareArticleUpsert(): PreparedStatement {
    return this.database.prepare(`
      INSERT INTO articles (
        id, account_id, feed_id, title, url, author, published_at, description,
        content_html, full_content_html, image_url, is_unread, is_starred,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        feed_id = excluded.feed_id,
        title = excluded.title,
        url = excluded.url,
        author = excluded.author,
        published_at = excluded.published_at,
        description = excluded.description,
        content_html = excluded.content_html,
        full_content_html = COALESCE(excluded.full_content_html, articles.full_content_html),
        image_url = excluded.image_url,
        updated_at = excluded.updated_at
    `)
  }

  runArticleUpsert(statement: PreparedStatement, article: ArticleRecord): void {
    statement.run(
      article.id,
      article.accountId ?? this.library.getCurrentAccountId(),
      article.feedId,
      article.title,
      article.url,
      article.author,
      article.publishedAt,
      article.description,
      article.contentHtml,
      article.fullContentHtml,
      article.imageUrl,
      toSqlBoolean(article.isUnread),
      toSqlBoolean(article.isStarred),
      article.createdAt,
      article.updatedAt
    )
  }

  upsertArticlesPrepared(articles: ArticleRecord[]): void {
    if (articles.length === 0) return
    const statement = this.prepareArticleUpsert()
    for (const article of articles) this.runArticleUpsert(statement, article)
  }

  setArticleUnread(articleId: string, unread: boolean): void {
    this.setArticleUnreadForAccount(this.library.getCurrentAccountId(), articleId, unread)
  }

  setArticleUnreadForAccount(accountId:number, articleId:string, unread:boolean):void {
    this.database
      .prepare('UPDATE articles SET is_unread = ? WHERE account_id = ? AND id = ?')
      .run(toSqlBoolean(unread), accountId, articleId)
  }

  setArticleUnreadBatchForAccount(accountId:number, articleIds:string[], unread:boolean):void {
    this.updateArticleBooleanBatch(accountId, articleIds, { column: 'is_unread', value: unread })
  }

  setArticleStarred(articleId: string, starred: boolean): void {
    this.setArticleStarredForAccount(this.library.getCurrentAccountId(), articleId, starred)
  }

  setArticleStarredForAccount(accountId:number, articleId:string, starred:boolean):void {
    this.database
      .prepare('UPDATE articles SET is_starred = ? WHERE account_id = ? AND id = ?')
      .run(toSqlBoolean(starred), accountId, articleId)
  }

  setArticleStarredBatchForAccount(accountId:number, articleIds:string[], starred:boolean):void {
    this.updateArticleBooleanBatch(accountId, articleIds, { column: 'is_starred', value: starred })
  }

  updateArticleBooleanBatch(
    accountId:number,
    articleIds:string[],
    options: { column:'is_unread'|'is_starred'; value:boolean }
  ):void {
    const { column, value } = options
    const ids=[...new Set(articleIds)]
    if(ids.length===0)return
    this.library.transaction(() => {
      for(let offset=0;offset<ids.length;offset+=ARTICLE_ID_QUERY_CHUNK_SIZE){
        const chunk=ids.slice(offset,offset+ARTICLE_ID_QUERY_CHUNK_SIZE)
        const placeholders=chunk.map(()=>'?').join(',')
        this.database.prepare(
          `UPDATE articles SET ${column}=? WHERE account_id=? AND id IN (${placeholders})`
        ).run(toSqlBoolean(value),accountId,...chunk)
      }
    })
  }
}
