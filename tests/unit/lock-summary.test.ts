// lock-summary：在系统临时目录下建临时 git 仓库，构造几份锁文件，核对摘要。临时仓库由本文件清理。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffLockfiles, parseLockfile, resolvedHost } from '../../scripts/lib/lockSummary';
import { PROJECT_ROOT, makeTempDir, runScript } from '../helpers/node';

const SCRIPT = 'scripts/lock-summary.ts';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'mw-playground test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'mw-playground test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function entry(name: string, version: string, extra: Record<string, unknown> = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop() ?? name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
    ...extra,
  };
}

function lockfile(packages: Record<string, unknown>): string {
  return `${JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'demo' }, ...packages } }, null, 2)}\n`;
}

const LOCK_A = lockfile({
  'node_modules/alpha': entry('alpha', '1.0.0'),
  'node_modules/beta': entry('beta', '2.0.0', { dev: true }),
  'node_modules/gamma': entry('gamma', '3.0.0'),
});

const LOCK_B = lockfile({
  'node_modules/alpha': entry('alpha', '1.1.0'), // 升级
  // beta 删除
  'node_modules/gamma': { ...entry('gamma', '3.0.0'), integrity: 'sha512-gamma-repacked' }, // 版本不变，integrity 变了
  'node_modules/delta': { version: '0.1.0', resolved: 'https://mirror.example.com/delta-0.1.0.tgz' }, // 缺 integrity
  'node_modules/epsilon': entry('epsilon', '5.0.0', { hasInstallScript: true, dev: true }),
  'node_modules/gamma/node_modules/@scope/zeta': entry('@scope/zeta', '6.0.0'), // 嵌套、带作用域
  'packages/local': { name: 'local-pkg', version: '0.0.1' },
  'node_modules/local-pkg': { resolved: 'packages/local', link: true }, // link 条目不算缺 integrity
});

let repo: ReturnType<typeof makeTempDir>;
const commits: Record<'empty' | 'a' | 'b', string> = { empty: '', a: '', b: '' };

