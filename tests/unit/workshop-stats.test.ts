// 关卡工坊的统计（P8）：六类计数正确；每个请求只计一次；回退不算模型成功；写进 JSONL 文件；汇总命令只读。
// 临时文件放在系统临时目录，由测试删除。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { produceLevel } from '../../src/game/level/gen/pipeline';
import { deriveSeed } from '../../src/game/level/gen/random';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { OUTCOMES } from '../../src/workshop/protocol';
import { loadConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider, type FakeScript } from '../../server/fakeProvider';
import { createLogger } from '../../server/log';
import { JsonlStats, MemoryStats, formatSummary, summarize, summarizeFile, type StatsSink } from '../../server/stats';
import { Workshop } from '../../server/workshop';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workshop(script: FakeScript, stats: StatsSink, seed = 'seed-1', env: Record<string, string> = {}): Workshop {
  const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', MW_WORKSHOP_CALL_TIMEOUT_MS: '200', ...env });
  if (!loaded.ok) throw new Error('配置不对');
  return new Workshop({ config: loaded.config, provider: new FakeProvider(script), stats, log: createLogger(new Redactor([]), () => undefined), newSeed: () => seed });
}

const valid = randomBrief('stats-valid');
const bad = { ...valid, distribution: 'elevated', platforms: 0 };

describe('六类计数', () => {
  it('六类各一条：模型首次通过、修复后通过、程序调整后通过、回退、取消、服务错误或超时；每个请求只计一次', async () => {
    const stats = new MemoryStats();
    let n = 0;
    const req = () => ({ generationId: `stats-${String(++n).padStart(4, '0')}`, text: '雨夜', roster: [] });

    await workshop({ briefs: [{ kind: 'json', value: valid }] }, stats).generate(req());
    await workshop({ briefs: [{ kind: 'json', value: bad }, { kind: 'json', value: valid }] }, stats).generate(req());
    const crowded = { ...valid, tier: 'small', density: 'high', collectibles: GEN_CONFIG.tiers.small.collectibles.max, platforms: 2, guards: 1, distribution: 'scattered', cast: [] };
    const seed = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].find((s) => {
      const r = produceLevel(crowded, deriveSeed(s, 'brief-1'));
      return r.ok && r.level.adjustment !== null;
    });
    await workshop({ briefs: [{ kind: 'json', value: crowded }] }, stats, seed).generate(req());
    await workshop({ briefs: [{ kind: 'json', value: bad }, { kind: 'json', value: bad }, { kind: 'json', value: bad }] }, stats).generate(req());
    const cancelling = workshop({ briefs: [{ kind: 'hang' }] }, stats, 'seed-1', { MW_WORKSHOP_CALL_TIMEOUT_MS: '5000' });
    const cancelReq = req();
    const pending = cancelling.generate(cancelReq);
    await expect.poll(() => cancelling.busy).toBe(true);
    cancelling.cancel(cancelReq.generationId);
    await pending;
    await workshop({ briefs: [{ kind: 'hang' }] }, stats).generate(req());

    expect(stats.records.map((r) => r.outcome)).toEqual(['model-first', 'model-repaired', 'program-adjusted', 'fallback', 'cancelled', 'error']);
    const summary = summarize(stats.records.map((r) => JSON.stringify(r)));
    expect(summary.total).toBe(6);
    expect(summary.counts).toEqual(Object.fromEntries(OUTCOMES.map((o) => [o, 1])));
    // 回退不算模型成功
    const fallback = stats.records[3];
    expect(fallback?.outcome).toBe('fallback');
    expect(fallback?.reason).toContain('3 次');
    // 结果和原因分开存；记了提供方、模型名、修复次数、各阶段耗时；不记原文和人物
    for (const r of stats.records) {
      expect(r).toMatchObject({ provider: 'fake', model: 'fake-scripted', textChars: 2, rosterSize: 0 });
      expect(r.timingsMs.total).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(r)).not.toContain('雨夜');
    }
    expect(stats.records[1]?.repairs).toBe(1);
    expect(stats.records[0]?.timingsMs).toHaveProperty('produce');
  });

  it('汇总时同一个生成标识只算一次；认不出的行单独计数', () => {
    const line = (id: string, outcome: string) =>
      JSON.stringify({ id, at: '2026-01-01T00:00:00Z', outcome, reason: null, provider: 'fake', model: 'm', repairs: 0, briefAttempts: 1, modelCalls: 2, timingsMs: { total: 1 }, textChars: 1, rosterSize: 0 });
    const summary = summarize([line('a', 'model-first'), line('a', 'model-first'), line('b', 'fallback'), 'not json', '{"id":"c"}', '']);
    expect(summary.total).toBe(2);
    expect(summary.counts['model-first']).toBe(1);
    expect(summary.counts.fallback).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.invalid).toBe(2);
    expect(formatSummary(summary)).toContain('模型首次通过：1');
    expect(formatSummary(summary)).toContain('回退内置关卡：1');
  });
});

describe('文件', () => {
  it('写进 JSONL（每个请求一行）；汇总命令只读、按六类输出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-playground-stats-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'workshop-stats.jsonl');
    const stats = new JsonlStats(path);
    await workshop({}, stats).generate({ generationId: 'file-0000001', text: '雨夜', roster: [] });
    await workshop({}, stats).generate({ generationId: 'file-0000002', text: '雪夜', roster: [] });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((await summarizeFile(path)).counts['model-first']).toBe(2);
    expect((await summarizeFile(join(dir, 'missing.jsonl'))).total).toBe(0);
    const before = statSync(path).mtimeMs;
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/workshop-stats.ts', path], { encoding: 'utf8' });
    expect(output).toContain('请求总数：2');
    for (const label of ['模型首次通过：2', '模型修复后通过：0', '程序调整后通过：0', '回退内置关卡：0', '用户取消：0', '服务错误或超时：0']) expect(output).toContain(label);
    expect(statSync(path).mtimeMs).toBe(before);
  });
});
