import { defineConfig, devices } from '@playwright/test';

// e2e 由 Playwright 自己起停 Vite 开发服务器：固定端口、strictPort、不复用已有服务。
// 专用会话不能开后台进程，所以服务器的生命周期必须完全由这里管理。
const PORT = 4317;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // 只用 list 报告器：不生成 playwright-report/ 目录。
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      // Playwright 1.65 默认已给 Chromium 加 --enable-unsafe-swiftshader，无头模式下 WebGL 可用，
      // 这里不需要额外的启动参数。
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --mode test --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
