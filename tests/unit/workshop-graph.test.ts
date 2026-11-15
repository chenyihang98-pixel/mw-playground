// 关卡工坊的流程（P8）：用假模型（按固定顺序返回预设的回复）驱动 LangGraph 流程和请求管理。
// 覆盖：一次通过；坏 JSON、越界的值、elevated 配 0 个高台、不存在的人物、不允许的分工修复后通过；三次都失败回退；
// 放不下时程序调整后通过；程序缺陷不交给模型；超时算服务错误并回退；取消不回退；忙；
// 确认时保存的就是预览的那份布局、不再调用模型，重复确认只定稿一次；服务重启后预览失效；统计每个请求只记一条。

import { describe, expect, it } from 'vitest';
import { type Brief } from '../../src/game/level/gen/brief';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { produceLevel } from '../../src/game/level/gen/pipeline';
import { deriveSeed } from '../../src/game/level/gen/random';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { FALLBACK_LEVEL_ID } from '../../src/game/level/generatedLevels';
import type { GenerateRequest, RosterPersonSnapshot } from '../../src/workshop/protocol';
import { loadConfig, type WorkshopConfig } from '../../server/config';
import { WorkshopError } from '../../server/errors';
import { FakeProvider, type FakeScript } from '../../server/fakeProvider';
import { createLogger } from '../../server/log';
import { Redactor } from '../../server/errors';
import type { LlmProvider } from '../../server/providers';
import { MemoryStats, summarize } from '../../server/stats';
import { Workshop } from '../../server/workshop';

const ALICE = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const roster: RosterPersonSnapshot[] = [
  { id: ALICE, name: '小兵', roles: ['companion', 'guard'] },
  { id: BOB, name: '星璇', roles: ['companion'] },
];

function config(overrides: Record<string, string> = {}): WorkshopConfig {
  // F2：加载模型的超时不能大于整个请求的超时（默认 150 秒），这里跟着调短
  const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', MW_WORKSHOP_CALL_TIMEOUT_MS: '2000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '20000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '10000', ...overrides });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  return loaded.config;
}

/** 一份合法的说明书（中地图、2 个高台、宝石只放在高台上）。 */
function validBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    schemaVersion: 1,
    tier: 'medium',
    density: 'low',
    platforms: 2,
    collectibles: 4,
    distribution: 'elevated',
    guards: 1,
    patrol: 'loop',
    intent: 'normal',
    visual: { theme: 'grass', time: 'night', weather: 'rain' },
    title: '雨夜高台',
    opening: '宝石都在高台上。',
    cast: [{ personId: 'r2', role: 'companion', line: '我跟着你。' } as unknown as Brief['cast'][number]],
    ...overrides,
  };
}

interface Harness {
  readonly workshop: Workshop;
  readonly provider: FakeProvider;
  readonly stats: MemoryStats;
  readonly logs: string[];
}

function harness(script: FakeScript, options: { config?: WorkshopConfig; seed?: string; produce?: typeof produceLevel; serviceId?: string } = {}): Harness {
  const provider = new FakeProvider(script);
  const stats = new MemoryStats();
  const logs: string[] = [];
  const workshop = new Workshop({
    config: options.config ?? config(),
    provider,
    stats,
    log: createLogger(new Redactor([]), (line) => logs.push(line)),
    newSeed: () => options.seed ?? 'seed-1',
    produce: options.produce,
    serviceId: options.serviceId,
  });
  return { workshop, provider, stats, logs };
}

let counter = 0;
function request(text = '想要一个下雨的夜晚，宝石都放在高台上，让星璇跟着我。'): GenerateRequest {
  counter++;
  return { generationId: `gen-${String(counter).padStart(4, '0')}`, text, roster };
}

