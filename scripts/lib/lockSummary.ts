// 锁文件摘要的纯逻辑：解析两份 package-lock.json（v2/v3 的 packages 字段），比较，排版成 Markdown。
// 不读文件、不跑 git；读取由 scripts/lock-summary.ts 负责。

import { z } from 'zod';

const entrySchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  link: z.boolean().optional(),
  dev: z.boolean().optional(),
  optional: z.boolean().optional(),
  devOptional: z.boolean().optional(),
  peer: z.boolean().optional(),
  inBundle: z.boolean().optional(),
  hasInstallScript: z.boolean().optional(),
});

const lockSchema = z.looseObject({
  lockfileVersion: z.number().int(),
  packages: z.record(z.string(), entrySchema).optional(),
});

export interface LockPackage {
  /** packages 里的键，例如 node_modules/@types/three。 */
  readonly path: string;
  readonly name: string;
  readonly version: string | null;
  readonly resolved: string | null;
  readonly integrity: string | null;
  readonly hasInstallScript: boolean;
  readonly flags: readonly string[];
}

export interface ParsedLock {
  readonly lockfileVersion: number | null;
  readonly packages: ReadonlyMap<string, LockPackage>;
}

export const EMPTY_LOCK: ParsedLock = { lockfileVersion: null, packages: new Map() };

export class LockfileError extends Error {}

function nameFromPath(path: string): string {
  const marker = 'node_modules/';
  const i = path.lastIndexOf(marker);
  return i >= 0 ? path.slice(i + marker.length) : path;
}

