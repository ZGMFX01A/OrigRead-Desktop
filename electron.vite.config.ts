import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: {
      index: resolve('src/main/index.ts'),
      'sync-frozen-snapshot-worker': resolve('src/main/sync/sync-frozen-snapshot-worker.ts'),
      'sync-snapshot-install-worker': resolve('src/main/sync/sync-snapshot-install-worker.ts'),
      'sync-snapshot-capture-worker': resolve('src/main/sync/sync-snapshot-capture-worker.ts'),
      'sync-snapshot-merge-worker': resolve('src/main/sync/sync-snapshot-merge-worker.ts'),
      'sync-snapshot-publication-worker': resolve('src/main/sync/sync-snapshot-publication-worker.ts')
    } } }
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})