describe('一次通过', () => {
  it('模型首次就写出合法的说明书：出预览；确认后定稿的就是预览的那份布局，确认时不再调用模型', async () => {
    const h = harness({ briefs: [{ kind: 'json', value: validBrief() }] });
    const res = await h.workshop.generate(request());
    if (res.status !== 'preview') throw new Error(`应该出预览：${JSON.stringify(res)}`);
    expect(res.preview.outcome).toBe('model-first');
    expect(res.preview.repairs).toBe(0);
    expect(res.preview.level.source).toBe('model');
    // 代号 r2 换回了人物 ID
    expect(res.preview.level.brief.cast).toEqual([{ personId: BOB, role: 'companion', line: '我跟着你。' }]);
    expect(h.provider.calls).toEqual({ chat: 1, structured: 1 });
    // 结构化输出：把说明书的 JSON Schema 交给模型
    expect(h.provider.schemas[0]).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((h.provider.schemas[0] as { properties: object }).properties)).toContain('distribution');

    const final = await h.workshop.confirm({ generationId: res.generationId, version: res.version, serviceId: res.serviceId });
    expect(final.duplicate).toBe(false);
    expect(final.level.layoutHash).toBe(res.preview.level.layoutHash);
    expect(final.level.seed).toBe(res.preview.level.seed);
    expect(final.level).toEqual(res.preview.level);
    // interrupt 恢复后，预览之前的节点没有再执行：模型调用次数不变
    expect(h.provider.calls).toEqual({ chat: 1, structured: 1 });
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['model-first']);
  });

  it('连续确认两次（包括同时确认）：只定稿一次，返回同一份结果', async () => {
    const h = harness({});
    const res = await h.workshop.generate(request());
    if (res.status !== 'preview') throw new Error('应该出预览');
    const ref = { generationId: res.generationId, version: res.version, serviceId: res.serviceId };
    const [a, b] = await Promise.all([h.workshop.confirm(ref), h.workshop.confirm(ref)]);
    const c = await h.workshop.confirm(ref);
    expect([a.duplicate, b.duplicate, c.duplicate].filter((d) => !d)).toHaveLength(1);
    expect(new Set([a, b, c].map((r) => r.level.layoutHash)).size).toBe(1);
    expect(h.provider.calls).toEqual({ chat: 1, structured: 1 });
    expect(h.stats.records).toHaveLength(1);
  });

  it('“理解请求”可以调用查名册快照的工具；工具只返回快照里的人物（代号），其他工具不执行', async () => {
    const h = harness({ understand: [{ kind: 'tool', name: 'lookup_roster' }, { kind: 'text', text: '雨夜，星璇当同伴。' }] });
    const res = await h.workshop.generate(request());
    expect(res.status).toBe('preview');
    expect(h.provider.calls.chat).toBe(2);
    expect(h.provider.prompts[1]).toContain('代号 r2：星璇');
    expect(h.provider.prompts[1]).not.toContain(BOB);
    // 写说明书时带上了理解的结果
    expect(h.provider.prompts[2]).toContain('雨夜，星璇当同伴。');

    const other = harness({ understand: [{ kind: 'tool', name: 'delete_everything' }, { kind: 'text', text: '好的。' }] });
    await other.workshop.generate(request());
    expect(other.provider.prompts[1]).toContain('没有工具 delete_everything');
  });
});

describe('出错后修复', () => {
  const cases: [string, FakeScript['briefs'], string][] = [
    ['坏 JSON', [{ kind: 'raw', text: '{"schemaVersion": 1, "tier": "medium",' }], '不是合法的 JSON'],
    ['越界的值', [{ kind: 'json', value: validBrief({ platforms: 9 }) }], 'platforms'],
    ['elevated 配 0 个高台', [{ kind: 'json', value: validBrief({ platforms: 0 }) }], '高台数量是 0'],
    ['不存在的人物', [{ kind: 'json', value: validBrief({ cast: [{ personId: 'r9', role: 'companion', line: '' }] }) }], '不在名册里'],
    ['不允许的分工', [{ kind: 'json', value: validBrief({ cast: [{ personId: 'r2', role: 'guard', line: '' }] }) }], '不能当守卫'],
  ];
  for (const [name, briefs, problem] of cases) {
    it(`${name}：把具体原因交回模型，修复后通过`, async () => {
      const h = harness({ briefs: [...(briefs ?? []), { kind: 'json', value: validBrief() }] });
      const res = await h.workshop.generate(request());
      if (res.status !== 'preview') throw new Error(`应该出预览：${JSON.stringify(res)}`);
      expect(res.preview.outcome).toBe('model-repaired');
      expect(res.preview.repairs).toBe(1);
      expect(res.preview.history[0]).toContain(problem);
      expect(h.provider.calls.structured).toBe(2);
      // 修复时的提示里有上一次的原因（人物 ID 换成了代号）
      const repairPrompt = h.provider.prompts.at(-1) ?? '';
      expect(repairPrompt).toContain(problem);
      expect(repairPrompt).not.toContain(BOB);
      expect(h.stats.records.map((r) => [r.outcome, r.repairs])).toEqual([['model-repaired', 1]]);
    });
  }
});

