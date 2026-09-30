# OrigRead Durable Sync Peer

This container stores signed operation envelopes, client snapshots, coverage cursors and content-addressed Blob bytes. It never interprets library, reader or Chat business fields; merge and Apply remain on clients.

Required environment:

- `SYNC_SERVER_ADMIN_TOKEN`: bootstrap token used only to register/revoke device public keys.
- `SYNC_SERVER_PORT`: listening port, default `8787`.

The SQLite database and Blob directory are both under `/data`; back up the volume as one unit. A reverse proxy should provide public TLS. The client must use the same Sync Space ID and its registered device ID; changing a device key is intentionally rejected as an AUTH key collision.

## Upgrade and recovery

1. Stop the container or create a filesystem snapshot of the whole `/data` volume. The SQLite database, WAL files and `blobs/` directory are one consistency unit.
2. Create a backup before replacing the image. On Windows, `backup.ps1` creates a ZIP only when the service is stopped; on Linux/NAS, use an atomic volume snapshot or a `tar` archive of `/data`.
3. Pull the new image and run `docker compose up -d --build`. The server performs additive SQLite migrations at startup and keeps the persisted `server_epoch`.
4. Restore by stopping the service, moving the existing data directory aside, extracting the archive, and starting the same or a newer image. `restore.ps1` refuses to merge into a non-empty target.

After a restore from an older snapshot, clients may report `CURSOR_REWIND`/`SERVER_HISTORY_REWIND`. They must discard only the server cursor, exchange State Vectors again, re-upload retained signed Operations and re-negotiate a compatible Snapshot; local Operation IDs and Applied Journal entries remain authoritative for idempotency. A restored registry is not permission to resurrect a revoked device.

## Security and exposure

Keep the admin token out of the image and never expose the admin member-management route through an unauthenticated reverse-proxy path. Publish the service through HTTPS, restrict the admin route by network policy, and rotate the token during planned maintenance. The server stores signed envelopes and encrypted/opaque payloads as provided by clients; it is not a business merge engine. `AI_HISTORY` is paused by the default policy and cannot be enabled accidentally by a Library sync.

Local smoke check:

```text
docker compose -f sync-server/docker-compose.yml up -d --build
curl http://127.0.0.1:8787/healthz
```

The service has no permanent WebSocket requirement. Clients perform foreground, background and manual anti-entropy sessions, so a restart or temporary outage is recoverable through the cursor/coverage exchange.

## Current implementation limits (2026-09-19)

Remote snapshot installation, recovery/GC snapshot acceptance and operation pruning are intentionally blocked until the required merge and stability proofs are implemented. This prototype has not passed full cross-device recovery acceptance. AUTH signatures now bind authSequence; upgrade peers together. Existing unscoped Blob files need an explicit ownership migration before use.

Windows backup and restore scripts require `-ServiceStopped` as the caller's acknowledgement that the service has already stopped; they do not detect or stop the service automatically. A file-copy smoke test is not a SQLite consistency recovery test.
