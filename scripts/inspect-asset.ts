// 命令行包装：读文件 → 交给纯模块检查 → 输出。只读，不联网，不写任何文件。
//
// 用法：npm run inspect-asset -- <文件路径> [--json]
// 退出码：0 检查完成；1 不是合法的 GLB；2 用法错误或读不了文件；3 检查工具内部错误。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatInspectReport, inspectGlb } from '../src/asset/inspect/index';

const EXIT_OK = 0;
const EXIT_INVALID_GLB = 1;
const EXIT_USAGE = 2;
const EXIT_INTERNAL = 3;

const USAGE = `用法：npm run inspect-asset -- <文件路径> [--json]

  <文件路径>  要检查的 .glb 文件（相对路径按运行命令时的目录解析）
  --json      输出 JSON 报告（默认输出文本）

退出码：0 检查完成；1 不是合法的 GLB；2 用法错误或读不了文件；3 内部错误`;

async function main(args: readonly string[]): Promise<number> {
  let json = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`未知选项：${arg}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    } else paths.push(arg);
  }
  const [path] = paths;
  if (path === undefined || paths.length !== 1) {
    process.stderr.write(`${paths.length === 0 ? '缺少文件路径' : '只能检查一个文件'}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  // npm run 会把工作目录切到项目根目录；INIT_CWD 是用户运行命令时所在的目录。
  const absolute = resolve(process.env.INIT_CWD ?? process.cwd(), path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    const reason = code === 'ENOENT' ? '文件不存在' : code === 'EISDIR' ? '这是一个目录' : code === 'EACCES' ? '没有读取权限' : code;
    process.stderr.write(`读不了文件：${path}（${reason}）\n`);
    return EXIT_USAGE;
  }

  const result = inspectGlb(bytes);
  if (!result.ok) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, file: path, error: result.error }, null, 2)}\n`);
    process.stderr.write(`不是合法的 GLB：${path}\n原因：${result.error.message}\n`);
    return EXIT_INVALID_GLB;
  }
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, file: path, report: result.report }, null, 2)}\n`);
  else process.stdout.write(formatInspectReport(result.report, { label: path }));
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`检查工具内部错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = EXIT_INTERNAL;
  },
);