describe('三次都失败', () => {
  it('模型写了 3 次都不合规：回退到内置关卡，说明原因和差别；统计记为回退（不算模型成功）', async () => {
    const bad = { kind: 'json' as const, value: validBrief({ platforms: 0 }) };
    const h = harness({ briefs: [bad, bad, bad, { kind: 'json', value: validBrief() }] });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error(`应该回退：${JSON.stringify(res)}`);
    expect(res.fallback.outcome).toBe('fallback');
    expect(res.fallback.fallbackId).toBe(FALLBACK_LEVEL_ID);
    expect(res.fallback.reason).toContain('3 次');
    expect(res.fallback.history).toHaveLength(3);
    expect(res.fallback.differences.length).toBeGreaterThan(0);
    expect(h.provider.calls.structured).toBe(3); // 首次 1 次 + 修复 2 次，第 4 份预设的回复没有用到
    expect(h.stats.records.map((r) => [r.outcome, r.repairs, r.briefAttempts])).toEqual([['fallback', 2, 3]]);
    expect(summarize(h.stats.records.map((r) => JSON.stringify(r))).counts).toMatchObject({ fallback: 1, 'model-first': 0, 'model-repaired': 0 });
  });
});

describe('放不下', () => {
  it('放不下时先走 P5 的有限次尝试和程序调整：调整后通过，预览说明改了什么', async () => {
    const crowded = validBrief({ tier: 'small', density: 'high', collectibles: GEN_CONFIG.tiers.small.collectibles.max, platforms: 2, guards: 1, distribution: 'scattered', cast: [] });
    // 找一个根种子：它派生出的第 1 次种子需要调整，调整后能生成
    const seed = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].find((s) => {
      const r = produceLevel(crowded, deriveSeed(s, 'brief-1'));
      return r.ok && r.level.adjustment !== null;
    });
    if (!seed) throw new Error('没有找到需要调整的种子');
    const h = harness({ briefs: [{ kind: 'json', value: crowded }] }, { seed });
    const res = await h.workshop.generate(request('小地图，宝石越多越好，障碍也要多'));
    if (res.status !== 'preview') throw new Error(`应该出预览：${JSON.stringify(res)}`);
    expect(res.preview.outcome).toBe('program-adjusted');
    expect(res.preview.adjustment?.change).toBe('障碍密度 high → mid');
    expect(res.preview.differences).toContain('障碍：多 → 中');
    expect(res.preview.level.adjustment?.reason).toBe('cannot-fit');
    expect(h.provider.calls.structured).toBe(1);
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['program-adjusted']);
  });

  it('调整后还放不下：把能照着改的原因交回模型', async () => {
    const produce: typeof produceLevel = (input, seed, options) => {
      const brief = input as Brief;
      if (brief.tier === 'small') return { ok: false, kind: 'cannot-fit', message: '放不下：small 地图试了 8 次都放不下', reasons: [], attempts: 16, adjustment: null };
      return produceLevel(input, seed, options);
    };
    const h = harness({ briefs: [{ kind: 'json', value: validBrief({ tier: 'small', collectibles: 4, platforms: 2 }) }, { kind: 'json', value: validBrief() }] }, { produce });
    const res = await h.workshop.generate(request());
    if (res.status !== 'preview') throw new Error(`应该出预览：${JSON.stringify(res)}`);
    expect(res.preview.outcome).toBe('model-repaired');
    expect(h.provider.prompts.at(-1)).toContain('放不下：small 地图试了 8 次都放不下');
  });
});

