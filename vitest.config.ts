import { defineConfig } from 'vitest/config';

// 单元测试只在 Node 环境运行，不依赖浏览器。
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
