// 关卡生成（P5）：固定的种子集合、确定性、已知的失败样例、时间推算、“随机一关”的回退、性能。

import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkLevel } from '../../src/game/level/gen/checker';
import { GEN_CONFIG, TIERS, type Tier } from '../../src/game/level/gen/config';
import { generateLayout } from '../../src/game/level/gen/generator';
import { produceLevel, type ProduceResult } from '../../src/game/level/gen/pipeline';
import { canonicalJson } from '../../src/game/level/gen/random';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { decideTimeLimit, routeTime, tightestFactor } from '../../src/game/level/gen/timing';
import { parseLevel } from '../../src/game/level/schema';
import { RandomLevelJob, type RandomJobState } from '../../src/game/levels/randomJob';
import { fallbackPackage } from '../../src/game/levels/catalog';
import { SPEC } from '../../src/game/spec';
import { brief, handmade } from '../helpers/levels';

type GenConfig = typeof GEN_CONFIG;

function withConfig(change: (c: GenConfig) => GenConfig): GenConfig {
  return change(structuredClone<GenConfig>(GEN_CONFIG));
}

const SEEDS_PER_TIER = 200;
const summary: string[] = [];

afterAll(() => {
  if (summary.length > 0) console.log(summary.join('\n'));
});

describe(`固定的种子集合（每个档位 ${String(SEEDS_PER_TIER)} 个种子）`, () => {
  for (const tier of TIERS) {
    it(`${tier}：交给玩家的关卡全部通过硬检查；失败时只有明确、有限次的回退`, () => {
      const counts: Record<string, number> = {};
      for (let s = 0; s < SEEDS_PER_TIER; s++) {
        const input = randomBrief(`set-${tier}-${String(s)}`, [], { tier });
        const result: ProduceResult = produceLevel(input, `level-${tier}-${String(s)}`);
        const key = result.ok ? (result.level.adjustment ? 'adjusted' : 'ok') : result.kind;
        counts[key] = (counts[key] ?? 0) + 1;
        if (result.ok) {
          // 交给玩家的关卡：独立地再检查一遍（按最终的说明书），并且能通过 parseLevel
          const report = checkLevel(result.level.layout, { brief: result.level.brief });
          expect(report.problems, `种子 ${String(s)}`).toEqual([]);
          expect(parseLevel(result.level.layout)).toEqual(result.level.layout);
          expect(result.level.timeLimit).toBe(result.level.layout.timeLimit);
          expect(result.level.attempts).toBeLessThanOrEqual(2 * GEN_CONFIG.generator.attempts);
        } else {
          // 失败只能是“放不下”或“太远”（有限次尝试 + 最多一次调整之后），不能是检查器拒绝（程序缺陷）
          expect(['cannot-fit', 'too-far'], `种子 ${String(s)}：${JSON.stringify(result)}`).toContain(result.kind);
          if (result.kind === 'cannot-fit' || result.kind === 'too-far') {
            expect(result.message.length).toBeGreaterThan(0);
            expect(result.attempts).toBeLessThanOrEqual(2 * GEN_CONFIG.generator.attempts);
          }
        }
      }
      summary.push(`${tier}：${JSON.stringify(counts)}`);
      expect(counts.rejected ?? 0).toBe(0);
    });
  }
});

