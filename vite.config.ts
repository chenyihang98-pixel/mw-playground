import { defineConfig } from 'vite';

// 关卡工坊的本机服务（P8）：开发时由 Vite 把 /api 代理过去。端口和 server/config.ts 的默认值（8790）一致，
// 可以用 MW_WORKSHOP_PORT 改。只起 Vite、没有起服务时，工坊按“服务不可用”显示，游戏照常。
const workshopPort = Number(process.env.MW_WORKSHOP_PORT ?? '8790');

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${String(workshopPort)}`, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    // three.js 本身压缩后约 530 kB，超过默认的 500 kB 提示阈值；这里放宽，避免每次构建都报同一条提示。
    chunkSizeWarningLimit: 1000,
  },
});
