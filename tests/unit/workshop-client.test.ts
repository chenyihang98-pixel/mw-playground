// 关卡工坊的浏览器端（P8）：只接受当前生成标识的响应（迟到的旧响应丢弃）；同一时间只发一个；
// 同一个生成标识只确认一次；连不上服务、响应不合规都按“服务不可用”处理。用假的 fetch 驱动。

import { describe, expect, it } from 'vitest';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { produceLevel } from '../../src/game/level/gen/pipeline';
import { packageOfProduced } from '../../src/game/levels/package';
import { WorkshopClient } from '../../src/workshop/client';
import { packageOfWire } from '../../src/workshop/level';
import type { WireLevel } from '../../src/workshop/protocol';

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly signal: AbortSignal | null;
}

function wire(): WireLevel {
  const result = produceLevel(randomBrief('client-test'), 'client-seed');
  if (!result.ok) throw new Error('应该能生成');
  const pkg = packageOfProduced(result.level);
  if (!pkg.brief || pkg.seed === null || pkg.schemaVersion === null || pkg.generatorVersion === null) throw new Error('缺字段');
  return {
    source: 'model',
    title: pkg.title,
    layout: pkg.layout,
    layoutHash: pkg.layoutHash,
    visual: pkg.visual,
    rules: pkg.rules,
    brief: pkg.brief,
    seed: pkg.seed,
    schemaVersion: pkg.schemaVersion,
    generatorVersion: pkg.generatorVersion,
    adjustment: null,
  };
}

const LEVEL = wire();

function preview(generationId: string) {
  return {
    ok: true,
    status: 'preview',
    generationId,
    version: 1,
    serviceId: 'svc-1',
    preview: { level: LEVEL, outcome: 'model-first', repairs: 0, adjustment: null, differences: [], history: [], provider: 'fake', model: 'fake-scripted' },
  };
}

/** 假的 fetch：按 handler 回复；可以让某个请求晚一点回来。 */
function fakeFetch(handler: (call: Call) => Promise<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = { url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null, signal: init?.signal ?? null };
    calls.push(call);
    const { status, body } = await handler(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

function ids() {
  let n = 0;
  return () => `gen-${String(++n).padStart(4, '0')}`;
}

describe('生成', () => {
  it('取消之后迟到的响应被丢弃；新的生成用新的生成标识，只接受自己的响应', async () => {
    let release: (() => void) | null = null;
    const { impl, calls } = fakeFetch(async (call) => {
      if (call.url.endsWith('/cancel')) return { status: 200, body: { ok: true } };
      const id = String(call.body?.generationId);
      if (id === 'gen-0001') {
        // 第一个请求晚回来（模拟服务那边还没来得及处理取消）
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { status: 200, body: preview(id) };
    });
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    const first = client.generate('雨夜', []);
    await expect.poll(() => release !== null).toBe(true);
    client.cancel();
    expect(client.running).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/cancel') && c.body?.generationId === 'gen-0001')).toBe(true);
    const second = await client.generate('雪夜', []);
    expect(second.kind === 'response' && second.response.generationId).toBe('gen-0002');
    (release as unknown as () => void)();
    expect(await first).toEqual({ kind: 'stale' });
  });

  it('同一时间只发一个生成请求', async () => {
    let release: (() => void) | null = null;
    const { impl, calls } = fakeFetch(async (call) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: preview(String(call.body?.generationId)) };
    });
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    const first = client.generate('雨夜', []);
    expect(await client.generate('雪夜', [])).toMatchObject({ kind: 'busy' });
    await expect.poll(() => release !== null).toBe(true);
    (release as unknown as () => void)();
    expect((await first).kind).toBe('response');
    expect(calls.filter((c) => c.url.endsWith('/generate'))).toHaveLength(1);
  });

  it('响应的生成标识不是当前的：丢弃', async () => {
    const { impl } = fakeFetch(() => Promise.resolve({ status: 200, body: preview('someone-else') }));
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    expect(await client.generate('雨夜', [])).toEqual({ kind: 'stale' });
  });

  it('错误码：409 忙、503 不可用（带原因）；连不上、响应不合规：服务不可用', async () => {
    const replies: { status: number; body: unknown }[] = [
      { status: 409, body: { ok: false, error: { code: 'busy', message: '工坊正在生成另一关，请稍后再试' } } },
      { status: 503, body: { ok: false, error: { code: 'unavailable', message: '工坊没有启用模型（MW_LLM_PROVIDER=off）' } } },
      { status: 200, body: { ok: true, status: 'preview' } },
      { status: 502, body: '<html>Bad Gateway</html>' },
    ];
    const { impl } = fakeFetch(() => Promise.resolve(replies.shift() ?? { status: 500, body: null }));
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    expect(await client.generate('雨夜', [])).toMatchObject({ kind: 'busy', message: '工坊正在生成另一关，请稍后再试' });
    expect(await client.generate('雨夜', [])).toMatchObject({ kind: 'unavailable', reason: '工坊没有启用模型（MW_LLM_PROVIDER=off）' });
    expect(await client.generate('雨夜', [])).toMatchObject({ kind: 'unavailable' });
    expect(await client.generate('雨夜', [])).toMatchObject({ kind: 'unavailable' });
    const down = new WorkshopClient(() => Promise.reject(new TypeError('Failed to fetch')), '/api/workshop', ids());
    expect(await down.generate('雨夜', [])).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('连不上工坊服务') as string });
    expect(await down.health()).toMatchObject({ kind: 'unreachable' });
  });
});

describe('确认', () => {
  it('同一个生成标识只发一次确认，重复调用返回同一个结果', async () => {
    const { impl, calls } = fakeFetch(() =>
      Promise.resolve({ status: 200, body: { ok: true, generationId: 'gen-0001', duplicate: false, level: LEVEL, provider: 'fake', model: 'fake-scripted' } }),
    );
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    const [a, b] = await Promise.all([client.confirm('gen-0001', 1, 'svc-1'), client.confirm('gen-0001', 1, 'svc-1')]);
    const c = await client.confirm('gen-0001', 1, 'svc-1');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(calls.filter((x) => x.url.endsWith('/confirm'))).toHaveLength(1);
    expect(a.kind).toBe('ok');
  });

  it('服务重启过：410 → 预览失效', async () => {
    const { impl } = fakeFetch(() => Promise.resolve({ status: 410, body: { ok: false, error: { code: 'expired', message: '工坊服务重启过，未确认的预览已失效' } } }));
    const client = new WorkshopClient(impl, '/api/workshop', ids());
    expect(await client.confirm('gen-0001', 1, 'svc-1')).toEqual({ kind: 'expired', message: '工坊服务重启过，未确认的预览已失效' });
  });
});

describe('收到的关卡', () => {
  it('布局按 schema 解析、哈希核对；对不上时拒绝', () => {
    const ok = packageOfWire(LEVEL);
    expect(ok.ok && ok.pkg).toMatchObject({ source: 'model', layoutHash: LEVEL.layoutHash, key: `preview:${LEVEL.layoutHash}` });
    expect(packageOfWire({ ...LEVEL, layoutHash: '0000000000000000' })).toMatchObject({ ok: false });
    expect(packageOfWire({ ...LEVEL, layout: { nonsense: true } })).toMatchObject({ ok: false });
    expect(packageOfWire({ ...LEVEL, rules: { ...LEVEL.rules, timeLimit: LEVEL.rules.timeLimit + 1 } })).toMatchObject({ ok: false });
  });
});
