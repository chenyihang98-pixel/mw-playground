// 调用模型之前先加载模型（F2）：
// - OllamaProvider.prepare 的请求（用假的 fetch）：只发一次 POST /api/generate，请求体正好是 { model, stream: false, options: { num_ctx } }；
//   num_ctx 和 ChatOllama 用的相同；各种失败能分清类别；signal 中止时 fetch 收到中止。OpenAiCompatibleProvider.prepare 不发请求。
// - Workshop（用假模型，超时都用很短的值）：prepare 在第一次模型调用之前、每个请求一次；加载慢于单次调用超时但没到加载超时时照常成功；
//   加载超时、加载失败、加载期间取消、加载期间整个请求超时、加载期间来第二个请求；health 不加载模型。
// - 配置：MW_WORKSHOP_PREPARE_TIMEOUT_MS 的默认值和校验（F5：没设时取默认值和整个请求时限中较小的）。
//   统计：timingsMs.prepare，新旧记录都能汇总。
// 不连真实的 Ollama。

import { describe, expect, it } from 'vitest';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import type { GenerateRequest } from '../../src/workshop/protocol';
import { loadConfig, type WorkshopConfig } from '../../server/config';
import { PrepareError, Redactor } from '../../server/errors';
import { FakeProvider, type FakeScript } from '../../server/fakeProvider';
import { createLogger } from '../../server/log';
import { OllamaProvider, OpenAiCompatibleProvider, type LlmProvider } from '../../server/providers';
import { MemoryStats, summarize, type StatsRecord } from '../../server/stats';
import { Workshop } from '../../server/workshop';

interface FetchCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly signal: AbortSignal | null;
}

