// 玩法规格和关卡布局：规格的约束、内置关卡、不合法布局的拒绝。

import { describe, expect, it } from 'vitest';
import { BUILTIN_LEVEL_DATA, builtinLevelIds, loadBuiltinLevel } from '../../src/game/level/builtin';
import { groundHeightAt, layoutSolids, rectFromCenter } from '../../src/game/level/geometry';
import { LevelError, parseLevel, type LevelLayoutInput } from '../../src/game/level/schema';
import { SPEC, specProblems } from '../../src/game/spec';

describe('玩法规格', () => {
  it('最大跳跃高度由初速度和重力算出', () => {
    expect(SPEC.jump.maxHeight).toBeCloseTo((SPEC.jump.speed ** 2) / (2 * SPEC.jump.gravity), 12);
  });

  it('高台高度大于最大跳跃高度；规格之间没有冲突', () => {
    expect(SPEC.terrain.platformHeight).toBeGreaterThan(SPEC.jump.maxHeight);
    expect(specProblems()).toEqual([]);
  });

  it('规格是冻结的，运行时改不了', () => {
    expect(Object.isFrozen(SPEC)).toBe(true);
    expect(Object.isFrozen(SPEC.capsule)).toBe(true);
    expect(() => {
      (SPEC.capsule as { radius: number }).radius = 1;
    }).toThrow();
  });

  it('违反约束的规格会被指出', () => {
    const tooLow = { ...SPEC, terrain: { ...SPEC.terrain, platformHeight: 0.5 } };
    expect(specProblems(tooLow).join('\n')).toContain('不大于最大跳跃高度');
  });
});

const base: LevelLayoutInput = {
  id: 'x',
  name: 'x',
  size: { width: 20, depth: 20 },
  spawn: { x: 0, z: 0, yaw: 0 },
  boxes: [],
  platforms: [],
  ramps: [],
  collectibles: [{ id: 'c', position: { x: 5, z: 5 } }],
  guards: [],
  timeLimit: 60,
  target: 1,
};

function problemsOf(overrides: Partial<LevelLayoutInput>): string {
  try {
    parseLevel({ ...base, ...overrides });
    return '';
  } catch (error) {
    if (error instanceof LevelError) return error.message;
    throw error;
  }
}

describe('内置关卡', () => {
  it('三张图都通过 schema 校验', () => {
    expect(builtinLevelIds()).toEqual(['meadow', 'test-a', 'test-b']);
    for (const id of builtinLevelIds()) expect(loadBuiltinLevel(id)?.id).toBe(id);
    expect(loadBuiltinLevel('no-such-level')).toBeNull();
  });

  it('固定地图：若干障碍、带坡道的高台（高台上有收集点）、两个守卫各有路线', () => {
    const level = loadBuiltinLevel('meadow');
    if (!level) throw new Error('没有 meadow');
    expect(level.boxes.length).toBeGreaterThanOrEqual(3);
    expect(level.platforms).toHaveLength(1);
    expect(level.ramps.filter((r) => r.platform === level.platforms[0]?.id)).toHaveLength(1);
    const solids = layoutSolids(level);
    const onPlatform = level.collectibles.filter(
      (c) => groundHeightAt(solids, c.position.x, c.position.z) === SPEC.terrain.platformHeight,
    );
    expect(onPlatform.length).toBeGreaterThanOrEqual(1);
    expect(level.guards).toHaveLength(2);
    for (const guard of level.guards) expect(guard.route.length).toBeGreaterThanOrEqual(2);
  });

  it('测试小关 A：出生点正前方几米处有一个收集点，没有守卫，目标数 1', () => {
    const level = loadBuiltinLevel('test-a');
    if (!level) throw new Error('没有 test-a');
    const gem = level.collectibles[0];
    if (!gem) throw new Error('没有收集点');
    const dx = gem.position.x - level.spawn.x;
    const dz = gem.position.z - level.spawn.z;
    const ahead = dx * Math.sin(level.spawn.yaw) + dz * Math.cos(level.spawn.yaw);
    const sideways = dx * Math.cos(level.spawn.yaw) - dz * Math.sin(level.spawn.yaw);
    expect(ahead).toBeGreaterThan(2);
    expect(ahead).toBeLessThan(6);
    expect(sideways).toBeCloseTo(0, 9);
    expect(level.guards).toEqual([]);
    expect(level.target).toBe(1);
    expect(level.timeLimit).toBeGreaterThanOrEqual(60);
  });

  it('测试小关 B：守卫路线经过出生点，收集点在远处', () => {
    const level = loadBuiltinLevel('test-b');
    if (!level) throw new Error('没有 test-b');
    expect(level.guards).toHaveLength(1);
    const [a, b] = level.guards[0]?.route ?? [];
    if (!a || !b) throw new Error('路线不完整');
    // 出生点在路线线段上
    const cross = (b.x - a.x) * (level.spawn.z - a.z) - (b.z - a.z) * (level.spawn.x - a.x);
    expect(cross).toBeCloseTo(0, 9);
    expect(Math.min(a.x, b.x)).toBeLessThan(level.spawn.x);
    expect(Math.max(a.x, b.x)).toBeGreaterThan(level.spawn.x);
    const gem = level.collectibles[0];
    expect(gem && Math.hypot(gem.position.x - level.spawn.x, gem.position.z - level.spawn.z)).toBeGreaterThan(8);
  });

  it('内置数据不会被加载过程修改', () => {
    const before = JSON.stringify(BUILTIN_LEVEL_DATA);
    loadBuiltinLevel('meadow');
    expect(JSON.stringify(BUILTIN_LEVEL_DATA)).toBe(before);
  });
});

