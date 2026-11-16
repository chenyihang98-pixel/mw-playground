import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// e2e 由 Playwright 自己起停 Vite 开发服务器和关卡工坊的本机服务（P8）：固定端口、strictPort、不复用已有服务。
// 专用会话不能开后台进程，所以服务器的生命周期必须完全由这里管理。
const PORT = 4317;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
/** 工坊服务的端口（Vite 把 /api 代理到这里）。服务用假模型模式：每次模型调用前等 800 毫秒，测试来得及点“停止生成”。 */
export const WORKSHOP_PORT = 4318;
/** 工坊服务的统计写到系统临时目录（由 global-teardown 删除），不写进仓库。 */
export const WORKSHOP_STATS = join(tmpdir(), `mw-playground-e2e-workshop-stats-${String(process.pid)}.jsonl`);

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
    // F6：界面语言按浏览器语言决定；原有的测试都按中文界面写，这里固定浏览器语言为 zh-CN（ja、en 的测试自己切换）
    locale: 'zh-CN',
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
  globalTeardown: './tests/e2e/global-teardown.ts',
  webServer: [
    {
      command: 'node --import tsx server/main.ts',
      url: `http://127.0.0.1:${String(WORKSHOP_PORT)}/api/workshop/health`,
      env: {
        MW_LLM_PROVIDER: 'fake',
        MW_WORKSHOP_PORT: String(WORKSHOP_PORT),
        MW_WORKSHOP_STATS: WORKSHOP_STATS,
        MW_FAKE_DELAY_MS: '800',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `node node_modules/vite/bin/vite.js --mode test --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
      url: `${BASE_URL}/`,
      env: { MW_WORKSHOP_PORT: String(WORKSHOP_PORT) },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
