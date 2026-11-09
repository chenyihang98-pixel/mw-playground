import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    // three.js 本身压缩后约 530 kB，超过默认的 500 kB 提示阈值；这里放宽，避免每次构建都报同一条提示。
    chunkSizeWarningLimit: 1000,
  },
});