describe('确定性', () => {
  it('种子、说明书和生成器版本都相同时，布局也相同；随机数只来自种子（不用 Math.random 或墙钟）', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('不应该调用 Math.random');
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('不应该读墙钟');
    });
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('不应该读墙钟');
    });
    try {
      for (const tier of TIERS) {
        const input = randomBrief(`det-${tier}`, [], { tier });
        const a = produceLevel(input, 'same-seed');
        const b = produceLevel(input, 'same-seed');
        expect(canonicalJson(a)).toBe(canonicalJson(b));
        const c = produceLevel(input, 'other-seed');
        if (a.ok && c.ok) expect(canonicalJson(a.level.layout)).not.toBe(canonicalJson(c.level.layout));
      }
    } finally {
      random.mockRestore();
      now.mockRestore();
      perf.mockRestore();
    }
  });

  it('每次尝试用由种子派生的子种子：同一个子种子单独生成得到同样的布局', () => {
    const input = brief({ tier: 'small', collectibles: 3, guards: 1, platforms: 1 });
    const parsed = produceLevel(input, 'root');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const direct = generateLayout(parsed.level.brief, `root/attempt-${String(parsed.level.attempts - 1)}`);
    expect(direct.ok && direct.layout.boxes).toEqual(parsed.level.layout.boxes);
  });
});

