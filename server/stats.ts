// 工坊的统计（P8）：每个生成请求只记一条，写进 JSONL 文件（默认 .local/workshop-stats.jsonl，不进仓库）。
// 最终结果（六类）和原因分开存；另记提供方、模型名、修复次数、各阶段耗时。不记密钥，也不记玩家的人物文件
// （名册快照只记人数；玩家的一句话只记长度）。回退成功不算模型成功：回退记为 fallback（或 error）。

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { OUTCOMES, OUTCOME_LABELS, PROVIDER_NAMES, type Outcome } from '../src/workshop/protocol';

export const statsRecordSchema = z.strictObject({
  /** 生成标识。 */
  id: z.string(),
  /** 结束时间（ISO 8601）。 */
  at: z.string(),
  outcome: z.enum(OUTCOMES),
  /** 原因（成功时为 null）。 */
  reason: z.string().nullable(),
  provider: z.enum(PROVIDER_NAMES),
  model: z.string().nullable(),
  /** 模型修复了几次（写说明书的次数 − 1，没写过时为 0）。 */
  repairs: z.number().int().min(0),
  /** 模型写说明书的次数。 */
  briefAttempts: z.number().int().min(0),
  /** 这次生成调用模型的总次数（含理解请求）。 */
  modelCalls: z.number().int().min(0),
  /** 各阶段耗时（毫秒）：understand、brief、validate、produce、total。 */
  timingsMs: z.record(z.string(), z.number().nonnegative()),
  /** 玩家的一句话有多少个字符（不记原文）。 */
  textChars: z.number().int().min(0),
  /** 名册快照里有几个人物（不记人物信息）。 */
  rosterSize: z.number().int().min(0),
});
export type StatsRecord = z.output<typeof statsRecordSchema>;

export interface StatsSink {
  record(record: StatsRecord): Promise<void>;
}

/** 写进 JSONL 文件。写失败只记日志，不影响生成。 */
export class JsonlStats implements StatsSink {
  constructor(private readonly path: string) {}

  async record(record: StatsRecord): Promise<void> {
    const line = JSON.stringify(statsRecordSchema.parse(record));
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${line}\n`, 'utf8');
  }
}

/** 内存里的统计（测试用）。 */
export class MemoryStats implements StatsSink {
  readonly records: StatsRecord[] = [];

  record(record: StatsRecord): Promise<void> {
    this.records.push(statsRecordSchema.parse(record));
    return Promise.resolve();
  }
}

export interface StatsSummary {
  readonly total: number;
  readonly counts: Readonly<Record<Outcome, number>>;
  /** 认不出的行（不是合法的 JSON 或字段不对）。 */
  readonly invalid: number;
  /** 同一个生成标识出现了不止一次的行数（正常应为 0）。 */
  readonly duplicates: number;
}

export function summarize(lines: readonly string[]): StatsSummary {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  let invalid = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: StatsRecord;
    try {
      parsed = statsRecordSchema.parse(JSON.parse(line));
    } catch {
      invalid++;
      continue;
    }
    if (seen.has(parsed.id)) {
      duplicates++;
      continue;
    }
    seen.add(parsed.id);
    counts[parsed.outcome]++;
  }
  return { total: seen.size, counts, invalid, duplicates };
}

export async function summarizeFile(path: string): Promise<StatsSummary> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  return summarize(text.split(/\r?\n/));
}

export function formatSummary(summary: StatsSummary): string {
  const lines = [`请求总数：${String(summary.total)}`];
  for (const outcome of OUTCOMES) lines.push(`${OUTCOME_LABELS[outcome]}：${String(summary.counts[outcome])}`);
  if (summary.invalid > 0) lines.push(`认不出的行：${String(summary.invalid)}`);
  if (summary.duplicates > 0) lines.push(`重复的生成标识：${String(summary.duplicates)}`);
  return lines.join('\n');
}
