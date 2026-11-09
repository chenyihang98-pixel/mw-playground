// 关卡工坊的小实验（P8 第 0 条）：用本机 Ollama 和 @langchain/ollama 确认
// 1. 思考模式能不能关（think: false）以及关和开的耗时；
// 2. 把 P5 说明书的 JSON Schema 作为结构化输出（format）传给 Ollama，连续 10 次里有几次能通过 zod 校验和组合规则；
// 3. 工具调用（查名册快照）能不能用；
// 4. 用 Playwright 打开游戏页面并保持渲染的同时，`ollama ps` 里模型在 CPU / GPU 上的比例、上下文长度，以及单次响应的时间。
// 结果写到标准输出（JSON），整理进 docs/workshop-notes.md。只连 127.0.0.1 上的 Ollama；不改 Ollama 的配置，不拉取模型。
//
// 用法：npx tsx scripts/workshop-probe.ts [--headed] [--runs 10]

import { execFileSync } from 'node:child_process';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOllama } from '@langchain/ollama';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { z } from 'zod';
import { briefSchema, parseBrief } from '../src/game/level/gen/brief';
import { produceLevel } from '../src/game/level/gen/pipeline';
import { OllamaProvider } from '../server/providers';
import { briefJsonSchema, briefSystemPrompt, briefUserPrompt, understandSystemPrompt } from '../server/prompts';
import { describeRoster, resolveAliases, rosterEntries } from '../server/roster';

const BASE_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3.5:9b-q4_K_M';
const NUM_CTX = 8192;
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const runsIndex = args.indexOf('--runs');
const RUNS = runsIndex >= 0 ? Number(args[runsIndex + 1] ?? '10') : 10;
const skipThink = args.includes('--skip-think');
const skipTools = args.includes('--skip-tools');

// 人物 ID 用 SHA-256 的样子（64 位十六进制），和名册里的真实 ID 一样长
const roster = [
  { id: '3f9a6c0e1b7d42a89e5c13f07b6d2a4e8c1f9b3a7d5e0c2b4a6f8e1d3c5b7a90', name: '小兵', roles: ['companion', 'guard'] as ('companion' | 'guard')[] },
  { id: 'c2e47b19d8a0f36e5b1c9d7a2f4e6b8c0d3a5f7e9b1c3d5a7f9e2b4c6d8a0f13', name: '星璇', roles: ['companion'] as ('companion' | 'guard')[] },
];
const entries = rosterEntries(roster);
const useAliases = !args.includes('--raw-ids');
const REQUEST = '想要一个下雨的夜晚，中等大小的地图，宝石都藏在高台上，两个守卫来回巡逻，让星璇跟着我。';

