import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyMigrations, CURRENT_ACCOUNT_SETTING_KEY, CURRENT_SCHEMA_VERSION, DEFAULT_GROUP_ID } from './migrations'
import { ORIGREAD_DESKTOP_RELEASE_FEED_URL } from '../../shared/origread-release'

describe('database migration v2 -> current schema', () => {
  it('upgrades released main v13 while preserving RSSHub descriptors, articles and chat history', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(readFileSync(new URL('./fixtures/main-v13.sql', import.meta.url), 'utf8'))
      db.exec('PRAGMA foreign_keys=ON')
      db.prepare(`INSERT INTO feeds(id,account_id,group_id,name,url,source_type,created_at,updated_at)
        VALUES('rsshub-feed',1,?,'RSSHub','https://hub.example/route','rss',1,1)`).run(DEFAULT_GROUP_ID)
      db.exec(`
        INSERT INTO rsshub_source_urls VALUES('rsshub-feed','/github/issue/example/repo','/github/issue/example/repo','https://hub.example','https://hub.example','https://hub.example/route');
        INSERT INTO articles(id,account_id,feed_id,title,is_unread,is_starred,created_at,updated_at)
          VALUES('saved-article',1,'rsshub-feed','Saved',0,1,1,1);
        INSERT INTO llm_conversations(id,title,created_at,updated_at) VALUES('saved-chat','Chat',1,1);
        INSERT INTO llm_messages(id,conversation_id,role,content,created_at,updated_at)
          VALUES('saved-message','saved-chat','ASSISTANT','Saved answer',1,1);
      `)
      const descriptor = db.prepare('SELECT * FROM rsshub_source_urls').all()
      const history = db.prepare('SELECT * FROM llm_messages').all()
      expect(applyMigrations(db)).toBe(38)
      expect(db.prepare('SELECT * FROM rsshub_source_urls').all()).toEqual(descriptor)
      expect(db.prepare('SELECT * FROM llm_messages').all()).toEqual(history)
      expect(db.prepare('SELECT is_unread,is_starred,is_read_later FROM articles').get())
        .toEqual({ is_unread: 0, is_starred: 1, is_read_later: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM sync_spaces').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM sync_identity_mapping').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 38 })
      expect(applyMigrations(db)).toBe(38)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  })

  it('adds RSSHub descriptors to sync v37 without replacing identity or pending outbox state', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applyMigrations(db)
      db.exec(`
        DROP INDEX rsshub_source_urls_route_idx;
        ALTER TABLE rsshub_source_urls DROP COLUMN route_path;
        ALTER TABLE rsshub_source_urls DROP COLUMN preferred_instance;
        ALTER TABLE rsshub_source_urls DROP COLUMN last_resolved_instance;
        ALTER TABLE rsshub_source_urls DROP COLUMN last_resolved_url;
        DELETE FROM schema_migrations WHERE version=38;
        INSERT INTO sync_spaces VALUES('existing-space',1,1);
        INSERT INTO sync_identity_mapping VALUES('existing-space','feed','feed-1','sync-feed-1','source',0,1,1);
        INSERT INTO sync_outbox(outbox_id,sync_space_id,actor_incarnation_id,replication_lane_id,sequence,
          entity_type,entity_sync_id,entity_generation,mutation_type,payload_schema_version,payload_json,
          causal_context_json,status,created_at,updated_at)
          VALUES('pending-1','existing-space','actor-1','library',1,'feed','sync-feed-1',0,'UPSERT',1,'{}','{}','PENDING_BUILD',1,1);
      `)
      const identities = db.prepare('SELECT * FROM sync_identity_mapping').all()
      const outbox = db.prepare('SELECT * FROM sync_outbox').all()
      expect(applyMigrations(db)).toBe(38)
      expect(db.prepare('SELECT * FROM sync_identity_mapping').all()).toEqual(identities)
      expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(outbox)
      expect((db.prepare("PRAGMA table_info('rsshub_source_urls')").all() as Array<{ name: string }>).map(row => row.name))
        .toEqual(expect.arrayContaining(['route_path','preferred_instance','last_resolved_instance','last_resolved_url']))
      expect(applyMigrations(db)).toBe(38)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  })

  it('rolls back the main v13 identity repair if the next migration fails and can retry safely', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(readFileSync(new URL('./fixtures/main-v13.sql', import.meta.url), 'utf8'))
      db.exec('CREATE TABLE sync_local_space_binding (conflict TEXT)')
      expect(() => applyMigrations(db)).toThrow()
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('sync_spaces','sync_identity_mapping')").all())
        .toEqual([])
      db.exec('DROP TABLE sync_local_space_binding')
      expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  })

  it('creates the full current schema from a fresh install', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: CURRENT_SCHEMA_VERSION })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'accounts', 'groups', 'feeds', 'articles',
      'llm_conversations', 'llm_conversation_articles', 'llm_messages', 'llm_tool_calls',
      'llm_context_refs', 'llm_evidence_blocks', 'llm_citation_refs',
      'llm_citation_annotations', 'llm_citation_annotation_refs',
      'sync_spaces', 'sync_identity_mapping',
      'sync_local_space_binding', 'sync_device_identity', 'sync_actor_incarnation',
      'sync_lane_writer_state', 'sync_applied_frontier', 'sync_outbox', 'sync_operation_log',
      'sync_genesis_session', 'sync_snapshot_bundle', 'sync_snapshot_shard', 'sync_genesis_operation_coverage',
      'sync_alias_edge', 'sync_entity_alias', 'sync_local_eviction'
    ]))
    const messageColumns = (db.prepare("PRAGMA table_info('llm_messages')").all() as Array<{ name: string }>).map((column) => column.name)
    expect(messageColumns).toEqual(expect.arrayContaining([
      'provider_id', 'model', 'web_search_status', 'web_search_query', 'web_search_provider_name',
      'web_search_result_count', 'web_search_error_message'
    ]))
    const rssHubColumns = (db.prepare("PRAGMA table_info('rsshub_source_urls')").all() as Array<{ name: string }>).map((column) => column.name)
    expect(rssHubColumns).toEqual(expect.arrayContaining([
      'source_url', 'route_path', 'preferred_instance', 'last_resolved_instance', 'last_resolved_url'
    ]))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

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
    expect(db.prepare(`
      SELECT route_path,preferred_instance,last_resolved_instance,last_resolved_url
      FROM rsshub_source_urls WHERE feed_id=?
    `).get('feed-1')).toEqual({
      route_path:null,preferred_instance:null,last_resolved_instance:null,last_resolved_url:null
    })
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(CURRENT_ACCOUNT_SETTING_KEY)).toEqual({value:'1'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_articles'").get()).toEqual({name:'archived_articles'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rss_http_cache'").get()).toEqual({name:'rss_http_cache'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_conversations'").get()).toEqual({name:'llm_conversations'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_messages'").get()).toEqual({name:'llm_messages'})
    const llmMessageColumns = db.prepare("PRAGMA table_info('llm_messages')").all() as Array<{name:string}>
    expect(llmMessageColumns.map((column)=>column.name)).toEqual(expect.arrayContaining([
      'provider_id','model','web_search_status','web_search_query','web_search_provider_name','web_search_result_count','web_search_error_message'
    ]))
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_context_refs'").get()).toEqual({name:'llm_context_refs'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_evidence_blocks'").get()).toEqual({name:'llm_evidence_blocks'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_citation_refs'").get()).toEqual({name:'llm_citation_refs'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_citation_annotations'").get()).toEqual({name:'llm_citation_annotations'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_citation_annotation_refs'").get()).toEqual({name:'llm_citation_annotation_refs'})
    expect(db.prepare(`
      SELECT f.account_id,f.group_id,f.name,f.url,f.source_page_url,f.source_type,f.icon
      FROM feeds f
      JOIN groups g ON g.id=f.group_id
      WHERE f.url=? AND g.is_default=1
    `).get(ORIGREAD_DESKTOP_RELEASE_FEED_URL)).toEqual({
      account_id:1,
      group_id:DEFAULT_GROUP_ID,
      name:'OrigRead Desktop Releases',
      url:ORIGREAD_DESKTOP_RELEASE_FEED_URL,
      source_page_url:'https://github.com/ZGMFX01A/OrigRead-Desktop/releases',
      source_type:'rss',
      icon:'https://github.com/ZGMFX01A.png'
    })
    db.prepare('DELETE FROM feeds WHERE url=?').run(ORIGREAD_DESKTOP_RELEASE_FEED_URL)
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) AS count FROM feeds WHERE url=?').get(ORIGREAD_DESKTOP_RELEASE_FEED_URL)).toEqual({count:0})
    db.close()
  })

  it('backfills v8 assistant model snapshots and adds Web Search history columns through the current schema', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE llm_conversations (
        id TEXT PRIMARY KEY,title TEXT NOT NULL,provider_id TEXT,model TEXT,skill_id TEXT,
        article_id TEXT,article_title TEXT,article_link TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE llm_messages (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',request_task TEXT,reasoning TEXT,status TEXT NOT NULL DEFAULT 'COMPLETE',
        error_message TEXT,history_active INTEGER NOT NULL DEFAULT 1,prompt_tokens INTEGER,completion_tokens INTEGER,
        duration_ms INTEGER,token_usage_estimated INTEGER NOT NULL DEFAULT 0,finish_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO llm_conversations VALUES('c1','Chat','provider-old','model-old',NULL,NULL,NULL,NULL,1,1);
      INSERT INTO llm_messages VALUES('u1','c1','USER','Question','CHAT',NULL,'COMPLETE',NULL,1,NULL,NULL,NULL,0,NULL,2,2);
      INSERT INTO llm_messages VALUES('a1','c1','ASSISTANT','Answer','CHAT',NULL,'COMPLETE',NULL,1,NULL,NULL,NULL,0,'STOP',3,3);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES(8,1);
    `)

    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT provider_id,model FROM llm_messages WHERE id=?').get('a1'))
      .toEqual({provider_id:'provider-old',model:'model-old'})
    expect(db.prepare('SELECT provider_id,model FROM llm_messages WHERE id=?').get('u1'))
      .toEqual({provider_id:null,model:null})
    const columns = db.prepare("PRAGMA table_info('llm_messages')").all() as Array<{name:string}>
    expect(columns.map((column)=>column.name)).toEqual(expect.arrayContaining([
      'web_search_status','web_search_query','web_search_provider_name','web_search_result_count','web_search_error_message'
    ]))
    db.close()
  })

  it('upgrades an already-v9 database without relying on the historical v8 create-table definition', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE llm_conversations (
        id TEXT PRIMARY KEY,title TEXT NOT NULL,provider_id TEXT,model TEXT,skill_id TEXT,
        article_id TEXT,article_title TEXT,article_link TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE llm_messages (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',request_task TEXT,provider_id TEXT,model TEXT,reasoning TEXT,
        status TEXT NOT NULL DEFAULT 'COMPLETE',error_message TEXT,history_active INTEGER NOT NULL DEFAULT 1,
        prompt_tokens INTEGER,completion_tokens INTEGER,duration_ms INTEGER,token_usage_estimated INTEGER NOT NULL DEFAULT 0,
        finish_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES(9,1);
    `)

    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    const columns = db.prepare("PRAGMA table_info('llm_messages')").all() as Array<{name:string}>
    expect(columns.map((column)=>column.name)).toEqual(expect.arrayContaining([
      'web_search_status','web_search_query','web_search_provider_name','web_search_result_count','web_search_error_message'
    ]))
    db.close()
  })

  it('repairs a v9 development database that already contains only part of the v10 Web Search columns', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE llm_conversations (
        id TEXT PRIMARY KEY,title TEXT NOT NULL,provider_id TEXT,model TEXT,skill_id TEXT,
        article_id TEXT,article_title TEXT,article_link TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE llm_messages (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',request_task TEXT,provider_id TEXT,model TEXT,reasoning TEXT,
        status TEXT NOT NULL DEFAULT 'COMPLETE',error_message TEXT,history_active INTEGER NOT NULL DEFAULT 1,
        web_search_status TEXT,web_search_query TEXT,web_search_provider_name TEXT,web_search_error_message TEXT,
        prompt_tokens INTEGER,completion_tokens INTEGER,duration_ms INTEGER,token_usage_estimated INTEGER NOT NULL DEFAULT 0,
        finish_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES(9,1);
    `)

    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(Array.from({ length: CURRENT_SCHEMA_VERSION - 8 }, (_, index) => ({ version: index + 9 })))
    const columns = db.prepare("PRAGMA table_info('llm_messages')").all() as Array<{name:string}>
    expect(columns.map((column)=>column.name)).toEqual(expect.arrayContaining([
      'web_search_status','web_search_query','web_search_provider_name','web_search_result_count','web_search_error_message'
    ]))
    db.close()
  })

  it('creates an empty sync identity layer and keeps canonical keys non-unique', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)

    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_spaces').get()).toEqual({count:0})
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_identity_mapping').get()).toEqual({count:0})

    db.prepare('INSERT INTO sync_spaces(sync_space_id,created_at,updated_at) VALUES(?,?,?)')
      .run('space-1',1,1)
    const insert = db.prepare(`
      INSERT INTO sync_identity_mapping(
        sync_space_id,entity_type,local_id,sync_id,canonical_key,generation,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `)
    insert.run('space-1','feed','local-feed-1','sync-feed-1','same-source',0,1,1)
    insert.run('space-1','feed','local-feed-2','sync-feed-2','same-source',0,1,1)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type=? AND canonical_key=?
    `).get('space-1','feed','same-source')).toEqual({count:2})

    expect(() => insert.run('space-1','feed','local-feed-3','sync-feed-2','other-source',0,1,1)).toThrow()
    db.close()
  })

  it('creates the v15 global operation log with Dot and status indexes', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_operation_log').get()).toEqual({count:0})
    const indexes = (db.prepare("PRAGMA index_list('sync_operation_log')").all() as Array<{name:string}>).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'sync_operation_log_actor_lane_sequence_idx',
      'sync_operation_log_space_status_created_idx',
      'sync_operation_log_space_entity_idx'
    ]))
    db.close()
  })

  it('creates the v16 Genesis session and snapshot layer and extends the outbox cut marker', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    const outboxColumns = (db.prepare("PRAGMA table_info('sync_outbox')").all() as Array<{name:string}>).map((row) => row.name)
    expect(outboxColumns).toContain('genesis_included_at')
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_genesis_session').get()).toEqual({count:0})
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_snapshot_bundle').get()).toEqual({count:0})
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_snapshot_shard').get()).toEqual({count:0})
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_genesis_operation_coverage').get()).toEqual({count:0})
    db.close()
  })

  it('creates separate durable Received/Applied, endpoint, peer and Blob state', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>)
      .map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'sync_inbox_operation', 'sync_coverage', 'sync_apply_journal', 'sync_peer_identity',
      'sync_endpoint_config', 'sync_peer_cursor', 'sync_blob_manifest',
      'sync_blob_reference', 'sync_blob_persisted_ack', 'sync_trusted_device'
    ]))
    expect(tables).toEqual(expect.arrayContaining(['sync_field_version', 'sync_entity_alias', 'sync_entity_tombstone', 'sync_auth_ledger']))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })
  it('upgrades v22 additively with LocalRecoverySnapshot, Alias and Blob state', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applyMigrations(db)
      db.exec(`
        ALTER TABLE articles DROP COLUMN is_read_later;
        DROP TRIGGER sync_operation_bind_author;
        DROP TABLE sync_actor_author;
        ALTER TABLE sync_snapshot_bundle DROP COLUMN auth_stability_checkpoint_id;
        DROP TABLE sync_blob_persisted_ack;
        DROP TABLE sync_blob_reference;
        ALTER TABLE sync_snapshot_shard DROP COLUMN blob_reference_index_json;
        ALTER TABLE sync_snapshot_shard DROP COLUMN blob_manifest_index_json;
        ALTER TABLE sync_blob_manifest DROP COLUMN failure_reason;
        ALTER TABLE sync_blob_manifest DROP COLUMN availability_state;
        ALTER TABLE sync_blob_manifest DROP COLUMN availability_policy;
        ALTER TABLE sync_blob_manifest DROP COLUMN encryption_info_json;
        ALTER TABLE sync_blob_manifest DROP COLUMN compression;
        ALTER TABLE sync_recovery_capsule DROP COLUMN recovery_state_json;
        DROP TABLE sync_alias_edge;
        DROP TABLE sync_local_eviction;
        DELETE FROM schema_migrations WHERE version>=23;
      `)
      const before = db.prepare('SELECT * FROM accounts ORDER BY id').all()
      expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
      expect(db.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual(before)
      const columns = (db.prepare("PRAGMA table_info('sync_recovery_capsule')").all() as Array<{ name: string }>).map((row) => row.name)
      expect(columns).toContain('recovery_state_json')
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
      expect(tables).toEqual(expect.arrayContaining([
        'sync_alias_edge', 'sync_entity_alias', 'sync_local_eviction',
        'sync_blob_reference', 'sync_blob_persisted_ack'
      ]))
      const blobColumns = (db.prepare("PRAGMA table_info('sync_blob_manifest')").all() as Array<{ name: string }>).map((row) => row.name)
      expect(blobColumns).toEqual(expect.arrayContaining(['availability_state','availability_policy','compression','encryption_info_json']))
      const shardColumns = (db.prepare("PRAGMA table_info('sync_snapshot_shard')").all() as Array<{ name: string }>).map((row) => row.name)
      expect(shardColumns).toEqual(expect.arrayContaining(['blob_manifest_index_json','blob_reference_index_json']))
      expect(applyMigrations(db)).toBe(CURRENT_SCHEMA_VERSION)
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  })

})