describe('程序缺陷', () => {
  it('检查器拒绝了生成器做出的布局：记录为错误，不交给模型，回退；统计记为服务错误', async () => {
    const produce: typeof produceLevel = () => ({ ok: false, kind: 'rejected', problems: [{ category: 'layout', code: 'x', message: '巡逻路线穿墙' }], attempts: 1, adjustment: null });
    const h = harness({}, { produce });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error('应该回退');
    expect(res.fallback.outcome).toBe('error');
    expect(res.fallback.reason).toContain('程序缺陷');
    expect(h.provider.calls.structured).toBe(1); // 没有交回模型修改
    expect(h.logs.some((l) => l.includes('ERROR') && l.includes('程序缺陷'))).toBe(true);
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['error']);
  });
});

describe('超时、取消、忙', () => {
  it('单次模型调用超时：算作服务错误，回退到内置关卡', async () => {
    const h = harness({ briefs: [{ kind: 'hang' }] }, { config: config({ MW_WORKSHOP_CALL_TIMEOUT_MS: '200' }) });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error('应该回退');
    expect(res.fallback.outcome).toBe('error');
    expect(res.fallback.reason).toContain('超时');
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['error']);
  });

  it('整个请求超时：算作服务错误，回退', async () => {
    const h = harness({ briefs: [{ kind: 'hang' }] }, { config: config({ MW_WORKSHOP_CALL_TIMEOUT_MS: '5000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' }) });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error('应该回退');
    expect(res.fallback.reason).toContain('整个生成请求超时');
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['error']);
  });

  it('取消：结束这次请求，中止模型调用；不回退，统计记为取消', async () => {
    const h = harness({ briefs: [{ kind: 'hang' }] });
    const req = request();
    const pending = h.workshop.generate(req);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.workshop.busy).toBe(true);
    // 同一时间只处理一个：新的请求直接返回“忙”
    await expect(h.workshop.generate(request())).rejects.toMatchObject({ code: 'busy' });
    expect(h.workshop.cancel(req.generationId)).toBe(true);
    const res = await pending;
    expect(res.status).toBe('cancelled');
    expect(h.workshop.busy).toBe(false);
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['cancelled']);
    // “忙”被拒绝的那个请求没有统计
    expect(h.stats.records).toHaveLength(1);
  });

  it('同一个生成标识不能再用；一句话超过上限被拒绝', async () => {
    const h = harness({}, { config: config({ MW_WORKSHOP_MAX_REQUEST_CHARS: '10' }) });
    await expect(h.workshop.generate(request('这一句话明显超过了十个字的上限'))).rejects.toBeInstanceOf(WorkshopError);
    const req = request('短句');
    await h.workshop.generate(req);
    await expect(h.workshop.generate(req)).rejects.toMatchObject({ code: 'bad-request' });
    expect(h.stats.records).toHaveLength(1);
  });
});

describe('预览会话', () => {
  it('服务重启后（服务标识不同），未确认的预览失效；版本号对不上时拒绝；放弃后不能再确认', async () => {
    const h = harness({});
    const res = await h.workshop.generate(request());
    if (res.status !== 'preview') throw new Error('应该出预览');
    await expect(h.workshop.confirm({ generationId: res.generationId, version: res.version, serviceId: 'another-process' })).rejects.toMatchObject({ code: 'expired' });
    await expect(h.workshop.confirm({ generationId: res.generationId, version: res.version + 1, serviceId: res.serviceId })).rejects.toMatchObject({ code: 'stale' });
    await h.workshop.discard(res.generationId);
    await expect(h.workshop.confirm({ generationId: res.generationId, version: res.version, serviceId: res.serviceId })).rejects.toMatchObject({ code: 'expired' });
    // 新的服务进程（新的 Workshop）不认识旧的预览
    const restarted = harness({});
    await expect(restarted.workshop.confirm({ generationId: res.generationId, version: res.version, serviceId: res.serviceId })).rejects.toMatchObject({ code: 'expired' });
  });

  it('默认的假模型（预设回复用完后）按请求文字写出合法的说明书', async () => {
    const h = harness({});
    const res = await h.workshop.generate(request('随便来一关'));
    expect(res.status).toBe('preview');
    expect(randomBrief('x').schemaVersion).toBe(1);
  });
});