function ollamaPs(): string {
  try {
    return execFileSync('ollama', ['ps'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `ollama ps 失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - start) };
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { model: MODEL, numCtx: NUM_CTX, browser: headed ? 'headed' : 'headless' };

  // ---- 游戏页面：Vite 开发服务器 + Playwright 的 Chromium，持续渲染
  const vite = await createServer({ server: { port: 5199, strictPort: true, host: '127.0.0.1' }, mode: 'test', logLevel: 'error' });
  await vite.listen();
  const browser = await chromium.launch({ headless: !headed, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:5199/?level=gen-3');
  await page.waitForFunction(() => (window as unknown as { __MW_TEST__?: { kind: string } }).__MW_TEST__?.kind === 'game');
  out.webglRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  const frames = async () => page.evaluate(() => (window as unknown as { __MW_TEST__: { getState(): { render: { frames: number } } } }).__MW_TEST__.getState().render.frames);
  out.psBefore = ollamaPs();

  // ---- 1. 思考模式：关和开各问一次同一个短问题
  const ask = async (think: boolean) => {
    const model = new ChatOllama({ baseUrl: BASE_URL, model: MODEL, think, numCtx: NUM_CTX, temperature: 0.3, numPredict: 2000, checkOrPullModel: false, maxRetries: 0 });
    const { value, ms } = await timed(() => model.invoke([new HumanMessage('用一句话说明：收集宝石的小游戏里，守卫的作用是什么？')]));
    const kwargs = value.additional_kwargs as Record<string, unknown>;
    const thinking = typeof kwargs.reasoning_content === 'string' ? kwargs.reasoning_content : '';
    const content = typeof value.content === 'string' ? value.content : JSON.stringify(value.content);
    return { think, ms, contentChars: content.length, thinkingChars: thinking.length, content: content.slice(0, 120), evalCount: (value.response_metadata as { eval_count?: number }).eval_count ?? null };
  };
  const cold = await ask(false); // 第一次调用包含加载模型的时间
  out.psAfterLoad = ollamaPs();
  out.thinking = [cold, await ask(false), await ask(true), await ask(false)];

  // ---- 2. 结构化输出：同一个请求连续 RUNS 次
  const provider = new OllamaProvider({ baseUrl: BASE_URL, model: MODEL, numCtx: NUM_CTX });
  const schema = briefJsonSchema();
  out.schemaChars = JSON.stringify(schema).length;
  const rosterIds = new Set(roster.map((p) => p.id));
  const structured: Record<string, unknown>[] = [];
  const framesBefore = await frames();
  for (let i = 0; i < RUNS; i++) {
    const messages = [
      new SystemMessage(briefSystemPrompt()),
      new HumanMessage(briefUserPrompt({ text: REQUEST, understanding: '', roster: entries, previous: null, problems: [] })),
    ];
    const { value: text, ms } = await timed(() => provider.structured(messages, schema, AbortSignal.timeout(180_000)));
    let json: unknown = null;
    let jsonOk = false;
    try {
      json = JSON.parse(text);
      if (useAliases) json = resolveAliases(json, entries);
      jsonOk = true;
    } catch {
      // 记为不通过
    }
    const schemaOk = jsonOk && briefSchema.safeParse(json).success;
    const parsed = jsonOk ? parseBrief(json, rosterIds) : null;
    const rules = parsed?.ok === true;
    const produced = parsed?.ok ? produceLevel(parsed.brief, `probe-${String(i)}`, { rosterIds }) : null;
    // 名册快照里的分工限制（星璇只能当同伴）
    const roleOk = parsed?.ok ? parsed.brief.cast.every((c) => roster.find((p) => p.id === c.personId)?.roles.includes(c.role) === true) : false;
    structured.push({
      run: i + 1,
      ms,
      jsonOk,
      schemaOk,
      rulesOk: rules,
      roleOk,
      produce: produced ? (produced.ok ? (produced.level.adjustment ? 'adjusted' : 'ok') : produced.kind) : null,
      problems: parsed && !parsed.ok ? parsed.problems.map((p) => `${p.path}：${p.message}`) : [],
      brief: parsed?.ok ? { tier: parsed.brief.tier, platforms: parsed.brief.platforms, collectibles: parsed.brief.collectibles, distribution: parsed.brief.distribution, guards: parsed.brief.guards, patrol: parsed.brief.patrol, visual: parsed.brief.visual, cast: parsed.brief.cast.map((c) => c.role) } : null,
    });
    if (i === 0) out.psDuringStructured = ollamaPs();
  }
  out.structured = structured;
  out.framesDuringStructured = (await frames()) - framesBefore;

  // ---- 2b. 思考打开时的结构化输出（对照，3 次）
  const thinkingStructured: Record<string, unknown>[] = [];
  for (let i = 0; i < (skipThink ? 0 : 3); i++) {
    const model = new ChatOllama({ baseUrl: BASE_URL, model: MODEL, think: true, numCtx: NUM_CTX, temperature: 0.4, checkOrPullModel: false, maxRetries: 0 });
    const messages = [new SystemMessage(briefSystemPrompt()), new HumanMessage(briefUserPrompt({ text: REQUEST, understanding: '', roster: entries, previous: null, problems: [] }))];
    const { value, ms } = await timed(() => model.invoke(messages, { format: schema }));
    const text = typeof value.content === 'string' ? value.content : '';
    let ok = false;
    try {
      ok = parseBrief(resolveAliases(JSON.parse(text), entries), rosterIds).ok;
    } catch {
      ok = false;
    }
    thinkingStructured.push({ run: i + 1, ms, ok, thinkingChars: ((value.additional_kwargs as { reasoning_content?: string }).reasoning_content ?? '').length });
  }
  out.thinkingStructured = thinkingStructured;

  // ---- 3. 工具调用：查名册快照
  const lookup = tool(() => describeRoster(entries), {
    name: 'lookup_roster',
    description: '查名册快照：返回这次可以出场的人物（personId、显示名、允许的分工）。',
    schema: z.object({ query: z.string().optional().describe('想找的人物（可以不填）') }),
  });
  const toolRuns: Record<string, unknown>[] = [];
  for (let i = 0; i < (skipTools ? 0 : 3); i++) {
    const messages = [new SystemMessage(understandSystemPrompt()), new HumanMessage(`玩家的一句话：${REQUEST}`)];
    const first = await timed(() => provider.chat(messages, [lookup], AbortSignal.timeout(120_000)));
    const calls = first.value.tool_calls ?? [];
    let finalText = typeof first.value.content === 'string' ? first.value.content : '';
    let secondMs = 0;
    if (calls.length > 0) {
      const followUp = [
        ...messages,
        first.value,
        ...calls.map((c) => new ToolMessage({ content: describeRoster(entries), tool_call_id: c.id ?? 'call' })),
      ];
      const second = await timed(() => provider.chat(followUp, [lookup], AbortSignal.timeout(120_000)));
      secondMs = second.ms;
      finalText = typeof second.value.content === 'string' ? second.value.content : '';
    }
    toolRuns.push({ run: i + 1, firstMs: first.ms, toolCalls: calls.map((c) => c.name), secondMs, understanding: finalText.slice(0, 200) });
  }
  out.tools = toolRuns;
  out.psEnd = ollamaPs();
  out.framesTotal = await frames();

  await browser.close();
  await vite.close();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
