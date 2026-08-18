import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations, CURRENT_ACCOUNT_SETTING_KEY, CURRENT_SCHEMA_VERSION } from './migrations'

describe('database migration v2 -> current schema', () => {
  it('moves existing library rows into Local account 1 without losing read/starred state', () => {
    const db=new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES(1,1),(2,2);
      CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0,is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN(0,1))) STRICT;
      CREATE TABLE feeds(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,name TEXT NOT NULL,url TEXT NOT NULL UNIQUE,source_page_url TEXT,source_type TEXT NOT NULL CHECK(source_type IN('rss','website','json')),icon TEXT,is_notification INTEGER NOT NULL DEFAULT 0 CHECK(is_notification IN(0,1)),is_full_content INTEGER NOT NULL DEFAULT 0 CHECK(is_full_content IN(0,1)),is_browser INTEGER NOT NULL DEFAULT 0 CHECK(is_browser IN(0,1)),dynamic_rendering INTEGER NOT NULL DEFAULT 0 CHECK(dynamic_rendering IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,title TEXT NOT NULL,url TEXT,author TEXT,published_at INTEGER,description TEXT NOT NULL DEFAULT '',content_html TEXT,full_content_html TEXT,is_unread INTEGER NOT NULL DEFAULT 1 CHECK(is_unread IN(0,1)),is_starred INTEGER NOT NULL DEFAULT 0 CHECK(is_starred IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,image_url TEXT) STRICT;
      CREATE TABLE rsshub_source_urls(feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,source_url TEXT NOT NULL) STRICT;
      CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      INSERT INTO groups VALUES('local-default','Default',0,1);
      INSERT INTO feeds VALUES('feed-1','local-default','Feed','https://example.com/rss','https://example.com/','rss',NULL,0,0,0,0,10,20);
      INSERT INTO articles VALUES('article-1','feed-1','Article','https://example.com/1',NULL,30,'d','<p>x</p>',NULL,0,1,10,20,'https://example.com/1.png');
      INSERT INTO rsshub_source_urls VALUES('feed-1','https://example.com/');
    `)

    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT id,type FROM accounts').get()).toEqual({id:1,type:'local'})
    expect(db.prepare('SELECT account_id,url FROM feeds WHERE id=?').get('feed-1')).toEqual({account_id:1,url:'https://example.com/rss'})
    expect(db.prepare('SELECT account_id,is_unread,is_starred,image_url FROM articles WHERE id=?').get('article-1'))
      .toEqual({account_id:1,is_unread:0,is_starred:1,image_url:'https://example.com/1.png'})
    expect(db.prepare('SELECT source_url FROM rsshub_source_urls WHERE feed_id=?').get('feed-1')).toEqual({source_url:'https://example.com/'})
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(CURRENT_ACCOUNT_SETTING_KEY)).toEqual({value:'1'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_articles'").get()).toEqual({name:'archived_articles'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rss_http_cache'").get()).toEqual({name:'rss_http_cache'})
    db.close()
  })
})