describe('第 1 轮审查：异常路径也只记一条、记全', () => {
  /** 生成前检查模型可用时一直等到被中止（被中止时像 Ollama 那样报“不可用”）；其余和假模型一样。 */
  function slowAvailability(): LlmProvider {
    const fake = new FakeProvider({});
    return {
      name: fake.name,
      model: fake.model,
      chat: (m, t, s) => fake.chat(m, t, s),
      structured: (m, schema, s) => fake.structured(m, schema, s),
      prepare: (s) => fake.prepare(s),
      availability: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ available: false, reason: '连不上 Ollama' });
          });
        }),
    };
  }

  function slowHarness(env: Record<string, string> = {}) {
    const provider = slowAvailability();
    const stats = new MemoryStats();
    const workshop = new Workshop({ config: config(env), provider, stats, log: createLogger(new Redactor([]), () => undefined) });
    return { provider, stats, workshop };
  }

  it('生成前检查模型可用时被取消：记为取消（不是“不可用”），不回退', async () => {
    const h = slowHarness();
    const req = request();
    const pending = h.workshop.generate(req);
    await new Promise((r) => setTimeout(r, 30));
    h.workshop.cancel(req.generationId);
    const res = await pending;
    expect(res.status).toBe('cancelled');
    expect(h.stats.records.map((r) => [r.outcome, r.briefAttempts, r.modelCalls])).toEqual([['cancelled', 0, 0]]);
  });

  it('生成前检查模型可用时整个请求超时：服务错误并回退（不是“不可用”）', async () => {
    const h = slowHarness({ MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error(`应该回退：${JSON.stringify(res)}`);
    expect(res.fallback).toMatchObject({ outcome: 'error', reason: '整个生成请求超时（1 秒）' });
    expect(res.fallback.differences[0]).toContain('不是按你的描述做的');
    expect(h.stats.records.map((r) => r.outcome)).toEqual(['error']);
  });

  it('刚受理就取消（还没有检查点）：响应是取消，统计也记一次取消', async () => {
    const h = harness({});
    const req = request();
    const pending = h.workshop.generate(req);
    h.workshop.cancel(req.generationId);
    expect((await pending).status).toBe('cancelled');
    expect(h.stats.records.map((r) => [r.outcome, r.briefAttempts, r.repairs])).toEqual([['cancelled', 0, 0]]);
    expect(h.logs.some((l) => l.includes('统计没有写进去'))).toBe(false);
  });

  it('修复时超时：已经开始的那次尝试和它的耗时都算进统计', async () => {
    const h = harness({ briefs: [{ kind: 'raw', text: '{oops' }, { kind: 'hang' }] }, { config: config({ MW_WORKSHOP_CALL_TIMEOUT_MS: '300' }) });
    const res = await h.workshop.generate(request());
    if (res.status !== 'fallback') throw new Error('应该回退');
    expect(res.fallback.outcome).toBe('error');
    expect(h.provider.calls.structured).toBe(2);
    const record = h.stats.records[0];
    expect(record).toMatchObject({ outcome: 'error', briefAttempts: 2, repairs: 1, modelCalls: 3 });
    expect(record?.timingsMs.brief).toBeGreaterThanOrEqual(250);
    expect(record?.timingsMs.understand).toBeGreaterThanOrEqual(0);
    expect(record?.timingsMs.validate).toBeGreaterThanOrEqual(0);
  });

  it('理解请求超时：这一步的耗时也算进统计', async () => {
    const h = harness({ understand: [{ kind: 'hang' }] }, { config: config({ MW_WORKSHOP_CALL_TIMEOUT_MS: '300' }) });
    const res = await h.workshop.generate(request());
    expect(res.status).toBe('fallback');
    expect(h.stats.records[0]).toMatchObject({ outcome: 'error', briefAttempts: 0, modelCalls: 1 });
    expect(h.stats.records[0]?.timingsMs.understand).toBeGreaterThanOrEqual(250);
  });
});

