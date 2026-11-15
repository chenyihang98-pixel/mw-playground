// 关卡工坊的本机模型验收（P8）：用本机 Ollama 跑一组固定的 10 条请求（tests/data/workshop-requests.json），
// 按六类最终结果统计，并记下每条的耗时和加载模型用的时间（F2，看得出冷加载）。出预览的请求接着确认一次（定稿）。
// 默认跳过：要设 MW_WORKSHOP_ACCEPTANCE=1 才会运行。只连 127.0.0.1 上的 Ollama，不连任何外部服务。
//
// 用法：MW_WORKSHOP_ACCEPTANCE=1 npm run workshop-acceptance
//      （可以用 MW_OLLAMA_MODEL、MW_OLLAMA_NUM_CTX、MW_WORKSHOP_CALL_TIMEOUT_MS 等改配置）

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OUTCOMES, OUTCOME_LABELS, rosterPersonSchema, type Outcome } from '../src/workshop/protocol';
import { loadConfig } from '../server/config';
import { Redactor } from '../server/errors';
import { createLogger } from '../server/log';
import { OllamaProvider } from '../server/providers';
import { MemoryStats } from '../server/stats';
import { Workshop } from '../server/workshop';

const dataSchema = z.object({
  roster: z.array(rosterPersonSchema),
  requests: z.array(z.object({ text: z.string(), people: z.array(z.string()) })).length(10),
});

if (process.env.MW_WORKSHOP_ACCEPTANCE !== '1') {
  console.log('跳过：本机模型验收默认不运行（设 MW_WORKSHOP_ACCEPTANCE=1 后运行，只连 127.0.0.1 上的 Ollama）');
  process.exit(0);
}

const loaded = loadConfig({ ...process.env, MW_LLM_PROVIDER: 'ollama' });
if (!loaded.ok) {
  console.error(loaded.problems.join('\n'));
  process.exit(1);
}
const config = loaded.config;
const host = new URL(config.ollama.baseUrl).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error(`验收只连本机的 Ollama：MW_OLLAMA_BASE_URL 的主机是 ${host}`);
  process.exit(1);
}

const data = dataSchema.parse(JSON.parse(readFileSync('tests/data/workshop-requests.json', 'utf8')));
const provider = new OllamaProvider(config.ollama);
const stats = new MemoryStats();
const workshop = new Workshop({ config, provider, stats, log: createLogger(new Redactor([]), () => undefined) });

const health = await workshop.health();
if (!health.available) {
  console.error(`模型不可用：${health.reason ?? ''}`);
  process.exit(1);
}

interface Row {
  readonly n: number;
  readonly text: string;
  readonly outcome: Outcome;
  readonly reason: string | null;
  readonly repairs: number;
  readonly modelCalls: number;
  readonly totalMs: number;
  /** 加载模型用了多少毫秒（F2；加载开始前就结束时为 null）。 */
  readonly prepareMs: number | null;
  readonly confirmMs: number | null;
  readonly title: string | null;
  readonly hashMatches: boolean | null;
  /** 修复前各次的问题；回退时是回退的原因。 */
  readonly history: readonly string[];
}

const rows: Row[] = [];
for (const [i, req] of data.requests.entries()) {
  const roster = data.roster.filter((p) => req.people.includes(p.name));
  const generationId = `acceptance-${String(Date.now())}-${String(i + 1)}`;
  const start = performance.now();
  const res = await workshop.generate({ generationId, text: req.text, roster });
  const totalMs = Math.round(performance.now() - start);
  let confirmMs: number | null = null;
  let title: string | null = null;
  let hashMatches: boolean | null = null;
  const history = res.status === 'preview' ? res.preview.history : res.status === 'fallback' ? [res.fallback.reason, ...res.fallback.history] : [];
  if (res.status === 'preview') {
    const t = performance.now();
    const final = await workshop.confirm({ generationId, version: res.version, serviceId: res.serviceId });
    confirmMs = Math.round(performance.now() - t);
    title = final.level.title;
    hashMatches = final.level.layoutHash === res.preview.level.layoutHash;
  }
  const record = stats.records.find((r) => r.id === generationId);
  rows.push({
    n: i + 1,
    text: req.text,
    outcome: record?.outcome ?? 'error',
    reason: record?.reason ?? null,
    repairs: record?.repairs ?? 0,
    modelCalls: record?.modelCalls ?? 0,
    totalMs,
    prepareMs: record?.timingsMs.prepare ?? null,
    confirmMs,
    title,
    hashMatches,
    history,
  });
  const row = rows.at(-1);
  const prepare = row?.prepareMs ?? null;
  console.log(
    `${String(i + 1)}. ${OUTCOME_LABELS[row?.outcome ?? 'error']}，修复 ${String(row?.repairs ?? 0)} 次，` +
      `加载模型 ${prepare === null ? '—' : `${String(prepare)} ms`}，耗时 ${String(totalMs)} ms：${req.text}`,
  );
}

const counts = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]));
console.log(JSON.stringify({ model: config.ollama.model, numCtx: config.ollama.numCtx, counts, rows, records: stats.records }, null, 2));
