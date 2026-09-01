import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      'tests/e2e/**',
      'chatbox-main/**',
      'node_modules/**',
      'out/**',
      'release/**',
      'test-results/**'
    ]
  }
})
