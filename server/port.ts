// 工坊服务的端口（P8）：服务和 Vite 的代理都从这里取，保证两边一致。
// 规则和服务启动时的 node --env-file-if-exists=.env 一样：进程的环境变量优先，其次是项目根目录的 .env。
// （Vite 执行配置时不会把 .env 里的 MW_ 变量放进 process.env，所以这里自己读同一份 .env。）

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const DEFAULT_PORT = 8790;

/** 端口的原始值：环境变量里有就用它，否则读 envFile（默认 .env；文件不存在时当作没有）。 */
export function workshopPortValue(env: Readonly<Record<string, string | undefined>> = process.env, envFile = '.env'): string | undefined {
  const fromEnv = env.MW_WORKSHOP_PORT;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    return parseEnv(readFileSync(envFile, 'utf8')).MW_WORKSHOP_PORT?.trim();
  } catch {
    return undefined;
  }
}

/** 代理用的端口：值不合法时用默认端口（服务那边会因为配置不对而拒绝启动，并说明原因）。 */
export function resolveWorkshopPort(env: Readonly<Record<string, string | undefined>> = process.env, envFile = '.env'): number {
  const value = workshopPortValue(env, envFile);
  const port = Number(value ?? DEFAULT_PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}