/** 假的 fetch：记下每次调用，交给 handler 回复。 */
function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const text = typeof init?.body === 'string' ? init.body : null;
    const call: FetchCall = {
      url,
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: impl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** Ollama 对话的流式回复（NDJSON）。 */
function ollamaChat(content: string): Response {
  const lines = [
    { model: 'test-model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content }, done: false },
    { model: 'test-model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
  ];
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

const LOADED = { model: 'test-model', created_at: '2026-01-01T00:00:00Z', response: '', done: true, done_reason: 'load' };

function config(overrides: Record<string, string> = {}): WorkshopConfig {
  const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', MW_WORKSHOP_CALL_TIMEOUT_MS: '2000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '20000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '10000', ...overrides });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  return loaded.config;
}

function harness(script: FakeScript, env: Record<string, string> = {}) {
  const provider = new FakeProvider(script);
  const stats = new MemoryStats();
  const logs: string[] = [];
  const workshop = new Workshop({ config: config(env), provider, stats, log: createLogger(new Redactor([]), (line) => logs.push(line)), newSeed: () => 'prepare-seed' });
  return { provider, stats, workshop, logs };
}

let counter = 0;
function request(text = '想要一个下雨的夜晚，中等大小的地图。'): GenerateRequest {
  counter++;
  return { generationId: `prepare-${String(counter).padStart(4, '0')}`, text, roster: [] };
}

describe('OllamaProvider.prepare', () => {
  const ollama = (fetchImpl: typeof fetch, numCtx = 8192) => new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'test-model', numCtx }, fetchImpl);

  it('只发一次 POST /api/generate，请求体正好是 { model, stream: false, options: { num_ctx } }，不带 prompt 和 keep_alive', async () => {
    const fake = fakeFetch(() => json(LOADED));
    await ollama(fake.fetch, 4096).prepare(AbortSignal.timeout(2000));
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('http://127.0.0.1:11434/api/generate');
    expect(call?.method).toBe('POST');
    expect(call?.body).toStrictEqual({ model: 'test-model', stream: false, options: { num_ctx: 4096 } });
    expect(call?.body).not.toHaveProperty('prompt');
    expect(call?.body).not.toHaveProperty('keep_alive');
    // 用的是传进来的 signal
    expect(call?.signal).not.toBeNull();
  });

  it('加载请求的 num_ctx 和 ChatOllama 对话请求用的相同（不同时 Ollama 会重新加载模型）', async () => {
    const fake = fakeFetch((call) => (call.path === '/api/generate' ? json(LOADED) : ollamaChat('{}')));
    const provider = ollama(fake.fetch, 6144);
    await provider.prepare(AbortSignal.timeout(2000));
    await provider.structured([], { type: 'object' }, AbortSignal.timeout(2000));
    const [load, chat] = fake.calls;
    expect(load?.path).toBe('/api/generate');
    expect(chat?.path).toBe('/api/chat');
    expect((load?.body?.options as { num_ctx?: unknown } | undefined)?.num_ctx).toBe(6144);
    expect((chat?.body?.options as { num_ctx?: unknown } | undefined)?.num_ctx).toBe(6144);
  });

  it('失败时抛错，分清类别：HTTP 状态码、连不上、返回 { done: false }、返回的不是 JSON', async () => {
    const cases: { name: string; reply: () => Response | Promise<Response>; kind: PrepareError['kind']; message: RegExp }[] = [
      { name: 'HTTP 500', reply: () => json({ error: 'model failed to load' }, 500), kind: 'http', message: /HTTP 500/ },
      { name: '连不上', reply: () => Promise.reject(new TypeError('fetch failed')), kind: 'network', message: /连不上 Ollama/ },
      { name: 'done: false', reply: () => json({ ...LOADED, done: false }), kind: 'response', message: /done: true/ },
      { name: '不是 JSON', reply: () => new Response('<html>oops</html>', { status: 200 }), kind: 'response', message: /不是 JSON/ },
    ];
    for (const c of cases) {
      const fake = fakeFetch(c.reply);
      const error = await ollama(fake.fetch)
        .prepare(AbortSignal.timeout(2000))
        .then(() => null, (e: unknown) => e);
      expect(error, c.name).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).kind, c.name).toBe(c.kind);
      expect((error as PrepareError).message, c.name).toMatch(c.message);
      // 原因里不带提供方返回的原文
      expect((error as PrepareError).message, c.name).not.toContain('model failed to load');
      expect(fake.calls, c.name).toHaveLength(1);
    }
    const http = await ollama(fakeFetch(() => json({}, 503)).fetch)
      .prepare(AbortSignal.timeout(2000))
      .catch((e: unknown) => e);
    expect(http).toMatchObject({ kind: 'http', status: 503 });
  });

  it('signal 被中止时，fetch 收到中止；抛出的是中止的错误，不是加载失败', async () => {
    let seen: AbortSignal | null = null;
    const fetchImpl = ((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        seen = init?.signal ?? null;
        seen?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = ollama(fetchImpl).prepare(controller.signal);
    controller.abort(new Error('stop'));
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PrepareError);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe('OpenAiCompatibleProvider.prepare', () => {
  it('什么都不发，直接完成', async () => {
    const fake = fakeFetch(() => json({}));
    const provider: LlmProvider = new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'fake-key-1' }, fake.fetch);
    await provider.prepare(AbortSignal.timeout(1000));
    expect(fake.calls).toEqual([]);
  });
});

describe('Workshop：生成前先加载模型', () => {
  it('prepare 在第一次模型调用之前被调用，每个生成请求正好一次', async () => {
    const h = harness({});
    expect((await h.workshop.generate(request())).status).toBe('preview');
    expect(h.provider.sequence).toEqual(['prepare', 'chat', 'structured']);
    expect((await h.workshop.generate(request('雪地的黄昏'))).status).toBe('preview');
    expect(h.provider.prepareCalls).toBe(2);
    expect(h.provider.sequence).toEqual(['prepare', 'chat', 'structured', 'prepare', 'chat', 'structured']);
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['model-first', 'model-first']);
  });

  it('加载比单次模型调用的超时还慢、但没到加载超时：生成照常成功（加载不算在单次调用的超时里）', async () => {
    const h = harness({ prepare: { delayMs: 400 } }, { MW_WORKSHOP_CALL_TIMEOUT_MS: '200', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '5000' });
    const res = await h.workshop.generate(request());
    expect(res.status).toBe('preview');
    expect(h.provider.calls).toEqual({ chat: 1, structured: 1 });
    const record = h.stats.records[0];
    expect(record?.outcome).toBe('model-first');
    expect(record?.timingsMs.prepare).toBeGreaterThanOrEqual(350);
    expect(record?.timingsMs.total).toBeGreaterThanOrEqual(record?.timingsMs.prepare ?? Infinity);
  });

  it('加载一直不返回：到加载超时时记为服务错误，原因是“加载模型超时”，回退到内置关卡；没有调用模型，统计一条', async () => {
    const h = harness({ prepare: { hang: true } }, { MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '5000' });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error(`应该回退：${JSON.stringify(res)}`);
    expect(res.fallback.outcome).toBe('error');
    expect(res.fallback.reason).toBe('加载模型超时（1 秒）');
    expect(res.fallback.fallbackId).toBe('gen-1');
    expect(h.provider.calls).toEqual({ chat: 0, structured: 0 });
    expect(h.stats.records).toHaveLength(1);
    expect(h.stats.records[0]).toMatchObject({ outcome: 'error', reason: '加载模型超时（1 秒）', briefAttempts: 0, modelCalls: 0 });
    expect(h.stats.records[0]?.timingsMs.prepare).toBeGreaterThanOrEqual(950);
    expect(h.workshop.busy).toBe(false);
  });

  it('加载失败：记为服务错误并回退，原因说明是哪一类；没有调用模型，统计一条', async () => {
    const expected = { network: '连不上', http: 'HTTP 500', response: '内容不对' } as const;
    for (const kind of ['network', 'http', 'response'] as const) {
      const h = harness({ prepare: { fail: kind } });
      const res = await h.workshop.generate(request());
      if (res.status !== 'fallback') throw new Error('应该回退');
      expect(res.fallback.outcome, kind).toBe('error');
      expect(res.fallback.reason, kind).toContain('加载模型失败');
      expect(res.fallback.reason, kind).toContain(expected[kind]);
      expect(h.provider.calls, kind).toEqual({ chat: 0, structured: 0 });
      expect(h.stats.records.map((r) => [r.outcome, r.reason]), kind).toEqual([['error', res.fallback.reason]]);
      expect(h.stats.records[0]?.timingsMs.prepare, kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('加载期间取消：记为取消，不回退，统计一条', async () => {
    const h = harness({ prepare: { hang: true } });
    const req = request();
    const pending = h.workshop.generate(req);
    await expect.poll(() => h.provider.prepareCalls).toBe(1);
    expect(h.workshop.cancel(req.generationId)).toBe(true);
    const res = await pending;
    expect(res.status).toBe('cancelled');
    expect(h.provider.calls).toEqual({ chat: 0, structured: 0 });
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['cancelled']);
    expect(h.stats.records[0]?.timingsMs.prepare).toBeGreaterThanOrEqual(0);
    expect(h.workshop.busy).toBe(false);
  });

  it('加载期间整个请求超时（先于加载超时）：记为服务错误，原因是整个请求超时，统计一条', async () => {
    // 可用性检查先用掉 600 ms：整个请求在 1000 ms 时截止，早于加载超时的截止（约 600 + 1000 ms）
    const h = harness({ availabilityDelayMs: 600, prepare: { hang: true } }, { MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error(`应该回退：${JSON.stringify(res)}`);
    expect(res.fallback.outcome).toBe('error');
    expect(res.fallback.reason).toBe('整个生成请求超时（1 秒）');
    expect(h.provider.prepareCalls).toBe(1);
    expect(h.provider.calls).toEqual({ chat: 0, structured: 0 });
    expect(h.stats.records).toHaveLength(1);
    expect(h.stats.records[0]).toMatchObject({ outcome: 'error', reason: '整个生成请求超时（1 秒）' });
  });

  it('加载期间这次请求算“正在生成”：同时来的请求返回 409', async () => {
    const h = harness({ prepare: { hang: true } });
    const req = request();
    const pending = h.workshop.generate(req);
    await expect.poll(() => h.provider.prepareCalls).toBe(1);
    expect(h.workshop.busy).toBe(true);
    expect((await h.workshop.health()).busy).toBe(true);
    await expect(h.workshop.generate(request())).rejects.toMatchObject({ code: 'busy', status: 409 });
    h.workshop.cancel(req.generationId);
    await pending;
    // 被拒绝的请求不统计
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['cancelled']);
  });

  it('加载开始前就结束的请求（刚受理就取消）：统计里没有 prepare 这一项', async () => {
    const h = harness({});
    const req = request();
    const pending = h.workshop.generate(req);
    h.workshop.cancel(req.generationId);
    expect((await pending).status).toBe('cancelled');
    expect(h.provider.prepareCalls).toBe(0);
    expect(h.stats.records[0]?.timingsMs).not.toHaveProperty('prepare');
  });

  it('health 不加载模型：假的 fetch 只看到 /api/tags（假模型也没有调用 prepare）', async () => {
    const fake = fakeFetch((call) => (call.path === '/api/tags' ? json({ models: [{ name: 'test-model' }] }) : json(LOADED)));
    const cfg = config({ MW_LLM_PROVIDER: 'ollama', MW_OLLAMA_MODEL: 'test-model' });
    const workshop = new Workshop({ config: cfg, provider: new OllamaProvider(cfg.ollama, fake.fetch), stats: new MemoryStats(), log: createLogger(new Redactor([]), () => undefined) });
    expect(await workshop.health()).toMatchObject({ available: true });
    expect(await workshop.health()).toMatchObject({ available: true });
    expect(fake.calls.map((c) => c.path)).toEqual(['/api/tags', '/api/tags']);

    const h = harness({});
    await h.workshop.health();
    expect(h.provider.prepareCalls).toBe(0);
  });

  it('经 Workshop 用 Ollama：先查 /api/tags，再加载（num_ctx 和之后的对话请求相同），再对话', async () => {
    const brief = randomBrief('prepare-ollama');
    const fake = fakeFetch((call) => {
      if (call.path === '/api/tags') return json({ models: [{ name: 'test-model' }] });
      if (call.path === '/api/generate') return json(LOADED);
      return ollamaChat(call.body?.format ? JSON.stringify(brief) : '雨夜的中地图。');
    });
    const cfg = config({ MW_LLM_PROVIDER: 'ollama', MW_OLLAMA_MODEL: 'test-model', MW_OLLAMA_NUM_CTX: '4096' });
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: cfg, provider: new OllamaProvider(cfg.ollama, fake.fetch), stats, log: createLogger(new Redactor([]), () => undefined) });
    const res = await workshop.generate(request());
    expect(res.status).toBe('preview');
    expect(fake.calls.map((c) => c.path)).toEqual(['/api/tags', '/api/generate', '/api/chat', '/api/chat']);
    const numCtx = fake.calls.slice(1).map((c) => (c.body?.options as { num_ctx?: unknown } | undefined)?.num_ctx);
    expect(numCtx).toEqual([4096, 4096, 4096]);
    expect(stats.records[0]?.timingsMs).toHaveProperty('prepare');
  });
});

describe('配置：MW_WORKSHOP_PREPARE_TIMEOUT_MS', () => {
  it('两个都没设：加载时限 150000 毫秒，整个请求时限 180000 毫秒', () => {
    const loaded = loadConfig({});
    if (!loaded.ok) throw new Error(loaded.problems.join('；'));
    expect(loaded.config.limits.prepareTimeoutMs).toBe(150_000);
    expect(loaded.config.limits.requestTimeoutMs).toBe(180_000);
  });

  it('F5：没设加载时限（未定义或空白）时取 150000 和整个请求时限中较小的；推出来的值不受“不小于 1000”的限制', () => {
    for (const [env, request, prepare] of [
      [{ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '60000' }, 60_000, 60_000],
      [{ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '300' }, 300, 300],
      [{ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '200000' }, 200_000, 150_000],
      [{ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '150000' }, 150_000, 150_000],
      [{ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '300', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '   ' }, 300, 300],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '' }, 180_000, 150_000],
    ] as const) {
      const loaded = loadConfig(env);
      if (!loaded.ok) throw new Error(`${JSON.stringify(env)}：${loaded.problems.join('；')}`);
      expect(loaded.config.limits.requestTimeoutMs, JSON.stringify(env)).toBe(request);
      expect(loaded.config.limits.prepareTimeoutMs, JSON.stringify(env)).toBe(prepare);
    }
  });

  it('设了加载时限：规则不变——等于整个请求的超时可以；小于 1000、不是整数、大于整个请求的超时都报配置错误（只说哪个变量不对）', () => {
    const ok = loadConfig({ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1000' });
    expect(ok.ok && ok.config.limits.prepareTimeoutMs).toBe(1000);
    for (const [env, what] of [
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '999' }, '小于 1000'],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1500.5' }, '不是整数'],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: 'soon' }, '不是数字'],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '180001' }, '大于默认的整个请求超时'],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '5000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '4000' }, '大于整个请求超时'],
      [{ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '999', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '300' }, '小于 1000（整个请求时限也很小时照样报错）'],
    ] as const) {
      const loaded = loadConfig(env);
      expect(loaded.ok, what).toBe(false);
      if (!loaded.ok) {
        expect(loaded.problems.join('；'), what).toContain('MW_WORKSHOP_PREPARE_TIMEOUT_MS');
        for (const value of Object.values(env)) expect(loaded.problems.join('；'), what).not.toContain(value);
      }
    }
    // 设了的值照常生效
    const set = loadConfig({ MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' });
    expect(set.ok && set.config.limits.prepareTimeoutMs).toBe(1000);
  });

  it('F5：只把整个请求时限设成 300（不设加载时限），用假模型生成一次，照常出预览', async () => {
    const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '300' });
    if (!loaded.ok) throw new Error(loaded.problems.join('；'));
    expect(loaded.config.limits.prepareTimeoutMs).toBe(300);
    const provider = new FakeProvider({});
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: loaded.config, provider, stats, log: createLogger(new Redactor([]), () => undefined), newSeed: () => 'f5-seed' });
    const res = await workshop.generate(request());
    expect(res.status).toBe('preview');
    expect(provider.prepareCalls).toBe(1);
    expect(stats.records.map((r) => r.outcome)).toEqual(['model-first']);
    expect(stats.records[0]?.timingsMs).toHaveProperty('prepare');
  });
});

describe('统计：timingsMs.prepare', () => {
  it('新记录有 timingsMs.prepare；没有这一项的旧记录也照常汇总', async () => {
    const h = harness({});
    await h.workshop.generate(request());
    const fresh = h.stats.records[0];
    expect(fresh?.timingsMs.prepare).toBeGreaterThanOrEqual(0);
    const old: StatsRecord = {
      id: 'old-0001',
      at: '2026-11-10T00:00:00.000Z',
      outcome: 'model-repaired',
      reason: null,
      provider: 'ollama',
      model: 'qwen3.5:9b-q4_K_M',
      repairs: 1,
      briefAttempts: 2,
      modelCalls: 3,
      timingsMs: { understand: 500, brief: 2400, validate: 1, produce: 30, total: 3000 },
      textChars: 20,
      rosterSize: 2,
    };
    const summary = summarize([JSON.stringify(old), JSON.stringify(fresh)]);
    expect(summary).toMatchObject({ total: 2, invalid: 0, duplicates: 0 });
    expect(summary.counts['model-repaired']).toBe(1);
    expect(summary.counts['model-first']).toBe(1);
  });
});
