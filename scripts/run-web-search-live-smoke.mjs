import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  appType: 'custom',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] }
})

try {
  await server.ssrLoadModule('/scripts/web-search-live-smoke.ts')
} finally {
  await server.close()
}
