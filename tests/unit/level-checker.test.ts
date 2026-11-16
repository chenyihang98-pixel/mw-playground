// 关卡的硬检查（P5）：给检查器人工构造的布局，结果都要对。检查器是独立的模块（不引用生成器）。
// 判定是保守的：判为能走到的实际一定能走到；比胶囊直径窄的缝一定判为走不过去；从地面到高台、从高台回到地面只按坡道算。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { briefSchema } from '../../src/game/level/gen/brief';
import { checkLevel, type CheckReport } from '../../src/game/level/gen/checker';
import { NO_INPUT, createInitialState, startGame, stepGame } from '../../src/game/sim';
import { parseLevel } from '../../src/game/level/schema';
import { SPEC } from '../../src/game/spec';
import { brief, handmade, wallWithGap } from '../helpers/levels';

function codes(report: CheckReport): string[] {
  return report.problems.map((p) => p.code);
}

/** 平台 4 × 4（中心 (0, 4)），坡道贴在 −z 一侧（低端朝出生点），收集点在平台顶面中央。 */
function platformLevel(options: { ramps?: { side: '-z' | '+z' | '-x' | '+x'; length?: number }[]; boxes?: ReturnType<typeof wallWithGap> } = {}) {
  return handmade({
    platforms: [{ id: 'plat', center: { x: 0, z: 4 }, size: { x: 4, z: 4 } }],
    ramps: (options.ramps ?? []).map((r, i) => ({ id: `ramp-${String(i)}`, platform: 'plat', side: r.side, length: r.length ?? 3, width: 1.6, offset: 0 })),
    boxes: options.boxes ?? [],
    collectibles: [{ id: 'top', position: { x: 0, z: 4 } }],
  });
}

describe('能走到和走不到', () => {
  it('空地图：收集点能走到，没有问题', () => {
    const report = checkLevel(handmade());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.level?.id).toBe('hand');
  });

  it('收集点被一圈盒子围住：走不到', () => {
    const ring = [
      { id: 'n', center: { x: 0, z: 9.4 }, size: { x: 3, z: 1 }, height: 2 },
      { id: 's', center: { x: 0, z: 6.6 }, size: { x: 3, z: 1 }, height: 2 },
      { id: 'w', center: { x: -1.25, z: 8 }, size: { x: 0.5, z: 1.79 }, height: 2 },
      { id: 'e', center: { x: 1.25, z: 8 }, size: { x: 0.5, z: 1.79 }, height: 2 },
    ];
    const report = checkLevel(handmade({ boxes: ring }));
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual(expect.objectContaining({ category: 'layout', code: 'unreachable', message: expect.stringContaining('gem') as string }));
  });

  it('比胶囊直径窄的缝一定判为走不过去；刚比直径宽一点也判为走不过去（保守）；宽缝能走过去', () => {
    const diameter = 2 * SPEC.capsule.radius;
    expect(codes(checkLevel(handmade({ boxes: wallWithGap(diameter - 0.05) })))).toContain('unreachable');
    expect(codes(checkLevel(handmade({ boxes: wallWithGap(diameter + 0.02) })))).toContain('unreachable');
    expect(checkLevel(handmade({ boxes: wallWithGap(1.6) })).ok).toBe(true);
  });

  it('判为能走到的实际能走到：在模拟里沿缝的中线直走，确实能穿过 1.6 m 宽的缝收集到宝石', () => {
    const layout = handmade({ boxes: wallWithGap(1.6) });
    expect(checkLevel(layout).ok).toBe(true);
    let state = startGame(createInitialState(parseLevel(layout)));
    for (let i = 0; i < 600 && state.phase === 'playing'; i++) state = stepGame(state, { ...NO_INPUT, forward: 1 });
    expect(state.phase).toBe('won');
  });

  it('矮盒子也算障碍（不算迈上去）：挡住唯一通道时判为走不到', () => {
    const low = wallWithGap(0.4, 0.2);
    expect(codes(checkLevel(handmade({ boxes: low })))).toContain('unreachable');
  });
});

describe('高台和坡道', () => {
  it('没有坡道的高台：顶面的收集点走不到（不算跳上去）', () => {
    const report = checkLevel(platformLevel());
    expect(codes(report)).toContain('unreachable');
  });

  it('有坡道的高台：经坡道能走上去', () => {
    const report = checkLevel(platformLevel({ ramps: [{ side: '-z' }] }));
    expect(report.problems).toEqual([]);
    expect(report.navigation?.portals).toHaveLength(1);
  });

  it('高台只有一侧有坡道，坡道的低端被障碍挡住：走不到', () => {
    // 坡道从 z = 2 往下到 z = −1（低端），盒子紧贴在低端外面
    const blocker = [{ id: 'blocker', center: { x: 0, z: -1.6 }, size: { x: 3, z: 1 }, height: 2 }];
    const report = checkLevel(platformLevel({ ramps: [{ side: '-z' }], boxes: blocker }));
    expect(codes(report)).toContain('unreachable');
    expect(report.navigation?.portals).toHaveLength(0);
  });

  it('两侧有坡道、一侧被挡：另一侧能走上去', () => {
    const blocker = [{ id: 'blocker', center: { x: 0, z: -1.6 }, size: { x: 3, z: 1 }, height: 2 }];
    const report = checkLevel(platformLevel({ ramps: [{ side: '-z' }, { side: '+x' }], boxes: blocker }));
    expect(report.problems).toEqual([]);
    expect(report.navigation?.portals.map((p) => p.ramp)).toEqual(['ramp-1']);
  });

  it('坡道两侧贴着障碍时，沿中线走的胶囊碰不到它们：仍能走上去', () => {
    // 坡道宽 1.6（x 在 ±0.8），两侧的盒子从 ±0.925 开始，离中线比胶囊半径远得多
    const beside = [
      { id: 'side-l', center: { x: -1.05, z: 0.5 }, size: { x: 0.25, z: 3 }, height: 2 },
      { id: 'side-r', center: { x: 1.05, z: 0.5 }, size: { x: 0.25, z: 3 }, height: 2 },
    ];
    expect(checkLevel(platformLevel({ ramps: [{ side: '-z' }], boxes: beside })).ok).toBe(true);
  });

  it('坡道低端外的入口被两侧的障碍收窄到 0.8 m（比保守的通道窄）：判为走不上去', () => {
    const entrance = [
      { id: 'in-l', center: { x: -1.2, z: -2.2 }, size: { x: 1.6, z: 2 }, height: 2 },
      { id: 'in-r', center: { x: 1.2, z: -2.2 }, size: { x: 1.6, z: 2 }, height: 2 },
    ];
    const report = checkLevel(platformLevel({ ramps: [{ side: '-z' }], boxes: entrance }));
    expect(codes(report)).toContain('unreachable');
  });
});

