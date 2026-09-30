import { SyncServerHttp } from './sync-server-http'

const server = new SyncServerHttp({
  databasePath: process.env.SYNC_SERVER_DB ?? './data/sync-server.db',
  blobDirectory: process.env.SYNC_SERVER_BLOBS ?? './data/blobs',
  host: process.env.SYNC_SERVER_HOST ?? '0.0.0.0',
  port: Number(process.env.SYNC_SERVER_PORT ?? 8787),
  adminToken: process.env.SYNC_SERVER_ADMIN_TOKEN
})

const address = await server.listen()
console.log(JSON.stringify({ ok: true, service: 'origread-sync-server', protocol: 'origread-sync-v1', ...address }))

const shutdown = (): void => { void server.close().finally(() => process.exit(0)) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
