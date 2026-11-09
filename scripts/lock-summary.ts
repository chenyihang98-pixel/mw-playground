// 锁文件摘要：npm run lock-summary -- <起点引用> <终点引用>
// 只读：用 git 读两个提交里的 package-lock.json（起点没有就当作空），结果只写到标准输出。
// 退出码：0 完成；2 用法错误、引用无效或锁文件无法解析。

import { execFileSync } from 'node:child_process';
import { LockfileError, formatLockSummary, parseLockfile, type LockSide } from './lib/lockSummary';

class UsageError extends Error {}

const LOCKFILE = 'package-lock.json';

const USAGE = '用法：npm run lock-summary -- <起点引用> <终点引用>（例如 f178799 HEAD）';

function git(args: readonly string[]): { ok: true; stdout: string } | { ok: false } {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

function readSide(ref: string): LockSide {
  if (!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) {
    throw new UsageError(`无法解析引用：${ref}`);
  }
  const blob = git(['rev-parse', '--verify', '--quiet', `${ref}:${LOCKFILE}`]);
  if (!blob.ok) return { ref, blob: null, lock: parseLockfile(null) };
  const blobId = blob.stdout.trim();
  const text = git(['show', '--no-textconv', `${ref}:${LOCKFILE}`]);
  if (!text.ok) throw new UsageError(`读不了 ${ref}:${LOCKFILE}`);
  try {
    return { ref, blob: blobId, lock: parseLockfile(text.stdout) };
  } catch (error) {
    if (error instanceof LockfileError) throw new UsageError(`${ref}:${LOCKFILE}：${error.message}`);
    throw error;
  }
}

function main(args: readonly string[]): number {
  const [from, to] = args;
  if (args.length !== 2 || from === undefined || to === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!git(['rev-parse', '--git-dir']).ok) {
    process.stderr.write('当前目录不在 git 仓库里\n');
    return 2;
  }
  try {
    process.stdout.write(formatLockSummary(readSide(from), readSide(to)));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
