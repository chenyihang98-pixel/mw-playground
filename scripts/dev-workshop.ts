// npm run dev:workshop（P8）：同时起 Vite 开发服务器和关卡工坊的本机服务；任一个退出或按 Ctrl+C 时两个一起停。
// 原来的 npm run dev 只起 Vite（工坊按“服务不可用”显示，游戏照常）。

import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [
  // 工坊服务：读项目根目录下的 .env（如果有，不进仓库）
  spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'server/main.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 500).unref();
};

for (const child of children) {
  child.on('exit', (code) => {
    stop(code ?? 0);
  });
}
process.on('SIGINT', () => {
  stop(0);
});
process.on('SIGTERM', () => {
  stop(0);
});