function git(args: readonly string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function commit(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function summary(from: string, to: string) {
  return runScript(SCRIPT, [from, to], { cwd: repo.dir });
}

/** 取出某个二级标题下的内容。 */
function sectionOf(markdown: string, titlePrefix: string): string {
  const start = markdown.indexOf(`## ${titlePrefix}`);
  if (start < 0) throw new Error(`没有章节：${titlePrefix}`);
  const next = markdown.indexOf('\n## ', start + 3);
  return markdown.slice(start, next < 0 ? undefined : next);
}

beforeAll(() => {
  repo = makeTempDir('lock-summary');
  git(['init', '-q']);
  writeFileSync(join(repo.dir, 'README.md'), '# demo\n');
  commits.empty = commit('没有锁文件');
  writeFileSync(join(repo.dir, 'package-lock.json'), LOCK_A);
  commits.a = commit('锁文件 A');
  writeFileSync(join(repo.dir, 'package-lock.json'), LOCK_B);
  commits.b = commit('锁文件 B');
});

afterAll(() => {
  repo.cleanup();
});

describe('纯逻辑', () => {
  it('新增、删除、升级、来源变化、缺 integrity、hasInstallScript', () => {
    const diff = diffLockfiles(parseLockfile(LOCK_A), parseLockfile(LOCK_B));
    expect(diff.added.map((p) => p.path)).toEqual([
      'node_modules/delta',
      'node_modules/epsilon',
      'node_modules/gamma/node_modules/@scope/zeta',
      'node_modules/local-pkg',
      'packages/local',
    ]);
    expect(diff.added.find((p) => p.path.endsWith('zeta'))?.name).toBe('@scope/zeta');
    expect(diff.removed.map((p) => [p.name, p.version])).toEqual([['beta', '2.0.0']]);
    expect(diff.changed).toEqual([{ path: 'node_modules/alpha', name: 'alpha', from: '1.0.0', to: '1.1.0' }]);
    expect(diff.sourceChanged).toEqual([{ path: 'node_modules/gamma', name: 'gamma', version: '3.0.0', fields: ['integrity'] }]);
    expect(diff.missingIntegrity.map((p) => p.path)).toEqual(['node_modules/delta', 'packages/local']);
    expect(diff.installScripts.map((p) => p.name)).toEqual(['epsilon']);
    expect(diff.hosts).toEqual([
      { host: 'https://mirror.example.com', before: 0, after: 1 },
      { host: 'https://registry.npmjs.org', before: 3, after: 4 },
      { host: '（无 resolved）', before: 0, after: 1 },
      { host: '（非 URL，例如本地路径）', before: 0, after: 1 },
    ]);
  });

  it('起点没有锁文件：全部列为新增', () => {
    const diff = diffLockfiles(parseLockfile(null), parseLockfile(LOCK_A));
    expect(diff.added.map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('resolved 来源分类', () => {
    const pkg = parseLockfile(LOCK_B).packages;
    expect(resolvedHost(pkg.get('node_modules/delta') ?? fail())).toBe('https://mirror.example.com');
    expect(resolvedHost(pkg.get('node_modules/local-pkg') ?? fail())).toBe('（非 URL，例如本地路径）');
  });

  it('v1 锁文件（没有 packages）明确报错', () => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow('只支持 v2/v3');
  });
});

function fail(): never {
  throw new Error('缺少条目');
}

describe('命令行（临时 git 仓库）', () => {
  it('起点没有锁文件：全部列为新增，并写明生成命令', () => {
    const r = summary(commits.empty, commits.a);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith(`# 锁文件摘要：${commits.empty} → ${commits.a}\n`)).toBe(true);
    expect(r.stdout).toContain(`生成命令：\`npm run lock-summary -- ${commits.empty} ${commits.a}\``);
    expect(r.stdout).toContain('| 起点 | `' + commits.empty + '` | 不存在，按空锁文件处理 |');
    const added = sectionOf(r.stdout, '新增的包');
    expect(added).toContain('## 新增的包（3）');
    expect(added).toContain('| alpha | node_modules/alpha | — | 1.0.0 | — |');
    expect(added).toContain('| beta | node_modules/beta | — | 2.0.0 | dev |');
    expect(sectionOf(r.stdout, '删除的包')).toContain('（无）');
  });

  it('两份锁文件之间：新增、删除、升级、缺 integrity、hasInstallScript 都列出', () => {
    const r = summary(commits.a, commits.b);
    expect(r.status).toBe(0);
    expect(sectionOf(r.stdout, '新增的包')).toContain('| @scope/zeta | node_modules/gamma/node_modules/@scope/zeta | — | 6.0.0 | — |');
    expect(sectionOf(r.stdout, '删除的包')).toContain('| beta | node_modules/beta | 2.0.0 | — | dev |');
    expect(sectionOf(r.stdout, '版本有变化的包')).toContain('| alpha | node_modules/alpha | 1.0.0 | 1.1.0 |');
    expect(sectionOf(r.stdout, '版本没变但')).toContain('| gamma | node_modules/gamma | 3.0.0 | integrity |');
    expect(sectionOf(r.stdout, 'resolved 来源主机汇总')).toContain('| https://mirror.example.com | 0 | 1 |');
    const missing = sectionOf(r.stdout, '终点缺 integrity');
    expect(missing).toContain('| delta | node_modules/delta | 0.1.0 | https://mirror.example.com/delta-0.1.0.tgz | — |');
    expect(missing).not.toContain('local-pkg | node_modules/local-pkg');
    expect(sectionOf(r.stdout, '终点带 hasInstallScript')).toContain('| epsilon | node_modules/epsilon | 5.0.0 | dev |');
    const blob = git(['rev-parse', `${commits.b}:package-lock.json`]);
    expect(r.stdout).toContain(`blob \`${blob}\``);
  });

  it('只读：读的是提交里的锁文件，不是工作区；运行后仓库没有变化', () => {
    writeFileSync(join(repo.dir, 'package-lock.json'), lockfile({}));
    try {
      const r = summary(commits.a, commits.b);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('- 新增：5');
      expect(git(['status', '--porcelain'])).toBe('M package-lock.json');
    } finally {
      git(['checkout', '--', 'package-lock.json']);
    }
    expect(git(['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(repo.dir, 'package-lock.json'), 'utf8')).toBe(LOCK_B);
  });

  it('引用无效或参数个数不对：退出码 2', () => {
    const bad = summary('no-such-ref', commits.b);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('无法解析引用：no-such-ref');
    expect(runScript(SCRIPT, [commits.a], { cwd: repo.dir }).status).toBe(2);
  });

  it('package.json 的 lock-summary 指向被测的脚本', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['lock-summary']).toBe(`tsx ${SCRIPT}`);
  });
});
