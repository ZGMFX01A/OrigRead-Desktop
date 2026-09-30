FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci
COPY src ./src
COPY scripts/build-sync-server.mjs ./scripts/build-sync-server.mjs
RUN npm run build:sync-server

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /app/out/sync-server ./server

ENV NODE_ENV=production \
    SYNC_SERVER_HOST=0.0.0.0 \
    SYNC_SERVER_PORT=8787 \
    SYNC_SERVER_DB=/data/sync-server.db \
    SYNC_SERVER_BLOBS=/data/blobs
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server/cli.mjs"]
