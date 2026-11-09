// 关卡工坊的模型接口（P8）：在测试里起假的 HTTP 服务（127.0.0.1 的随机端口，测试结束时关闭），
// 用真正的 @langchain/ollama 和 @langchain/openai 去调，检查：
// - Ollama 接口和 OpenAI 兼容接口的请求格式、结构化输出的参数、工具调用；
// - 错误码和超时的处理（超时或取消时真的中断了 HTTP 请求）；
// - 密钥不出现在日志、错误信息、响应和统计里。
// 测试用的密钥是一看就是假的 fake-key-1。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { loadConfig, type WorkshopConfig } from '../../server/config';
import { Redactor, describeCallError } from '../../server/errors';
import { createWorkshopServer, listen } from '../../server/http';
import { createLogger } from '../../server/log';
import { briefJsonSchema } from '../../server/prompts';
import { OllamaProvider, OpenAiCompatibleProvider, createProvider } from '../../server/providers';
import { MemoryStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';

const FAKE_KEY = 'fake-key-1';

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown> | null;
  /** 请求在服务端被客户端中断（连接关闭）。 */
  aborted: boolean;
}

type Handler = (req: Captured, res: ServerResponse) => void | Promise<void>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** 假的 HTTP 服务：记下每个请求，交给 handler 回复。 */
async function fakeServer(handler: Handler): Promise<{ url: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const captured: Captured = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, aborted: false };
      res.on('close', () => {
        if (!res.writableFinished) captured.aborted = true;
      });
      requests.push(captured);
      void handler(captured, res);
    });
  });
  servers.push(server);
  const port = await listen(server, 0);
  return { url: `http://127.0.0.1:${String(port)}`, requests };
}

/** Ollama 的流式回复（NDJSON）。 */
function ollamaStream(res: ServerResponse, message: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.write(`${JSON.stringify({ model: 'test-model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '', ...message }, done: false })}\n`);
  res.end(`${JSON.stringify({ model: 'test-model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 })}\n`);
}

