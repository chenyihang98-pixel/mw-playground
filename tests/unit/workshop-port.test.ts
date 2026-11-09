// 工坊服务的端口（P8，第 1 轮审查）：Vite 的代理和服务用同一个规则取端口——进程的环境变量优先，
// 其次项目根目录的 .env（和服务启动时 node --env-file-if-exists=.env 的规则一样）。临时文件放在系统临时目录，由测试删除。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config';
import { loadConfig } from '../../server/config';
import { DEFAULT_PORT, resolveWorkshopPort } from '../../server/port';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function envFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mw-playground-port-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, text);
  return path;
}

/** 服务启动时 node --env-file-if-exists 读到的 MW_WORKSHOP_PORT。 */
function nodeSees(path: string, env: Record<string, string>): string {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'MW_WORKSHOP_PORT')) as Record<string, string>;
  return execFileSync(process.execPath, [`--env-file-if-exists=${path}`, '-e', 'process.stdout.write(process.env.MW_WORKSHOP_PORT ?? "")'], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
}

describe('端口', () => {
  it('.env 里设了 MW_WORKSHOP_PORT：代理和服务都用它', () => {
    const path = envFile('MW_LLM_PROVIDER=off\nMW_WORKSHOP_PORT=9001\n');
    expect(resolveWorkshopPort({}, path)).toBe(9001);
    // 服务那边：node --env-file-if-exists 读同一个文件，loadConfig 得到同一个端口
    const seen = nodeSees(path, {});
    expect(seen).toBe('9001');
    const loaded = loadConfig({ MW_WORKSHOP_PORT: seen });
    expect(loaded.ok && loaded.config.port).toBe(9001);
  });

  it('环境变量优先于 .env（和 node --env-file 的规则一样）', () => {
    const path = envFile('MW_WORKSHOP_PORT=9001\n');
    expect(resolveWorkshopPort({ MW_WORKSHOP_PORT: '9100' }, path)).toBe(9100);
    expect(nodeSees(path, { MW_WORKSHOP_PORT: '9100' })).toBe('9100');
  });

  it('没有 .env、值不合法时用默认端口；Vite 的代理指向同一个端口', () => {
    expect(resolveWorkshopPort({}, join(tmpdir(), 'mw-playground-no-such-dir', '.env'))).toBe(DEFAULT_PORT);
    expect(resolveWorkshopPort({ MW_WORKSHOP_PORT: 'abc' }, join(tmpdir(), 'none.env'))).toBe(DEFAULT_PORT);
    const loaded = loadConfig({});
    expect(loaded.ok && loaded.config.port).toBe(DEFAULT_PORT);
    const proxy = (viteConfig as { server?: { proxy?: Record<string, { target?: string }> } }).server?.proxy?.['/api'];
    expect(proxy?.target).toBe(`http://127.0.0.1:${String(resolveWorkshopPort())}`);
  });
});
