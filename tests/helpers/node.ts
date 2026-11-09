// 测试用的 Node 辅助函数：在系统临时目录建目录、运行项目里的 TS 脚本。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 用 tsx 运行 scripts/ 下的脚本（与 npm run 用的是同一个入口文件）。 */
export function runScript(
  script: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): RunResult {
  const result = spawnSync(process.execPath, [TSX_CLI, join(PROJECT_ROOT, script), ...args], {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 在系统临时目录下建一个目录；返回路径和清理函数。只能由创建它的测试调用清理。 */
export function makeTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mw-playground-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
