// 关卡说明书（P5）：schema（带 schemaVersion，不含坐标和时间限制）、组合规则（具体、能照着改的原因，不悄悄改值）、
// 随机说明书只产出合法的组合，并且只由种子决定。

import { describe, expect, it, vi } from 'vitest';
import { briefSchema, parseBrief, type Brief } from '../../src/game/level/gen/brief';
import { GEN_CONFIG, TIERS } from '../../src/game/level/gen/config';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { brief } from '../helpers/levels';

function problemsOf(input: unknown, roster?: ReadonlySet<string>) {
  const result = parseBrief(input, roster);
  return result.ok ? [] : result.problems;
}

describe('schema', () => {
  it('合法的说明书原样通过（只去掉文字首尾的空白），带 schemaVersion', () => {
    const result = parseBrief(brief({ title: '  标题  ', opening: ' 开场白 ' }));
    expect(result).toMatchObject({ ok: true, brief: { schemaVersion: 1, title: '标题', opening: '开场白' } });
  });

  it('不含时间限制，也不含任何坐标：多余的字段一律拒绝', () => {
    for (const extra of [{ timeLimit: 60 }, { spawn: { x: 0, z: 0 } }, { collectiblePositions: [{ x: 1, z: 2 }] }, { size: { width: 30, depth: 30 } }]) {
      expect(problemsOf({ ...brief(), ...extra }).length).toBeGreaterThan(0);
    }
    expect(Object.keys(briefSchema.shape)).not.toContain('timeLimit');
    expect(Object.keys(briefSchema.shape).some((k) => /x|z|position|spawn|coord/i.test(k) && k !== 'cast')).toBe(false);
  });

  it('认不出的 schemaVersion：说明书错误', () => {
    expect(problemsOf({ ...brief(), schemaVersion: 2 })).toEqual([{ path: 'schemaVersion', message: '说明书版本（2）认不出：本版只认 schemaVersion 1' }]);
  });

  it('枚举值只能取列出的值：视觉预设只有 grass / sand / snow、day / dusk / night、clear / fog / rain', () => {
    expect(problemsOf(brief({ visual: { theme: 'grass', time: 'day', weather: 'clear' } }))).toEqual([]);
    expect(problemsOf({ ...brief(), visual: { theme: 'lava', time: 'day', weather: 'clear' } }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...brief(), visual: { theme: 'grass', time: 'noon', weather: 'clear' } }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...brief(), visual: { theme: 'grass', time: 'day', weather: 'snowstorm' } }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...brief(), tier: 'huge' }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...brief(), platforms: 5 }).length).toBeGreaterThan(0);
  });

  it('标题、开场白、台词有长度上限', () => {
    expect(problemsOf(brief({ title: 'x'.repeat(GEN_CONFIG.brief.titleMaxLength + 1) })).length).toBeGreaterThan(0);
    expect(problemsOf(brief({ opening: 'x'.repeat(GEN_CONFIG.brief.openingMaxLength + 1) })).length).toBeGreaterThan(0);
    const cast = [{ personId: 'a'.repeat(64), role: 'companion' as const, line: 'x'.repeat(GEN_CONFIG.brief.lineMaxLength + 1) }];
    expect(problemsOf(brief({ cast })).length).toBeGreaterThan(0);
  });
});

describe('组合规则：说明书错误返回具体、能照着改的原因，不悄悄改值', () => {
  it('elevated 但高台数为 0', () => {
    expect(problemsOf(brief({ distribution: 'elevated', platforms: 0 }))).toEqual([
      { path: 'distribution', message: '收集点分布是 elevated（只放在高台上），但高台数量是 0：把高台数量改成 1–4，或换一种分布' },
    ]);
  });

  it('elevated 时每个高台最多 2 个收集点', () => {
    expect(problemsOf(brief({ distribution: 'elevated', platforms: 1, collectibles: 4 }))[0]?.message).toContain('1 个高台最多 2 个收集点，现在是 4');
  });

  it('收集点数超出档位范围；守卫数超出档位上限', () => {
    expect(problemsOf(brief({ tier: 'small', collectibles: 9, guards: 0 }))).toEqual([
      { path: 'collectibles', message: 'small 地图的收集点数量要在 2–5 之间，现在是 9：改成这个范围里的数，或换一个地图档位' },
    ]);
    expect(problemsOf(brief({ tier: 'small', collectibles: 3, guards: 2 }))).toEqual([
      { path: 'guards', message: 'small 地图最多 1 个守卫，现在是 2：减少守卫，或换成更大的地图档位' },
    ]);
  });

  it('出场人物里的守卫多于守卫数量；同伴超过 3 个；同一个人物出场两次', () => {
    const id = (n: number) => n.toString(16).padStart(64, '0');
    expect(problemsOf(brief({ guards: 1, cast: [0, 1].map((n) => ({ personId: id(n), role: 'guard' as const, line: '' })) }))[0]?.message).toBe(
      '出场人物里有 2 个守卫，但守卫数量是 1：减少出场的守卫，或把守卫数量加到 2（不超过档位上限 2）',
    );
    expect(problemsOf(brief({ cast: [0, 1, 2, 3].map((n) => ({ personId: id(n), role: 'companion' as const, line: '' })) }))[0]?.message).toBe(
      '出场人物里有 4 个同伴，最多 3 个：减少出场的同伴',
    );
    expect(problemsOf(brief({ cast: [0, 0].map((n) => ({ personId: id(n), role: 'companion' as const, line: '' })) }))[0]?.message).toContain('出现了不止一次');
  });

  it('生成关卡时，说明书里的人物 ID 必须在名册里', () => {
    const someone = 'a'.repeat(64);
    const input = brief({ cast: [{ personId: someone, role: 'companion', line: '你好' }] });
    expect(problemsOf(input, new Set([someone]))).toEqual([]);
    expect(problemsOf(input, new Set())).toEqual([{ path: 'cast.0.personId', message: `出场人物 ${someone} 不在名册里：从名册里选人物，或去掉这一项` }]);
  });

  it('冲突不改值：返回错误，不返回改过的说明书', () => {
    const result = parseBrief(brief({ distribution: 'elevated', platforms: 0 }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('brief');
  });
});

describe('随机说明书', () => {
  const people = [0, 1, 2, 3].map((n) => ({ id: n.toString(16).padStart(64, '0'), name: `人物${String(n)}` }));

  it('只产出合法的组合（每个档位 300 个种子，含名册人物和空名册）', () => {
    for (const tier of TIERS) {
      for (let s = 0; s < 300; s++) {
        const b: Brief = randomBrief(`brief-${tier}-${String(s)}`, s % 2 === 0 ? people : [], { tier });
        expect(parseBrief(b, new Set(people.map((p) => p.id))).ok).toBe(true);
        expect(b.tier).toBe(tier);
        if (b.distribution === 'elevated') expect(b.platforms).toBeGreaterThan(0);
        for (const c of b.cast) expect(people.map((p) => p.id)).toContain(c.personId);
      }
    }
  });

  it('只由种子决定：同样的种子得到同样的说明书，不用 Math.random 和墙钟', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('不应该调用 Math.random');
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('不应该读墙钟');
    });
    try {
      expect(randomBrief('same-seed', people)).toEqual(randomBrief('same-seed', people));
      expect(randomBrief('seed-a', people)).not.toEqual(randomBrief('seed-b', people));
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });

  it('名册为空时出场人物为空', () => {
    expect(randomBrief('empty', []).cast).toEqual([]);
  });
});
