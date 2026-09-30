import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/sync/server/cli.ts'],
  outfile: 'out/sync-server/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
})
