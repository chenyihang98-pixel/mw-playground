// 关卡工坊的本机服务（P8）：只监听 127.0.0.1；请求体超出上限被拒绝；不合规的请求被拒绝；“忙”的错误码；
// 浏览器断开时取消；配置从环境变量读取、出错时不回显变量的值。服务在测试里启动，测试结束时关闭。

import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { generateResponseSchema, healthResponseSchema } from '../../src/workshop/protocol';
import { DEFAULT_PORT, HOST, loadConfig, type WorkshopConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider, type FakeScript } from '../../server/fakeProvider';
import { createWorkshopServer, listen } from '../../server/http';
import { createLogger } from '../../server/log';
import { MemoryStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';

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

function config(env: Record<string, string> = {}): WorkshopConfig {
  const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', ...env });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  return loaded.config;
}

async function start(script: FakeScript = {}, env: Record<string, string> = {}) {
  const cfg = config(env);
  const stats = new MemoryStats();
  const provider = new FakeProvider(script);
  const log = createLogger(new Redactor([]), () => undefined);
  const workshop = new Workshop({ config: cfg, provider, stats, log });
  const server = createWorkshopServer(workshop, { maxBodyBytes: cfg.limits.maxBodyBytes }, log);
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${String(port)}/api/workshop`;
  const post = (path: string, body: unknown, init: RequestInit = {}) =>
    fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
  return { server, stats, provider, base, post, workshop };
}

describe('网络', () => {
  it('只监听 127.0.0.1（地址固定，不能配置）；默认端口是固定值', async () => {
    const s = await start();
    const address = s.server.address();
    expect(typeof address === 'object' && address ? address.address : null).toBe('127.0.0.1');
    expect(HOST).toBe('127.0.0.1');
    expect(config().port).toBe(DEFAULT_PORT);
    expect(config({ MW_WORKSHOP_PORT: '9001' }).port).toBe(9001);
    const health = healthResponseSchema.parse(await (await fetch(`${s.base}/health`)).json());
    expect(health).toMatchObject({ provider: 'fake', available: true, busy: false, maxRequestChars: 200 });
  });

  it('请求体超过上限：413（too-large）', async () => {
    const s = await start({}, { MW_WORKSHOP_MAX_BODY_BYTES: '2048' });
    const res = await s.post('generate', { generationId: 'big-00000001', text: '雨'.repeat(2000), roster: [] });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'too-large' } });
    expect(s.provider.calls).toEqual({ chat: 0, structured: 0 });
  });

  it('不合规的请求：400（bad-request），不调用模型', async () => {
    const s = await start();
    const bad: [string, string | object][] = [
      ['不是 JSON', '{oops'],
      ['缺字段', { text: '雨夜', roster: [] }],
      ['多余的字段', { generationId: 'extra-0000001', text: '雨夜', roster: [], timeLimit: 5 }],
      ['空的一句话', { generationId: 'empty-0000001', text: '   ', roster: [] }],
      ['生成标识的格式不对', { generationId: 'a b', text: '雨夜', roster: [] }],
      ['人物重复', { generationId: 'dup-00000001', text: '雨夜', roster: [{ id: 'x', name: '甲', roles: ['guard'] }, { id: 'x', name: '乙', roles: ['guard'] }] }],
      ['分工不对', { generationId: 'role-0000001', text: '雨夜', roster: [{ id: 'x', name: '甲', roles: ['boss'] }] }],
      ['一句话超过上限', { generationId: 'long-0000001', text: '雨'.repeat(201), roster: [] }],
    ];
    for (const [name, body] of bad) {
      const res = await s.post('generate', body);
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    }
    const wrongType = await fetch(`${s.base}/generate`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(400);
    expect((await fetch(`${s.base}/generate`)).status).toBe(404);
    expect((await fetch(`${s.base}/../../etc`)).status).toBe(404);
    expect(s.provider.calls).toEqual({ chat: 0, structured: 0 });
    expect(s.stats.records).toEqual([]);
  });

  it('已经有一个生成在进行：新的请求返回 409（busy）；取消后可以再生成', async () => {
    const s = await start({ briefs: [{ kind: 'hang' }] });
    const first = s.post('generate', { generationId: 'busy-0000001', text: '雨夜', roster: [] });
    await expect.poll(() => s.workshop.busy).toBe(true);
    const second = await s.post('generate', { generationId: 'busy-0000002', text: '雪夜', roster: [] });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect((await s.post('cancel', { generationId: 'busy-0000001' })).status).toBe(200);
    const res = generateResponseSchema.parse(await (await first).json());
    expect(res.status).toBe('cancelled');
    const third = generateResponseSchema.parse(await (await s.post('generate', { generationId: 'busy-0000003', text: '雪夜', roster: [] })).json());
    expect(third.status).toBe('preview');
    expect(s.stats.records.map((r) => r.outcome)).toEqual(['cancelled', 'model-first']);
  });

  it('浏览器断开（中止请求）：服务取消这次生成，统计记为取消', async () => {
    const s = await start({ briefs: [{ kind: 'hang' }] });
    const controller = new AbortController();
    const pending = s.post('generate', { generationId: 'gone-0000001', text: '雨夜', roster: [] }, { signal: controller.signal }).catch(() => null);
    await expect.poll(() => s.workshop.busy).toBe(true);
    controller.abort();
    await pending;
    await expect.poll(() => s.stats.records.map((r) => r.outcome)).toEqual(['cancelled']);
    expect(s.workshop.busy).toBe(false);
  });

  it('确认、重复确认、放弃：响应按 schema；重复确认返回同一份（duplicate）', async () => {
    const s = await start();
    const preview = generateResponseSchema.parse(await (await s.post('generate', { generationId: 'flow-0000001', text: '雨夜', roster: [] })).json());
    if (preview.status !== 'preview') throw new Error('应该出预览');
    const ref = { generationId: preview.generationId, version: preview.version, serviceId: preview.serviceId };
    const a = (await (await s.post('confirm', ref)).json()) as { duplicate: boolean; level: { layoutHash: string } };
    const b = (await (await s.post('confirm', ref)).json()) as { duplicate: boolean; level: { layoutHash: string } };
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(a.level.layoutHash).toBe(preview.preview.level.layoutHash);
    expect(b.level.layoutHash).toBe(preview.preview.level.layoutHash);
    const expired = await s.post('confirm', { ...ref, serviceId: 'restarted' });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: 'expired', message: '工坊服务重启过，未确认的预览已失效' } });
    expect((await s.post('discard', { generationId: 'flow-0000002' })).status).toBe(200);
  });
});

describe('配置', () => {
  it('从环境变量读取：默认 ollama 和本机地址；出错时只说哪个变量不对，不回显值', () => {
    const defaults = loadConfig({});
    if (!defaults.ok) throw new Error('默认配置应该可用');
    expect(defaults.config.provider).toBe('ollama');
    expect(defaults.config.ollama).toMatchObject({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b-q4_K_M' });
    expect(defaults.config.limits).toMatchObject({ maxRequestChars: 200, callTimeoutMs: 60_000, requestTimeoutMs: 180_000 });
    const bad = loadConfig({ MW_LLM_PROVIDER: 'fake-key-1-provider', MW_WORKSHOP_PORT: 'not-a-port' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.join('\n')).toContain('MW_LLM_PROVIDER');
    expect(bad.problems.join('\n')).toContain('MW_WORKSHOP_PORT');
    expect(bad.problems.join('\n')).not.toContain('fake-key-1-provider');
    expect(bad.problems.join('\n')).not.toContain('not-a-port');
  });
});
