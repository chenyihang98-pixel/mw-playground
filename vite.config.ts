import { defineConfig } from 'vite';
import { resolveWorkshopPort } from './server/port';

// 关卡工坊的本机服务（P8）：开发时由 Vite 把 /api 代理过去。端口和服务用同一个规则取（server/port.ts）：
// 环境变量 MW_WORKSHOP_PORT 优先，其次项目根目录 .env 里的 MW_WORKSHOP_PORT，都没有时是 8790。
// 只起 Vite、没有起服务时，工坊按“服务不可用”显示，游戏照常。
const workshopPort = resolveWorkshopPort();

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