/** 解析锁文件文本；null 表示该提交里没有锁文件，按空处理。 */
export function parseLockfile(text: string | null): ParsedLock {
  if (text === null) return EMPTY_LOCK;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new LockfileError(`package-lock.json 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = lockSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LockfileError(`package-lock.json 结构不对：${issue ? `${issue.path.join('.')}：${issue.message}` : '未知错误'}`);
  }
  if (!parsed.data.packages) {
    throw new LockfileError(`lockfileVersion ${parsed.data.lockfileVersion} 的锁文件没有 packages 字段；只支持 v2/v3 锁文件`);
  }
  const packages = new Map<string, LockPackage>();
  for (const [path, entry] of Object.entries(parsed.data.packages)) {
    if (path === '') continue; // 根项目自身
    const flags: string[] = [];
    if (entry.dev) flags.push('dev');
    if (entry.optional) flags.push('optional');
    if (entry.devOptional) flags.push('devOptional');
    if (entry.peer) flags.push('peer');
    if (entry.link) flags.push('link');
    if (entry.inBundle) flags.push('inBundle');
    packages.set(path, {
      path,
      name: entry.name ?? nameFromPath(path),
      version: entry.version ?? null,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      hasInstallScript: entry.hasInstallScript === true,
      flags,
    });
  }
  return { lockfileVersion: parsed.data.lockfileVersion, packages };
}

export interface VersionChange {
  readonly path: string;
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface SourceChange {
  readonly path: string;
  readonly name: string;
  readonly version: string | null;
  readonly fields: readonly ('resolved' | 'integrity')[];
}

export interface HostCount {
  readonly host: string;
  readonly before: number;
  readonly after: number;
}

export interface LockDiff {
  readonly added: readonly LockPackage[];
  readonly removed: readonly LockPackage[];
  readonly changed: readonly VersionChange[];
  /** 版本没变，但 resolved 或 integrity 变了。 */
  readonly sourceChanged: readonly SourceChange[];
  readonly hosts: readonly HostCount[];
  /** 终点锁文件里缺 integrity 的包（不含 link 条目）。 */
  readonly missingIntegrity: readonly LockPackage[];
  /** 终点锁文件里带 hasInstallScript 的包。 */
  readonly installScripts: readonly LockPackage[];
  readonly totalAfter: number;
}

/** resolved 的来源：URL 取 协议//主机；其他情况归类说明。 */
export function resolvedHost(pkg: LockPackage): string {
  if (pkg.resolved === null) return pkg.flags.includes('link') ? '（本地链接）' : '（无 resolved）';
  try {
    const url = new URL(pkg.resolved);
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.protocol}//${url.host}`;
    return `${url.protocol}（非 HTTP）`;
  } catch {
    return '（非 URL，例如本地路径）';
  }
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function diffLockfiles(before: ParsedLock, after: ParsedLock): LockDiff {
  const added: LockPackage[] = [];
  const removed: LockPackage[] = [];
  const changed: VersionChange[] = [];
  const sourceChanged: SourceChange[] = [];
  for (const [path, pkg] of after.packages) {
    const old = before.packages.get(path);
    if (!old) {
      added.push(pkg);
    } else if (old.version !== pkg.version) {
      changed.push({ path, name: pkg.name, from: old.version, to: pkg.version });
    } else {
      const fields: ('resolved' | 'integrity')[] = [];
      if (old.resolved !== pkg.resolved) fields.push('resolved');
      if (old.integrity !== pkg.integrity) fields.push('integrity');
      if (fields.length > 0) sourceChanged.push({ path, name: pkg.name, version: pkg.version, fields });
    }
  }
  for (const [path, pkg] of before.packages) if (!after.packages.has(path)) removed.push(pkg);

  const hostMap = new Map<string, { before: number; after: number }>();
  for (const pkg of before.packages.values()) {
    const entry = hostMap.get(resolvedHost(pkg)) ?? { before: 0, after: 0 };
    entry.before++;
    hostMap.set(resolvedHost(pkg), entry);
  }
  for (const pkg of after.packages.values()) {
    const entry = hostMap.get(resolvedHost(pkg)) ?? { before: 0, after: 0 };
    entry.after++;
    hostMap.set(resolvedHost(pkg), entry);
  }
  const hosts = [...hostMap.entries()]
    .map(([host, n]) => ({ host, ...n }))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));

  const afterList = [...after.packages.values()];
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    changed: changed.sort(byPath),
    sourceChanged: sourceChanged.sort(byPath),
    hosts,
    missingIntegrity: afterList.filter((p) => p.integrity === null && !p.flags.includes('link')).sort(byPath),
    installScripts: afterList.filter((p) => p.hasInstallScript).sort(byPath),
    totalAfter: after.packages.size,
  };
}

export interface LockSide {
  /** 命令行上给的引用，原样显示。 */
  readonly ref: string;
  /** package-lock.json 在该提交里的 blob id；没有锁文件时为 null。 */
  readonly blob: string | null;
  readonly lock: ParsedLock;
}

function cell(text: string | null): string {
  return text === null ? '—' : text.replace(/\|/g, '\\|');
}

function code(text: string): string {
  return `\`${text}\``;
}

function flagsCell(pkg: LockPackage): string {
  return pkg.flags.length > 0 ? pkg.flags.join(', ') : '—';
}

function section(title: string, count: number, header: string, rows: readonly string[]): string[] {
  const out = [`## ${title}（${count}）`, ''];
  if (rows.length === 0) out.push('（无）');
  else out.push(header, ...rows);
  out.push('');
  return out;
}

function sideLine(label: string, side: LockSide): string {
  if (side.blob === null) return `| ${label} | ${code(side.ref)} | 不存在，按空锁文件处理 |`;
  return `| ${label} | ${code(side.ref)} | blob ${code(side.blob)}，lockfileVersion ${String(side.lock.lockfileVersion)}，${side.lock.packages.size} 个包条目 |`;
}