describe('巡逻路线、出生点和数量', () => {
  it('人工构造一份巡逻路线穿墙的布局：判为失败', () => {
    const layout = handmade({
      boxes: [{ id: 'wall', center: { x: 0, z: 3 }, size: { x: 6, z: 0.6 }, height: 2 }],
      guards: [{ id: 'g', route: [{ x: 0, z: 1 }, { x: 0, z: 5 }] }],
    });
    const report = checkLevel(layout);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({ category: 'layout', code: 'patrol', message: '守卫 g 的第 0 段路线穿过 wall（不在地面上）' });
    expect(codes(report)).toContain('layout-rules'); // parseLevel 的语义校验也不通过
    expect(() => parseLevel(layout)).toThrow();
  });

  it('巡逻路线走上高台：不在地面上，判为失败', () => {
    const layout = { ...platformLevel({ ramps: [{ side: '-z' }] }), guards: [{ id: 'g', route: [{ x: -6, z: 4 }, { x: 6, z: 4 }] }] };
    expect(checkLevel(layout).problems.some((p) => p.code === 'patrol' && p.message.includes('穿过 plat'))).toBe(true);
  });

  it('出生点离守卫的巡逻路线太近：判为失败（最小距离在配置里）', () => {
    const near = handmade({ guards: [{ id: 'g', route: [{ x: -3, z: -6 }, { x: 3, z: -6 }] }] });
    expect(codes(checkLevel(near))).toContain('spawn-guard-distance');
    expect(checkLevel(near, { spawnGuardDistance: 1 }).ok).toBe(true);
  });

  it('出生点的胶囊与障碍重叠：判为失败', () => {
    const report = checkLevel(handmade({ boxes: [{ id: 'crate', center: { x: 0, z: -7.5 }, size: { x: 1, z: 1 }, height: 1 }] }));
    expect(codes(report)).toContain('spawn');
  });

  it('收集点数量少于目标数：判为失败', () => {
    expect(codes(checkLevel(handmade({ target: 2 })))).toEqual(expect.arrayContaining(['collectible-count']));
  });

  it('结构不对（不是 P2 的布局）：判为布局问题', () => {
    expect(checkLevel({ id: 'x' }).problems.every((p) => p.category === 'layout' && p.code === 'layout-schema')).toBe(true);
  });
});

describe('两类失败原因：说明书或参数的问题 / 检查发现的布局问题', () => {
  it('参数不对（网格边长不是正数）：说明书或参数的问题', () => {
    const report = checkLevel(handmade(), { grid: 0 });
    expect(report.problems).toEqual([{ category: 'brief', code: 'parameter', message: '网格边长 0 不对：必须是正数' }]);
  });

  it('说明书本身有组合冲突：说明书或参数的问题', () => {
    // 组合冲突的说明书（类型上合法，组合规则不通过）
    const bad = briefSchema.parse(brief({ distribution: 'elevated', platforms: 0 }));
    const report = checkLevel(handmade(), { brief: bad });
    expect(report.problems.every((p) => p.category === 'brief')).toBe(true);
  });

  it('布局与说明书不符（说明书要求只放在高台上，收集点却在地面上）：布局问题', () => {
    const b = briefSchema.parse(brief({ tier: 'small', distribution: 'elevated', platforms: 1, collectibles: 2, guards: 0 }));
    const report = checkLevel(handmade(), { brief: b });
    expect(report.problems.filter((p) => p.code === 'brief-mismatch').map((p) => p.category)).toEqual(expect.arrayContaining(['layout']));
    expect(report.problems.some((p) => p.message.includes('不在高台上'))).toBe(true);
  });
});

describe('独立性', () => {
  it('检查器不引用生成器（只用布局、P2 的 schema / layoutProblems 和几何函数）', () => {
    const source = readFileSync(new URL('../../src/game/level/gen/checker.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).not.toContain('./generator');
    // F6 起检查器的说明取界面语言的词典（i18n 只提供文字，不含生成器的逻辑）
    expect(imports.every((i) => ['../../spec', '../geometry', '../schema', './brief', './config', '../../../i18n'].includes(i ?? ''))).toBe(true);
  });
});