function openAiCompletion(res: ServerResponse, message: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

function config(env: Record<string, string>): WorkshopConfig {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  return loaded.config;
}

const messages = [new SystemMessage('系统提示'), new HumanMessage('玩家的一句话：雨夜')];
const lookup = tool(() => '名册', { name: 'lookup_roster', description: '查名册快照', schema: z.object({ query: z.string().optional() }) });

describe('Ollama（默认）', () => {
  it('结构化输出：POST /api/chat，format 是说明书的 JSON Schema，关闭思考，上下文长度随请求传；返回模型输出的文本', async () => {
    const brief = randomBrief('ollama-structured');
    const fake = await fakeServer((_req, res) => {
      ollamaStream(res, { content: JSON.stringify(brief) });
    });
    const provider = new OllamaProvider({ baseUrl: fake.url, model: 'test-model', numCtx: 8192 });
    const text = await provider.structured(messages, briefJsonSchema(), AbortSignal.timeout(5000));
    expect(JSON.parse(text)).toEqual(brief);
    const req = fake.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/api/chat');
    expect(req?.body).toMatchObject({ model: 'test-model', think: false, stream: true, format: briefJsonSchema(), options: { num_ctx: 8192 } });
    expect((req?.body?.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    // 不检查、不拉取模型：只发了一个请求
    expect(fake.requests).toHaveLength(1);
  });

  it('工具调用：请求里带 tools；回复里的 tool_calls 交给调用方', async () => {
    const fake = await fakeServer((_req, res) => {
      ollamaStream(res, { tool_calls: [{ function: { name: 'lookup_roster', arguments: { query: '星璇' } } }] });
    });
    const provider = new OllamaProvider({ baseUrl: fake.url, model: 'test-model', numCtx: 8192 });
    const reply = await provider.chat(messages, [lookup], AbortSignal.timeout(5000));
    expect(reply.tool_calls?.[0]).toMatchObject({ name: 'lookup_roster', args: { query: '星璇' } });
    const tools = fake.requests[0]?.body?.tools as { type: string; function: { name: string } }[];
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'lookup_roster' } });
  });

  it('健康检查：GET /api/tags 里有这个模型才算可用；没有时不拉取；连不上时说明原因', async () => {
    const fake = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'test-model', model: 'test-model' }] }));
    });
    expect(await new OllamaProvider({ baseUrl: fake.url, model: 'test-model', numCtx: 8192 }).availability(AbortSignal.timeout(2000))).toEqual({ available: true, reason: null });
    const missing = await new OllamaProvider({ baseUrl: fake.url, model: 'other-model', numCtx: 8192 }).availability(AbortSignal.timeout(2000));
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('没有模型 other-model');
    expect(fake.requests.every((r) => r.path === '/api/tags')).toBe(true);
    const down = await new OllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: 'test-model', numCtx: 8192 }).availability(AbortSignal.timeout(2000));
    expect(down.reason).toContain('连不上 Ollama');
  });

  it('HTTP 错误码：归类为“模型服务返回错误（HTTP 500）”，不带原文', async () => {
    const fake = await fakeServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model runner crashed: secret details' }));
    });
    const provider = new OllamaProvider({ baseUrl: fake.url, model: 'test-model', numCtx: 8192 });
    const error = await provider.structured(messages, briefJsonSchema(), AbortSignal.timeout(5000)).catch((e: unknown) => e);
    const info = describeCallError(error);
    expect(info).toEqual({ kind: 'http', message: '模型服务返回错误（HTTP 500）' });
  });

  it('超时：中止这次调用，服务端看到请求被中断（模型那边随之停止生成），算作服务错误并回退', async () => {
    const fake = await fakeServer((req, res) => {
      if (req.path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
        return;
      }
      // 不回复，等客户端中断
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    });
    const cfg = config({ MW_LLM_PROVIDER: 'ollama', MW_OLLAMA_BASE_URL: fake.url, MW_OLLAMA_MODEL: 'test-model', MW_WORKSHOP_CALL_TIMEOUT_MS: '300' });
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: cfg, provider: createProvider(cfg), stats, log: createLogger(new Redactor([]), () => undefined) });
    const res = await workshop.generate({ generationId: 'timeout-0001', text: '雨夜', roster: [] });
    if (res.status !== 'fallback') throw new Error('应该回退');
    expect(res.fallback.outcome).toBe('error');
    expect(res.fallback.reason).toContain('超时');
    await expect.poll(() => fake.requests.filter((r) => r.path === '/api/chat').every((r) => r.aborted)).toBe(true);
    expect(stats.records.map((r) => r.outcome)).toEqual(['error']);
  });

  it('取消：中止模型调用（服务端看到请求被中断），不回退', async () => {
    const fake = await fakeServer((req, res) => {
      if (req.path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    });
    const cfg = config({ MW_LLM_PROVIDER: 'ollama', MW_OLLAMA_BASE_URL: fake.url, MW_OLLAMA_MODEL: 'test-model' });
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: cfg, provider: createProvider(cfg), stats, log: createLogger(new Redactor([]), () => undefined) });
    const pending = workshop.generate({ generationId: 'cancel-0001', text: '雨夜', roster: [] });
    await expect.poll(() => fake.requests.some((r) => r.path === '/api/chat')).toBe(true);
    workshop.cancel('cancel-0001');
    expect((await pending).status).toBe('cancelled');
    await expect.poll(() => fake.requests.find((r) => r.path === '/api/chat')?.aborted).toBe(true);
    expect(stats.records.map((r) => r.outcome)).toEqual(['cancelled']);
  });
});