describe('已知的失败样例', () => {
  it('elevated 配 0 个高台：组合冲突（说明书错误，不生成）', () => {
    const result = produceLevel(brief({ distribution: 'elevated', platforms: 0 }), 'x');
    expect(result).toMatchObject({ ok: false, kind: 'brief' });
    if (!result.ok && result.kind === 'brief') expect(result.problems[0]?.message).toContain('高台数量是 0');
  });

  it('小地图配上限数量的收集点、高密度障碍（再加高台和守卫）：放不下，有限次（8 次）尝试后返回原因', () => {
    const crowded = brief({ tier: 'small', density: 'high', collectibles: GEN_CONFIG.tiers.small.collectibles.max, platforms: 2, guards: 1 });
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const result = produceLevel(crowded, seed, { adjust: false });
      expect(result.ok).toBe(false);
      if (result.ok || result.kind !== 'cannot-fit') throw new Error(`应该放不下：${JSON.stringify(result)}`);
      expect(result.attempts).toBe(GEN_CONFIG.generator.attempts);
      expect(result.message).toContain('放不下');
      expect(result.message).toContain('可以减少数量或换成更大的地图档位');
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('放不下时的程序调整：障碍密度降一档（high → mid），记下原因和调整后的说明书', () => {
    const crowded = brief({ tier: 'small', density: 'high', collectibles: GEN_CONFIG.tiers.small.collectibles.max, platforms: 2, guards: 1 });
    const result = produceLevel(crowded, 'a');
    const adjustment = result.ok ? result.level.adjustment : result.kind !== 'brief' ? result.adjustment : null;
    expect(adjustment).toMatchObject({ reason: 'cannot-fit', change: '障碍密度 high → mid', from: { density: 'high' }, to: { density: 'mid' } });
    if (result.ok) {
      expect(result.level.brief.density).toBe('mid');
      expect(result.level.requestedBrief.density).toBe('high');
      expect(checkLevel(result.level.layout, { brief: result.level.brief }).ok).toBe(true);
    }
  });

  it('路线时间超过档位上限：太远（不截断到上限）；调整只把收集点减到下限一次，还太远就返回太远', () => {
    // 把 small 的时间上限压到 21 秒：任何路线按最紧的系数加余量都超过它
    const config = withConfig((c) => ({ ...c, tiers: { ...c.tiers, small: { ...c.tiers.small, timeLimit: { min: 10, max: 21 } } } }));
    const input = brief({ tier: 'small', density: 'low', collectibles: 4, platforms: 0, guards: 0 });
    const plain = produceLevel(input, 'far', { adjust: false, config });
    expect(plain).toMatchObject({ ok: false, kind: 'too-far' });
    if (!plain.ok && plain.kind === 'too-far') expect(plain.message).toContain('太远');
    const adjusted = produceLevel(input, 'far', { config });
    expect(adjusted).toMatchObject({
      ok: false,
      kind: 'too-far',
      adjustment: { reason: 'too-far', change: `收集点数 4 → ${String(GEN_CONFIG.tiers.small.collectibles.min)}（档位范围的下限）` },
    });
    // 已经是下限时不调整
    const atMinimum = produceLevel({ ...input, collectibles: GEN_CONFIG.tiers.small.collectibles.min }, 'far', { config });
    expect(atMinimum).toMatchObject({ ok: false, kind: 'too-far', adjustment: null });
  });
});

describe('时间推算', () => {
  it('公式：timeLimit = 把（T × 系数 + 余量）向上取整，再限制在档位的上下限之间', () => {
    const m = GEN_CONFIG.timing.margin;
    const k = GEN_CONFIG.timing.intent;
    const small = GEN_CONFIG.tiers.small.timeLimit;
    expect(decideTimeLimit(20, 'normal', 'small')).toEqual({ ok: true, timeLimit: Math.ceil(20 * k.normal + m), raw: 20 * k.normal + m, routeSeconds: 20 });
    expect(decideTimeLimit(20, 'relaxed', 'small')).toMatchObject({ ok: true, timeLimit: Math.ceil(20 * k.relaxed + m) });
    // 太短：截到下限
    expect(decideTimeLimit(1, 'tense', 'small')).toMatchObject({ ok: true, timeLimit: small.min });
    // 本关的系数会超过上限、但最紧的系数不超过：截到上限（不是“太远”）
    const t = (small.max - m) / k.relaxed + 1;
    expect(t * tightestFactor() + m).toBeLessThanOrEqual(small.max);
    expect(decideTimeLimit(t, 'relaxed', 'small')).toMatchObject({ ok: true, timeLimit: small.max });
    // 最紧的系数也超过上限：太远，不截断
    const far = (small.max - m) / tightestFactor() + 0.5;
    const decision = decideTimeLimit(far, 'relaxed', 'small');
    expect(decision).toMatchObject({ ok: false, reason: 'too-far' });
    expect(decision).not.toHaveProperty('timeLimit');
  });

  it('系数、余量、上下限都在配置里：换一份配置，结果按新配置算', () => {
    const config = withConfig((c) => ({ ...c, timing: { ...c.timing, margin: 5, intent: { relaxed: 3, normal: 2, tense: 1 } } }));
    expect(decideTimeLimit(20, 'normal', 'medium', config)).toMatchObject({ ok: true, timeLimit: 45 });
  });

  it('路线时间 T：每次去最近的（按检查器网格的路径长度）还没收集的收集点，按跑速算', () => {
    // 出生点 (0, −8)；收集点 a 在 (0, −2)、b 在 (0, 8)、c 在 (6, −2)。最近的依次是 a、c、b
    const layout = handmade({
      collectibles: [
        { id: 'b', position: { x: 0, z: 8 } },
        { id: 'a', position: { x: 0, z: -2 } },
        { id: 'c', position: { x: 6, z: -2 } },
      ],
      target: 3,
    });
    const report = checkLevel(layout);
    expect(report.ok).toBe(true);
    const route = routeTime(report);
    expect(route?.order).toEqual(['a', 'c', 'b']);
    // 直线距离约 6 − 0.8 + 6 + √(36 + 100) − 0.8 左右；网格路径不短于直线、略长于直线
    const straight = 6 + 6 + Math.hypot(6, 10) - 3 * SPEC.collect.radius;
    expect(route?.distance).toBeGreaterThan(straight - 0.5);
    expect(route?.distance).toBeLessThan(straight + 2);
    expect(route?.seconds).toBeCloseTo((route?.distance ?? 0) / SPEC.move.runSpeed, 9);
  });

  it('人工构造的布局：路线时间超过档位上限时判为太远', () => {
    // 一条蛇形的长走廊，路线很长
    const walls = [-6, -2, 2, 6].map((z, i) => ({
      id: `w${String(i)}`,
      center: { x: i % 2 === 0 ? -1.5 : 1.5, z },
      size: { x: 17, z: 0.5 },
      height: 2,
    }));
    const layout = handmade({ boxes: walls });
    const report = checkLevel(layout);
    expect(report.ok).toBe(true);
    const route = routeTime(report);
    expect(route).not.toBeNull();
    const config = withConfig((c) => ({ ...c, tiers: { ...c.tiers, small: { ...c.tiers.small, timeLimit: { min: 10, max: 25 } } } }));
    const decision = decideTimeLimit(route?.seconds ?? 0, 'normal', 'small', config);
    expect((route?.seconds ?? 0) * tightestFactor(config) + config.timing.margin).toBeGreaterThan(25);
    expect(decision).toMatchObject({ ok: false, reason: 'too-far' });
  });
});

describe('随机一关', () => {
  function runJob(seed: string, produce?: typeof produceLevel): RandomJobState[] {
    const states: RandomJobState[] = [];
    const queue: (() => void)[] = [];
    const job = new RandomLevelJob(
      {
        seed,
        people: [],
        schedule: (step) => queue.push(step),
        ...(produce ? { produce } : {}),
      },
      (state) => states.push(state),
    );
    job.start();
    while (queue.length > 0) queue.shift()?.();
    return states;
  }

  it('成功时给出预览，预览的关卡通过硬检查', () => {
    for (let s = 0; s < 30; s++) {
      const states = runJob(`job-${String(s)}`);
      const last = states.at(-1);
      expect(['preview', 'failed']).toContain(last?.kind);
      if (last?.kind === 'preview') expect(checkLevel(last.pkg.layout, { brief: last.pkg.brief ?? undefined }).ok).toBe(true);
    }
  });

  it('尝试的说明书份数有上限；全部失败就由调用方加载回退关卡（回退关卡通过硬检查）', () => {
    let calls = 0;
    const states = runJob('fail', () => {
      calls++;
      return { ok: false, kind: 'cannot-fit', message: '放不下', reasons: [], attempts: 8, adjustment: null };
    });
    expect(calls).toBe(GEN_CONFIG.random.briefs);
    expect(states.at(-1)).toMatchObject({ kind: 'failed', tried: GEN_CONFIG.random.briefs });
    const fallback = fallbackPackage();
    expect(fallback.key).toBe('builtin:gen-1');
    expect(checkLevel(fallback.layout, { brief: fallback.brief ?? undefined }).ok).toBe(true);
  });

  it('取消：结束这次生成，不再继续，也不进入“全部失败”（不加载回退关卡）', () => {
    const states: RandomJobState[] = [];
    const queue: (() => void)[] = [];
    let calls = 0;
    const job = new RandomLevelJob(
      {
        seed: 'cancel',
        people: [],
        schedule: (step) => queue.push(step),
        produce: () => {
          calls++;
          return { ok: false, kind: 'cannot-fit', message: '放不下', reasons: [], attempts: 8, adjustment: null };
        },
      },
      (state) => states.push(state),
    );
    job.start();
    queue.shift()?.(); // 第一份说明书
    job.cancel();
    while (queue.length > 0) queue.shift()?.();
    expect(calls).toBe(1);
    expect(states.at(-1)).toEqual({ kind: 'cancelled', tried: 1 });
    expect(states.some((s) => s.kind === 'failed')).toBe(false);
  });
});

describe('性能', () => {
  it('large 档位一次“随机一关”（含所有尝试、检查和时间推算）不超过 5 秒（宽松的上限）', () => {
    const times: number[] = [];
    for (let s = 0; s < 5; s++) {
      const start = performance.now();
      const input = randomBrief(`perf-${String(s)}`, [], { tier: 'large' as Tier });
      produceLevel({ ...input, density: 'high', collectibles: GEN_CONFIG.tiers.large.collectibles.max, guards: GEN_CONFIG.tiers.large.maxGuards }, `perf-${String(s)}`);
      times.push(performance.now() - start);
    }
    summary.push(`large（高密度、上限数量的收集点和守卫）一次生成 + 检查 + 时间推算：${times.map((t) => t.toFixed(0)).join('、')} ms`);
    for (const t of times) expect(t).toBeLessThan(5000);
  });
});
