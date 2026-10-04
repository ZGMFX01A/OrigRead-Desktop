import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      'tests/runtime/**',
      'chatbox-main/**',
      'node_modules/**',
      'out/**',
      'release/**',
      'test-results/**'
    ]
  }
})