describe('不合法的布局被拒绝', () => {
  it('坡道比最大坡度陡', () => {
    const message = problemsOf({
      platforms: [{ id: 'p', center: { x: 5, z: -5 }, size: { x: 4, z: 4 } }],
      ramps: [{ id: 'r', platform: 'p', side: '-x', length: 1, width: 2 }],
    });
    expect(message).toContain('太陡');
  });

  it('最短合法坡道刚好通过', () => {
    expect(
      problemsOf({
        platforms: [{ id: 'p', center: { x: 5, z: -5 }, size: { x: 4, z: 4 } }],
        ramps: [{ id: 'r', platform: 'p', side: '-x', length: SPEC.terrain.rampMinLength, width: 2 }],
      }),
    ).toBe('');
  });

  it.each([
    ['目标数大于收集点数', { target: 2 }, '收集目标数 2 大于收集点数量 1'],
    ['出生点在盒子里', { boxes: [{ id: 'b', center: { x: 0, z: 0 }, size: { x: 2, z: 2 }, height: 1 }] }, '出生点与 b 重叠'],
    ['盒子超出地图', { boxes: [{ id: 'b', center: { x: 9.5, z: 5 }, size: { x: 2, z: 2 }, height: 1 }] }, 'b 超出地图边界'],
    ['重复的 id', { collectibles: [{ id: 'c', position: { x: 5, z: 5 } }, { id: 'c', position: { x: -5, z: 5 } }] }, '重复'],
    ['坡道引用不存在的高台', { ramps: [{ id: 'r', platform: 'nope', side: '+x' as const, length: 3, width: 2 }] }, '不存在'],
    [
      '守卫路线穿过盒子',
      {
        boxes: [{ id: 'b', center: { x: 4, z: 4 }, size: { x: 1, z: 1 }, height: 1 }],
        guards: [{ id: 'g', route: [{ x: 2, z: 4 }, { x: 6, z: 4 }] }],
      },
      '离 b 不足一个胶囊半径',
    ],
    ['收集点在盒子里', { boxes: [{ id: 'b', center: { x: 5, z: 5 }, size: { x: 2, z: 2 }, height: 1 }] }, '在盒子 b 里面'],
    ['未知字段', { extra: 1 } as Partial<LevelLayoutInput>, 'extra'],
    ['时间限制不是正数', { timeLimit: 0 }, 'timeLimit'],
  ])('%s', (_name, overrides, expected) => {
    expect(problemsOf(overrides)).toContain(expected);
  });

  it('rectFromCenter 与布局里的 center/size 一致', () => {
    expect(rectFromCenter({ x: 1, z: 2 }, { x: 4, z: 6 })).toEqual({ minX: -1, maxX: 3, minZ: -1, maxZ: 5 });
  });
});