export function formatLockSummary(from: LockSide, to: LockSide): string {
  const diff = diffLockfiles(from.lock, to.lock);
  const out: string[] = [];
  out.push(`# 锁文件摘要：${from.ref} → ${to.ref}`);
  out.push('');
  out.push(`生成命令：${code(`npm run lock-summary -- ${from.ref} ${to.ref}`)}`);
  out.push('');
  out.push(
    `写入文件时加 ${code('-s')} 去掉 npm 自己的命令回显：${code(`npm run -s lock-summary -- ${from.ref} ${to.ref} > <文件>`)}。` +
      '脚本只用 git 读取两个提交里的 package-lock.json，不读工作区，不写文件。',
  );
  out.push('');
  out.push('| | 引用 | package-lock.json |');
  out.push('|---|---|---|');
  out.push(sideLine('起点', from));
  out.push(sideLine('终点', to));
  out.push('');
  out.push('## 概览');
  out.push('');
  out.push(`- 新增：${diff.added.length}`);
  out.push(`- 删除：${diff.removed.length}`);
  out.push(`- 版本有变化：${diff.changed.length}`);
  out.push(`- 版本没变但 resolved 或 integrity 有变化：${diff.sourceChanged.length}`);
  out.push(`- 终点缺 integrity：${diff.missingIntegrity.length}`);
  out.push(`- 终点带 hasInstallScript：${diff.installScripts.length}`);
  out.push(`- 终点包条目总数：${diff.totalAfter}`);
  out.push('');

  const pkgHeader = '| 名称 | 安装路径 | 旧版本 | 新版本 | 标记 |\n|---|---|---|---|---|';
  out.push(
    ...section(
      '新增的包',
      diff.added.length,
      pkgHeader,
      diff.added.map((p) => `| ${cell(p.name)} | ${cell(p.path)} | — | ${cell(p.version)} | ${flagsCell(p)} |`),
    ),
  );
  out.push(
    ...section(
      '删除的包',
      diff.removed.length,
      pkgHeader,
      diff.removed.map((p) => `| ${cell(p.name)} | ${cell(p.path)} | ${cell(p.version)} | — | ${flagsCell(p)} |`),
    ),
  );
  out.push(
    ...section(
      '版本有变化的包',
      diff.changed.length,
      '| 名称 | 安装路径 | 旧版本 | 新版本 |\n|---|---|---|---|',
      diff.changed.map((c) => `| ${cell(c.name)} | ${cell(c.path)} | ${cell(c.from)} | ${cell(c.to)} |`),
    ),
  );
  out.push(
    ...section(
      '版本没变但 resolved 或 integrity 有变化的包',
      diff.sourceChanged.length,
      '| 名称 | 安装路径 | 版本 | 变化的字段 |\n|---|---|---|---|',
      diff.sourceChanged.map((c) => `| ${cell(c.name)} | ${cell(c.path)} | ${cell(c.version)} | ${c.fields.join(', ')} |`),
    ),
  );
  out.push(
    ...section(
      'resolved 来源主机汇总',
      diff.hosts.length,
      '| 来源 | 起点包数 | 终点包数 |\n|---|---|---|',
      diff.hosts.map((h) => `| ${cell(h.host)} | ${h.before} | ${h.after} |`),
    ),
  );
  out.push(
    ...section(
      '终点缺 integrity 的包（不含 link 条目）',
      diff.missingIntegrity.length,
      '| 名称 | 安装路径 | 版本 | resolved | 标记 |\n|---|---|---|---|---|',
      diff.missingIntegrity.map(
        (p) => `| ${cell(p.name)} | ${cell(p.path)} | ${cell(p.version)} | ${cell(p.resolved)} | ${flagsCell(p)} |`,
      ),
    ),
  );
  out.push(
    ...section(
      '终点带 hasInstallScript 的包',
      diff.installScripts.length,
      '| 名称 | 安装路径 | 版本 | 标记 |\n|---|---|---|---|',
      diff.installScripts.map((p) => `| ${cell(p.name)} | ${cell(p.path)} | ${cell(p.version)} | ${flagsCell(p)} |`),
    ),
  );
  return out.join('\n').replace(/\n+$/, '\n');
}