describe('OpenAI 兼容接口（可选）', () => {
  it('结构化输出：POST {baseUrl}/chat/completions，Authorization 带密钥，response_format 是 json_schema；不用流式', async () => {
    const brief = randomBrief('openai-structured');
    const fake = await fakeServer((_req, res) => {
      openAiCompletion(res, { content: JSON.stringify(brief) });
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${fake.url}/v1`, model: 'test-model', apiKey: FAKE_KEY });
    const text = await provider.structured(messages, briefJsonSchema(), AbortSignal.timeout(5000));
    expect(JSON.parse(text)).toEqual(brief);
    const req = fake.requests[0];
    expect(req?.path).toBe('/v1/chat/completions');
    expect(req?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req?.body).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_schema', json_schema: { name: 'level_brief', strict: false, schema: briefJsonSchema() } },
    });
    expect(req?.body?.stream ?? false).toBe(false);
    expect((req?.body?.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('工具调用：请求里带 tools（function calling），回复里的 tool_calls 交给调用方', async () => {
    const fake = await fakeServer((_req, res) => {
      openAiCompletion(res, { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_roster', arguments: '{"query":"星璇"}' } }] });
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${fake.url}/v1`, model: 'test-model', apiKey: FAKE_KEY });
    const reply = await provider.chat(messages, [lookup], AbortSignal.timeout(5000));
    expect(reply.tool_calls?.[0]).toMatchObject({ name: 'lookup_roster', args: { query: '星璇' } });
    expect((fake.requests[0]?.body?.tools as { function: { name: string } }[])[0]?.function.name).toBe('lookup_roster');
  });

  it('配置不全时不可用，并说明缺了哪个变量（不回显任何值）', async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: null, apiKey: FAKE_KEY });
    const availability = await provider.availability(AbortSignal.timeout(2000));
    expect(availability).toEqual({ available: false, reason: 'OpenAI 兼容接口的配置不全：缺少 MW_OPENAI_MODEL' });
  });

  it('健康检查：GET {baseUrl}/models 确认连得上、密钥被接受、有这个模型；不可用时说明原因（不含密钥）', async () => {
    let models: { status: number; body: unknown } = { status: 200, body: { object: 'list', data: [{ id: 'test-model', object: 'model' }] } };
    const fake = await fakeServer((_req, res) => {
      res.writeHead(models.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(models.body));
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${fake.url}/v1`, model: 'test-model', apiKey: FAKE_KEY });
    const check = () => provider.availability(AbortSignal.timeout(2000));
    expect(await check()).toEqual({ available: true, reason: null });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    models = { status: 200, body: { object: 'list', data: [{ id: 'other-model' }] } };
    expect(await check()).toEqual({ available: false, reason: 'OpenAI 兼容接口里没有模型 test-model' });
    models = { status: 401, body: { error: { message: `bad key ${FAKE_KEY}` } } };
    expect(await check()).toEqual({ available: false, reason: 'OpenAI 兼容接口拒绝了密钥（HTTP 401）' });
    models = { status: 502, body: {} };
    expect(await check()).toEqual({ available: false, reason: 'OpenAI 兼容接口返回错误（HTTP 502）' });
    const down = new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: FAKE_KEY });
    expect(await down.availability(AbortSignal.timeout(2000))).toEqual({ available: false, reason: '连不上 OpenAI 兼容接口' });
  });

  it('对话请求被拒或找不到模型之后：健康检查用一个最小的对话请求再确认，仍然失败就报不可用，成功后恢复', async () => {
    let chatStatus = 401;
    const fake = await fakeServer((req, res) => {
      if (req.path.endsWith('/models')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (chatStatus !== 200) {
        res.writeHead(chatStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'nope' } }));
        return;
      }
      openAiCompletion(res, { content: '好的' });
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${fake.url}/v1`, model: 'test-model', apiKey: FAKE_KEY });
    const check = () => provider.availability(AbortSignal.timeout(2000));
    const chats = () => fake.requests.filter((r) => r.path.endsWith('/chat/completions')).length;
    // 平时的健康检查不调用模型
    expect((await check()).available).toBe(true);
    expect(chats()).toBe(0);
    await expect(provider.chat(messages, [], AbortSignal.timeout(2000))).rejects.toBeDefined();
    expect(await check()).toEqual({ available: false, reason: 'OpenAI 兼容接口拒绝了对话请求（HTTP 401）' });
    // 探测用的是最小的对话请求
    const probe = fake.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1);
    expect(probe?.body).toMatchObject({ model: 'test-model', max_tokens: 1 });
    chatStatus = 404;
    expect((await check()).reason).toContain('找不到模型 test-model');
    // 接口恢复：不用先成功调用一次，健康检查自己的探测就能恢复
    chatStatus = 200;
    expect(await check()).toEqual({ available: true, reason: null });
    const before = chats();
    expect(await check()).toEqual({ available: true, reason: null });
    expect(chats()).toBe(before);
  });

  /** 一个 OpenAI 兼容接口的假服务：列出模型、对话（理解请求回一句话，写说明书回一份合法的说明书）。 */
  async function openAiService(options: { models: () => number; chat: (req: Captured, res: ServerResponse) => boolean }) {
    const brief = randomBrief('openai-recovery');
    return fakeServer((req, res) => {
      if (req.path.endsWith('/models')) {
        const status = options.models();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 200 ? JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }) : '{}');
        return;
      }
      if (!options.chat(req, res)) return;
      if (req.body?.response_format) openAiCompletion(res, { content: JSON.stringify(brief) });
      else openAiCompletion(res, { content: '雨夜的中地图。' });
    });
  }

  function openAiWorkshop(url: string, env: Record<string, string> = {}) {
    const cfg = config({ MW_LLM_PROVIDER: 'openai', MW_OPENAI_BASE_URL: `${url}/v1`, MW_OPENAI_MODEL: 'test-model', MW_OPENAI_API_KEY: FAKE_KEY, ...env });
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: cfg, provider: createProvider(cfg), stats, log: createLogger(new Redactor([FAKE_KEY]), () => undefined), newSeed: () => 'recovery-seed' });
    return { workshop, stats };
  }

  it('经 Workshop：能列出模型、但对话被拒（403）——生成回退后健康检查报不可用；接口恢复后健康检查和生成都恢复', async () => {
    let chatStatus = 403;
    const fake = await openAiService({
      models: () => 200,
      chat: (_req, res) => {
        if (chatStatus === 200) return true;
        res.writeHead(chatStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model access denied' } }));
        return false;
      },
    });
    const { workshop, stats } = openAiWorkshop(fake.url);
    expect((await workshop.health()).available).toBe(true);
    const first = await workshop.generate({ generationId: 'access-0001', text: '雨夜', roster: [] });
    expect(first).toMatchObject({ status: 'fallback', fallback: { outcome: 'error', reason: '理解请求：模型服务返回错误（HTTP 403）' } });
    // 能列出模型不代表能调用：健康检查报不可用并说明原因，界面据此提供“随机一关”
    expect(await workshop.health()).toMatchObject({ available: false, reason: 'OpenAI 兼容接口拒绝了对话请求（HTTP 403）' });
    await expect(workshop.generate({ generationId: 'access-0002', text: '雨夜', roster: [] })).rejects.toMatchObject({ code: 'unavailable' });
    // 接口恢复
    chatStatus = 200;
    expect(await workshop.health()).toMatchObject({ available: true, reason: null });
    const again = await workshop.generate({ generationId: 'access-0003', text: '雨夜', roster: [] });
    expect(again.status).toBe('preview');
    expect(stats.records.map((r) => r.outcome)).toEqual(['error', 'model-first']);
  });

  /**
   * 并发探测：第一次对话被拒（403）后，下一次生成在检查处发出探测并一直等着；这时另一个页面的健康检查探测成功，
   * 把失败记录清掉；然后取消（或超时）前一个生成。前一个生成要按取消（或超时）正常结束，并记一条统计。
   */
  async function concurrentProbe(end: 'cancel' | 'timeout') {
    let chats = 0;
    const fake = await openAiService({
      models: () => 200,
      chat: (_req, res) => {
        chats++;
        if (chats === 1) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'denied' } }));
          return false;
        }
        // 第 2 个对话请求是生成前的探测：不回复，等它被中止
        if (chats === 2) return false;
        return true;
      },
    });
    const { workshop, stats } = openAiWorkshop(fake.url, end === 'timeout' ? { MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1500' } : {});
    expect((await workshop.generate({ generationId: 'probe-0001', text: '雨夜', roster: [] })).status).toBe('fallback');
    const pending = workshop.generate({ generationId: 'probe-0002', text: '雨夜', roster: [] });
    await expect.poll(() => chats).toBe(2);
    // 另一个页面的健康检查：探测成功，失败记录被清掉
    expect(await workshop.health()).toMatchObject({ available: true, reason: null });
    if (end === 'cancel') workshop.cancel('probe-0002');
    return { result: await pending, stats, fake };
  }

  it('并发探测：另一个页面的健康检查把失败记录清掉后，取消正在探测的生成——正常取消，记一条取消', async () => {
    const { result, stats, fake } = await concurrentProbe('cancel');
    expect(result.status).toBe('cancelled');
    expect(stats.records.map((r) => r.outcome)).toEqual(['error', 'cancelled']);
    await expect.poll(() => fake.requests.filter((r) => r.path.endsWith('/chat/completions'))[1]?.aborted).toBe(true);
  });

  it('并发探测：同样的情况下正在探测的生成超时——服务错误并回退，记一条服务错误', async () => {
    const { result, stats } = await concurrentProbe('timeout');
    expect(result).toMatchObject({ status: 'fallback', fallback: { outcome: 'error' } });
    if (result.status === 'fallback') expect(result.fallback.reason).toContain('整个生成请求超时');
    expect(stats.records.map((r) => r.outcome)).toEqual(['error', 'error']);
  });

  it('经 Workshop：不支持列出模型（404）的接口发生一次瞬时网络故障后，健康检查和再次生成都能恢复', async () => {
    let failNext = true;
    const fake = await openAiService({
      models: () => 404,
      chat: (_req, res) => {
        if (!failNext) return true;
        failNext = false;
        // 瞬时的网络故障：直接断开连接
        res.socket?.destroy();
        return false;
      },
    });
    const { workshop, stats } = openAiWorkshop(fake.url);
    const first = await workshop.generate({ generationId: 'blip-0001', text: '雨夜', roster: [] });
    expect(first).toMatchObject({ status: 'fallback', fallback: { outcome: 'error', reason: '理解请求：连不上模型服务' } });
    // 服务已经恢复：GET /models 收到了 HTTP 响应（404），说明又连得上了
    expect(await workshop.health()).toMatchObject({ available: true, reason: null });
    const second = await workshop.generate({ generationId: 'blip-0002', text: '雨夜', roster: [] });
    expect(second.status).toBe('preview');
    expect(fake.requests.filter((r) => r.path.endsWith('/chat/completions')).length).toBeGreaterThanOrEqual(3);
    expect(stats.records.map((r) => r.outcome)).toEqual(['error', 'model-first']);
  });

  it('密钥不出现在日志、错误信息、响应和统计里（假服务在错误里原样回显密钥）', async () => {
    const fake = await fakeServer((req, res) => {
      // 列出模型时接受密钥；对话时拒绝，并在错误里原样回显密钥
      if (req.path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${String(req.headers.authorization)}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
    });
    const cfg = config({ MW_LLM_PROVIDER: 'openai', MW_OPENAI_BASE_URL: `${fake.url}/v1`, MW_OPENAI_MODEL: 'test-model', MW_OPENAI_API_KEY: FAKE_KEY });
    const logs: string[] = [];
    const log = createLogger(new Redactor([cfg.openai.apiKey]), (line) => logs.push(line));
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: cfg, provider: createProvider(cfg), stats, log });
    const server = createWorkshopServer(workshop, { maxBodyBytes: cfg.limits.maxBodyBytes }, log);
    servers.push(server);
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${String(port)}/api/workshop`;
    const health = await (await fetch(`${base}/health`)).text();
    const generate = await (
      await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generationId: 'key-test-0001', text: '雨夜', roster: [] }) })
    ).text();
    // 请求确实带着密钥发给了接口
    expect(fake.requests.find((r) => r.path.endsWith('/chat/completions'))?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    // 调用鉴权失败后，健康检查（列出模型仍然成功）照常；生成的回退说明了原因
    const unhealthy = await (
      await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generationId: 'key-test-0002', text: '雪夜', roster: [] }) })
    ).text();
    expect(unhealthy).not.toContain(FAKE_KEY);
    expect(JSON.parse(generate)).toMatchObject({ status: 'fallback', fallback: { outcome: 'error', reason: '理解请求：模型服务返回错误（HTTP 401）' } });
    expect(JSON.parse(health)).toMatchObject({ provider: 'openai', model: 'test-model', available: true });
    for (const text of [health, generate, ...logs, ...stats.records.map((r) => JSON.stringify(r))]) expect(text).not.toContain(FAKE_KEY);
    expect(logs.length).toBeGreaterThan(0);
    // 脱敏本身：日志里出现密钥时会被替换
    const redacted: string[] = [];
    createLogger(new Redactor([FAKE_KEY]), (line) => redacted.push(line)).error(`出错了：${FAKE_KEY}`);
    expect(redacted[0]).not.toContain(FAKE_KEY);
    expect(redacted[0]).toContain('[已隐藏]');
  });

  it('本机失败时不会自动切换到外部接口：提供方只由配置决定', async () => {
    const external = await fakeServer((_req, res) => {
      openAiCompletion(res, { content: '{}' });
    });
    // 配了外部接口，但提供方是 ollama 且 Ollama 连不上
    const cfg = config({
      MW_LLM_PROVIDER: 'ollama',
      MW_OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      MW_OPENAI_BASE_URL: `${external.url}/v1`,
      MW_OPENAI_MODEL: 'test-model',
      MW_OPENAI_API_KEY: FAKE_KEY,
    });
    const workshop = new Workshop({ config: cfg, provider: createProvider(cfg), stats: new MemoryStats(), log: createLogger(new Redactor([]), () => undefined) });
    await expect(workshop.generate({ generationId: 'no-switch-0001', text: '雨夜', roster: [] })).rejects.toMatchObject({ code: 'unavailable' });
    expect(external.requests).toEqual([]);
  });
});
