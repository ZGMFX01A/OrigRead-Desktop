import { defineConfig } from '@playwright/test'

// 启动和重启测试在一分钟内明确失败，避免应用故障卡住构建。
const DESKTOP_TEST_TIMEOUT_MS = 60_000
// 同一桌面只运行一个实际应用，避免并发窗口争用。
const DESKTOP_TEST_WORKERS = 1

export default defineConfig({
  testDir: './tests/runtime',
  timeout: DESKTOP_TEST_TIMEOUT_MS,
  workers: DESKTOP_TEST_WORKERS
})
