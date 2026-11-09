// 同伴（P4）：开局位置、跟随距离、不和主角 / 守卫碰撞、被卡住时传送、找不到位置时留在原地、不收集不扣时、暂停时不动。
// 全部用纯模拟按固定步长推进。

import { describe, expect, it } from 'vitest';
import { circleOverlapsRect } from '../../src/game/level/geometry';
import {
  NO_INPUT,
  blockingRects,
  createInitialState,
  followOffset,
  followTarget,
  groundAt,
  restartGame,
  setCompanions,
  setPaused,
  startGame,
  stepGame,
  type GameState,
} from '../../src/game/sim';
import { SPEC, specProblems } from '../../src/game/spec';
import { input, layout, run, STEP } from '../helpers/game';

/** 同伴的胶囊和会挡住它的实体都不重叠。 */
function clearOfObstacles(state: GameState, x: number, z: number): boolean {
  const y = groundAt(state.world, x, z);
  return !blockingRects(state.world, y, 0, x, z).some((rect) => circleOverlapsRect(x, z, SPEC.capsule.radius - 1e-6, rect));
}

function companion(state: GameState, i = 0) {
  const c = state.companions[i];
  if (!c) throw new Error(`没有第 ${String(i)} 个同伴`);
  return c;
}

function horizontal(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('同伴的规格', () => {
  it('参数都在 SPEC 里，并且彼此一致', () => {
    expect(specProblems()).toEqual([]);
    expect(SPEC.companion.follow).toHaveLength(3);
    expect(SPEC.companion.resumeRadius).toBeGreaterThan(SPEC.companion.arriveRadius);
  });
});

describe('跟随目标点（P6：不在主角正后方）', () => {
  /** 目标点在主角自己的坐标里：right（右为正）和 forward（前为正）。 */
  function local(facing: number, slot: number): { right: number; forward: number } {
    const player = { position: { x: 3, y: 0, z: -2 }, vy: 0, grounded: true, facing, horizontalSpeed: 0, running: false };
    const t = followTarget(player, slot);
    const dx = t.x - player.position.x;
    const dz = t.z - player.position.z;
    // 前 = (sin f, cos f)；右 = (-cos f, sin f)
    return { right: -Math.cos(facing) * dx + Math.sin(facing) * dz, forward: Math.sin(facing) * dx + Math.cos(facing) * dz };
  }

  it('同伴 0 在左后方，同伴 1 在右后方，同伴 2 在左后方、比同伴 0 更靠后；左右按主角的朝向算', () => {
    for (const facing of [0, Math.PI / 2, Math.PI, -Math.PI / 3, 2.5]) {
      const [c0, c1, c2] = [0, 1, 2].map((slot) => local(facing, slot));
      if (!c0 || !c1 || !c2) throw new Error('缺目标点');
      expect(c0.right).toBeLessThan(0);
      expect(c0.forward).toBeLessThan(0);
      expect(c1.right).toBeGreaterThan(0);
      expect(c1.forward).toBeLessThan(0);
      expect(c2.right).toBeLessThan(0);
      expect(c2.forward).toBeLessThan(c0.forward);
      // 偏移量就是 SPEC.companion.follow 里的值
      for (const [slot, c] of [c0, c1, c2].entries()) {
        expect(c.right).toBeCloseTo(followOffset(slot).right, 9);
        expect(c.forward).toBeCloseTo(-followOffset(slot).back, 9);
      }
    }
    expect(SPEC.companion.follow.map((f) => [f.back, f.right])).toEqual([
      [1.6, -1.3],
      [1.6, 1.3],
      [2.6, -1.1],
    ]);
  });

  it('朝向 0（面向 +Z）时：左边是 +X，同伴 0 的目标点在 (x + 1.3, z − 1.6)', () => {
    const player = { position: { x: 0, y: 0, z: 0 }, vy: 0, grounded: true, facing: 0, horizontalSpeed: 0, running: false };
    expect(followTarget(player, 0).x).toBeCloseTo(1.3, 9);
    expect(followTarget(player, 0).z).toBeCloseTo(-1.6, 9);
    expect(followTarget(player, 1).x).toBeCloseTo(-1.3, 9);
  });
});

describe('开局位置', () => {
  it('出现在各自的跟随目标点上（主角的左后方）', () => {
    const state = createInitialState(layout(), ['a']);
    const c = companion(state).body.position;
    const target = followTarget(state.player, 0);
    expect(horizontal(c, target)).toBeLessThan(1e-9);
    expect(c.x).toBeCloseTo(state.player.position.x + 1.3, 9); // 朝向 0：左边是 +X
    expect(c.z).toBeCloseTo(state.player.position.z - 1.6, 9); // 身后是 −Z
  });

  it('身后有障碍时换一个不和障碍重叠的位置；三个同伴各自不重叠', () => {
    const level = layout({ boxes: [{ id: 'crate', center: { x: 0, z: -2 }, size: { x: 3, z: 1.5 }, height: 1 }] });
    const state = createInitialState(level, ['a', 'b', 'c']);
    for (const c of state.companions) {
      expect(clearOfObstacles(state, c.body.position.x, c.body.position.z)).toBe(true);
      expect(horizontal(c.body.position, state.player.position)).toBeLessThanOrEqual(SPEC.companion.placeSpacing * SPEC.companion.placeRings + 1e-9);
    }
  });

  it('重开时回到初始位置', () => {
    let state = startGame(createInitialState(layout(), ['a']));
    const start = companion(state).body.position;
    state = run(state, input({ forward: 1 }), 2);
    expect(horizontal(companion(state).body.position, start)).toBeGreaterThan(1);
    const again = restartGame(state);
    expect(companion(again).body.position).toEqual(start);
    expect(again).toEqual(createInitialState(state.level, ['a']));
  });
});

describe('跟随', () => {
  it('主角走一段后停下：同伴跟上，停在跟随目标点（左后方）', () => {
    let state = startGame(createInitialState(layout(), ['a']));
    state = run(state, input({ forward: 1 }), 3);
    expect(companion(state).body.horizontalSpeed).toBeGreaterThan(0);
    state = run(state, NO_INPUT, 3);
    const c = companion(state);
    expect(horizontal(c.body.position, followTarget(state.player, 0))).toBeLessThanOrEqual(SPEC.companion.arriveRadius + 1e-9);
    const offset = followOffset(0);
    expect(horizontal(c.body.position, state.player.position)).toBeCloseTo(Math.hypot(offset.back, offset.right), 0);
    expect(c.following).toBe(false);
    expect(c.body.horizontalSpeed).toBe(0);
  });

  it('离目标点远时用跑步速度，近时用走路速度，速度不超过 SPEC', () => {
    let state = startGame(createInitialState(layout(), ['a']));
    let maxSpeed = 0;
    let ran = false;
    for (let i = 0; i < 180; i++) {
      state = stepGame(state, input({ forward: 1, run: true }), STEP);
      maxSpeed = Math.max(maxSpeed, companion(state).body.horizontalSpeed);
      ran ||= companion(state).body.running;
    }
    expect(maxSpeed).toBeLessThanOrEqual(SPEC.move.runSpeed + 1e-9);
    expect(ran).toBe(true);
  });

  it('同伴不跳：主角跳起来时同伴仍在地面', () => {
    let state = startGame(createInitialState(layout(), ['a']));
    state = stepGame(state, input({ jump: true }), STEP);
    for (let i = 0; i < 10; i++) state = stepGame(state, NO_INPUT, STEP);
    expect(state.player.grounded).toBe(false);
    expect(companion(state).body.grounded).toBe(true);
    expect(companion(state).body.position.y).toBe(0);
  });
});

describe('不和主角、守卫碰撞，不影响胜负', () => {
  it('主角倒着走穿过同伴：主角的轨迹和没有同伴时完全一样', () => {
    const level = layout();
    let withCompanion = startGame(createInitialState(level, ['a']));
    let alone = startGame(createInitialState(level));
    for (let i = 0; i < 120; i++) {
      withCompanion = stepGame(withCompanion, input({ forward: -1 }), STEP);
      alone = stepGame(alone, input({ forward: -1 }), STEP);
      expect(withCompanion.player).toEqual(alone.player);
    }
  });

  it('守卫的路线穿过同伴：守卫的位置不变，不扣时', () => {
    // 守卫在主角身后来回走，正好经过同伴站的位置 (1.3, −1.6)；主角离路线远，不会被碰到
    const level = layout({ guards: [{ id: 'g', route: [{ x: -4, z: -1.6 }, { x: 4, z: -1.6 }] }] });
    let withCompanion = startGame(createInitialState(level, ['a']));
    let alone = startGame(createInitialState(level));
    const start = companion(withCompanion).body.position;
    expect(start.z).toBeCloseTo(-1.6, 9);
    expect(start.x).toBeCloseTo(1.3, 9);
    for (let i = 0; i < 600; i++) {
      withCompanion = stepGame(withCompanion, NO_INPUT, STEP);
      alone = stepGame(alone, NO_INPUT, STEP);
      expect(withCompanion.guards).toEqual(alone.guards);
    }
    expect(withCompanion.hits).toEqual([]);
    expect(withCompanion.timeLeft).toBeCloseTo(alone.timeLeft, 9);
    expect(companion(withCompanion).body.position).toEqual(start);
  });

  it('同伴站在收集点上也不收集', () => {
    // 收集点就在同伴开局的位置（主角左后方）
    const level = layout({ collectibles: [{ id: 'behind', position: { x: 1.3, z: -1.6 } }] });
    let state = startGame(createInitialState(level, ['a']));
    state = run(state, NO_INPUT, 2);
    expect(horizontal(companion(state).body.position, { x: 1.3, z: -1.6 })).toBeLessThan(0.1);
    expect(state.collected).toEqual([]);
    expect(state.phase).toBe('playing');
  });

  it('结算：有同伴和没有同伴时，同样的输入得到同样的结果', () => {
    const level = layout({ collectibles: [{ id: 'ahead', position: { x: 0, z: 5 } }] });
    const withCompanions = run(startGame(createInitialState(level, ['a', 'b', 'c'])), input({ forward: 1 }), 4);
    const alone = run(startGame(createInitialState(level)), input({ forward: 1 }), 4);
    expect(withCompanions.phase).toBe('won');
    expect(withCompanions.result).toEqual(alone.result);
    expect(withCompanions.collected).toEqual(alone.collected);
  });
});

describe('暂停和分出胜负', () => {
  it('暂停时同伴不动；分出胜负后也不动', () => {
    let state = startGame(createInitialState(layout(), ['a']));
    state = run(state, input({ forward: 1 }), 1);
    const paused = setPaused(state, true);
    const after = run(paused, input({ forward: 1 }), 1);
    expect(after.companions).toEqual(paused.companions);

    const level = layout({ collectibles: [{ id: 'ahead', position: { x: 0, z: 2 } }] });
    let won = run(startGame(createInitialState(level, ['a'])), input({ forward: 1 }), 2);
    expect(won.phase).toBe('won');
    const frozen = won.companions;
    won = run(won, input({ forward: 1 }), 1);
    expect(won.companions).toEqual(frozen);
  });
});

describe('被卡住', () => {
  // 同伴开局在主角左后方 (1.3, −1.6)，被一个开口朝 −Z 的“杯子”围住；主角往 +Z 走，同伴朝目标点直走，被杯底挡住
  const cup = [
    { id: 'cup-back', center: { x: 1.3, z: -0.6 }, size: { x: 3.2, z: 0.4 }, height: 2 },
    // 侧壁和杯底之间留 5 cm 的缝（胶囊过不去），避免两个盒子在浮点误差下算作重叠
    { id: 'cup-left', center: { x: -0.1, z: -2.125 }, size: { x: 0.4, z: 2.55 }, height: 2 },
    { id: 'cup-right', center: { x: 2.7, z: -2.125 }, size: { x: 0.4, z: 2.55 }, height: 2 },
  ];

  it('离主角超过阈值并持续一段时间：传送到主角附近，站在地面上，不和障碍重叠', () => {
    let state = startGame(createInitialState(layout({ boxes: cup }), ['a']));
    expect(companion(state).body.position.z).toBeCloseTo(-1.6, 9);
    state = run(state, input({ forward: 1 }), 4); // 主角走到 z ≈ 8.8，同伴被杯底挡住
    expect(companion(state).body.position.z).toBeLessThan(-0.9);
    expect(companion(state).teleports).toBe(0);
    let teleportedAt = -1;
    for (let i = 0; i < 6 / STEP; i++) {
      state = stepGame(state, NO_INPUT, STEP);
      if (teleportedAt < 0 && companion(state).teleports > 0) teleportedAt = state.simTime;
    }
    expect(companion(state).teleports).toBe(1);
    // 离主角超过阈值（约 3.05 s 时）之后再过 stuckSeconds 才传送
    expect(teleportedAt).toBeGreaterThan(SPEC.companion.stuckSeconds);
    const c = companion(state).body.position;
    expect(horizontal(c, state.player.position)).toBeLessThan(SPEC.companion.stuckDistance);
    expect(clearOfObstacles(state, c.x, c.z)).toBe(true);
    expect(c.y).toBe(groundAt(state.world, c.x, c.z));
  });

  it('主角附近找不到能站的位置：留在原地，之后再试；主角走到空地后传送', () => {
    // 主角站在一个四面都是厚墙的小房间里（3 × 3 m，墙外沿到 9 m），周围 1.8–5.4 m 的候选位置全在墙里，
    // 房间外的同伴最多走到离主角 9 m 多的墙外沿
    const room = [
      { id: 'north', center: { x: 0, z: 5.25 }, size: { x: 18, z: 7.5 } },
      { id: 'south', center: { x: 0, z: -5.25 }, size: { x: 18, z: 7.5 } },
      { id: 'east', center: { x: 5.25, z: 0 }, size: { x: 7.5, z: 2.98 } },
      { id: 'west', center: { x: -5.25, z: 0 }, size: { x: 7.5, z: 2.98 } },
    ].map((b) => ({ ...b, height: 3 }));
    const level = layout({ size: { width: 40, depth: 40 }, boxes: room });
    let state = startGame(createInitialState(level, ['a']));
    // 开局也找不到位置：和主角站在一起
    expect(companion(state).body.position).toEqual(state.player.position);
    // 把同伴放到房间外 10 m 处（直接构造状态：模拟是纯函数），它走不进房间
    const outside = { x: 12, y: 0, z: 12 };
    state = { ...state, companions: [{ ...companion(state), body: { ...companion(state).body, position: outside } }] };
    const farTimes: number[] = [];
    for (let i = 0; i < 6 / STEP; i++) {
      state = stepGame(state, NO_INPUT, STEP);
      farTimes.push(companion(state).farTime);
    }
    expect(companion(state).teleports).toBe(0);
    expect(horizontal(companion(state).body.position, state.player.position)).toBeGreaterThan(SPEC.companion.stuckDistance);
    // 每隔 retrySeconds 再试一次：farTime 在 stuckSeconds − retrySeconds 和 stuckSeconds 之间循环
    expect(Math.max(...farTimes)).toBeLessThan(SPEC.companion.stuckSeconds);
    expect(farTimes.filter((t, i) => i > 0 && t < (farTimes[i - 1] ?? 0)).length).toBeGreaterThan(5);

    // 主角离开房间（直接放到空地上）：下一次重试时传送过去
    const open = { x: -12, y: 0, z: -12 };
    state = { ...state, player: { ...state.player, position: open } };
    for (let i = 0; i < (SPEC.companion.retrySeconds + 0.05) / STEP; i++) state = stepGame(state, NO_INPUT, STEP);
    expect(companion(state).teleports).toBe(1);
    // 空地上第一个候选（这个同伴的跟随目标点）就能站
    expect(horizontal(companion(state).body.position, followTarget(state.player, 0))).toBeLessThan(1e-9);
  });
});

describe('换一组同伴', () => {
  it('已有的保留状态，新加入的出现在主角附近，移除的消失', () => {
    let state = startGame(createInitialState(layout(), ['a', 'b']));
    state = run(state, input({ forward: 1 }), 1);
    const b = state.companions[1];
    state = setCompanions(state, ['b', 'c']);
    expect(state.companions.map((c) => c.id)).toEqual(['b', 'c']);
    expect(state.companions[0]).toEqual(b);
    expect(horizontal(companion(state, 1).body.position, state.player.position)).toBeLessThan(SPEC.companion.placeSpacing * 2);
    expect(setCompanions(state, ['b', 'c'])).toBe(state);
  });
});
