// 收集、计时、胜负、重开、暂停、守卫：直接驱动模拟。

import { describe, expect, it } from 'vitest';
import { loadBuiltinLevel } from '../../src/game/level/builtin';
import {
  advance,
  createInitialState,
  pointOnRoute,
  restartGame,
  setPaused,
  snapshotGame,
  startGame,
  stepGame,
  togglePause,
  type GameState,
} from '../../src/game/sim';
import { SPEC } from '../../src/game/spec';
import { STEP, input, layout, play, run, trace } from '../helpers/game';

const twoGems = layout({
  collectibles: [
    { id: 'near', position: { x: 0, z: 3 } },
    { id: 'next', position: { x: 0, z: 6 } },
  ],
  target: 2,
});

describe('收集和胜负', () => {
  it('走进收集半径就收集到；没到目标数时继续游戏', () => {
    const states = trace(play(twoGems), input({ forward: 1 }), 1.5);
    const first = states.find((s) => s.collected.length === 1);
    expect(first?.collected).toEqual(['near']);
    expect(first?.phase).toBe('playing');
    // 收集时玩家胶囊轴线到收集点中心的距离不超过收集半径
    const dz = 3 - (first?.player.position.z ?? 0);
    expect(dz).toBeLessThanOrEqual(SPEC.collect.radius + 1e-9);
    expect(dz).toBeGreaterThan(SPEC.collect.radius - SPEC.move.walkSpeed * STEP - 1e-9);
  });

  it('收集到目标数就胜利', () => {
    const s = run(play(twoGems), input({ forward: 1 }), 4);
    expect(s.phase).toBe('won');
    expect(s.result).toMatchObject({ outcome: 'won', reason: 'collected' });
    expect(s.collected).toEqual(['near', 'next']);
  });

  it('时间用完就失败，剩余时间不会是负数', () => {
    const s = run(play(layout({ timeLimit: 2 })), input(), 2.5);
    expect(s.phase).toBe('lost');
    expect(s.result).toMatchObject({ outcome: 'lost', reason: 'time' });
    expect(s.timeLeft).toBe(0);
    expect(s.simTime).toBeCloseTo(2, 6);
  });

  it('计时按模拟时间递减', () => {
    const s = run(play(layout({ timeLimit: 30 })), input(), 1);
    expect(s.timeLeft).toBeCloseTo(29, 9);
    expect(s.simTime).toBeCloseTo(1, 9);
  });

  it('分出胜负后不再推进：stepGame 和 advance 都原样返回', () => {
    const won = run(play(twoGems), input({ forward: 1 }), 4);
    expect(stepGame(won, input({ forward: 1 }))).toBe(won);
    expect(advance(won, input({ forward: 1 }), 0, 1).state).toBe(won);
    const lost = run(play(layout({ timeLimit: 1 })), input(), 2);
    expect(stepGame(lost, input({ forward: 1 }))).toBe(lost);
  });

  it('重开恢复关卡的初始状态', () => {
    const level = twoGems;
    const played = run(play(level), input({ forward: 1 }), 2);
    expect(played.collected.length).toBe(1);
    const restarted = restartGame(played);
    expect(restarted).toEqual(createInitialState(level));
    expect(restarted.phase).toBe('ready');
    expect(restarted.timeLeft).toBe(level.timeLimit);
    expect(restarted.collected).toEqual([]);
  });

  it('开始之前不推进', () => {
    const ready = createInitialState(layout());
    expect(stepGame(ready, input({ forward: 1 }))).toBe(ready);
    expect(startGame(ready).phase).toBe('playing');
  });
});

describe('暂停', () => {
  it('暂停时不推进：位置、计时、守卫都不变', () => {
    const level = layout({ guards: [{ id: 'g', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] }] });
    const moving = run(play(level), input({ forward: 1 }), 1);
    const paused = togglePause(moving);
    expect(paused.phase).toBe('paused');
    expect(stepGame(paused, input({ forward: 1, jump: true }))).toBe(paused);
    const advanced = advance(paused, input({ forward: 1 }), 0.01, 5);
    expect(advanced.state).toBe(paused);
    expect(advanced.steps).toBe(0);
    expect(advanced.accumulator).toBe(0); // 暂停期间的时间不会在继续时补上
  });

  it('继续后重新推进', () => {
    const paused = setPaused(run(play(layout()), input(), 1), true);
    const resumed = togglePause(paused);
    expect(resumed.phase).toBe('playing');
    const later = run(resumed, input(), 1);
    expect(later.timeLeft).toBeCloseTo(paused.timeLeft - 1, 9);
  });

  it('未开始和已结束时暂停无效', () => {
    const ready = createInitialState(layout());
    expect(togglePause(ready)).toBe(ready);
  });
});

describe('固定步长', () => {
  it('advance 把经过的时间换成固定步，余数留给下一帧', () => {
    const s = play(layout());
    const a = advance(s, input({ forward: 1 }), 0, 2.5 * STEP);
    expect(a.steps).toBe(2);
    expect(a.accumulator).toBeCloseTo(0.5 * STEP, 9);
    const b = advance(a.state, input({ forward: 1 }), a.accumulator, 0.5 * STEP);
    expect(b.steps).toBe(1);
  });

  it('一帧最多推进 maxStepsPerFrame 步', () => {
    const a = advance(play(layout()), input(), 0, 10);
    expect(a.steps).toBe(SPEC.sim.maxStepsPerFrame);
    expect(a.accumulator).toBeLessThanOrEqual(STEP);
  });

  it('跳跃输入只用于一帧里的第一步', () => {
    const a = advance(play(layout()), input({ jump: true }), 0, 3 * STEP);
    expect(a.steps).toBe(3);
    expect(a.state.player.grounded).toBe(false);
    const peakVy = SPEC.jump.speed - 3 * SPEC.jump.gravity * STEP;
    expect(a.state.player.vy).toBeCloseTo(peakVy, 9);
  });

  it('同样的输入序列得到完全相同的结果（不依赖墙钟）', () => {
    const level = loadBuiltinLevel('meadow');
    if (!level) throw new Error('没有 meadow');
    const script = (s: GameState) => {
      let state = s;
      for (let i = 0; i < 600; i++) {
        state = stepGame(state, input({ forward: 1, right: i % 120 < 60 ? 0.5 : -0.5, run: i % 200 > 100, jump: i % 90 === 0, cameraYaw: i * 0.002 }));
      }
      return state;
    };
    expect(snapshotGame(script(play(level)))).toEqual(snapshotGame(script(play(level))));
  });
});

describe('守卫', () => {
  it('沿巡逻路线循环移动：走完一圈回到起点', () => {
    const route = [
      { x: -4, z: 4 },
      { x: 4, z: 4 },
      { x: 4, z: 8 },
      { x: -4, z: 8 },
    ];
    const level = layout({ guards: [{ id: 'g', route }] });
    const loop = 24 / SPEC.guard.speed; // 周长 24 m
    const quarter = run(play(level), input(), 8 / SPEC.guard.speed);
    expect(quarter.guards[0]?.position.x).toBeCloseTo(4, 6);
    expect(quarter.guards[0]?.position.z).toBeCloseTo(4, 6);
    const full = run(play(level), input(), loop);
    expect(full.guards[0]?.position.x).toBeCloseTo(-4, 6);
    expect(full.guards[0]?.position.z).toBeCloseTo(4, 6);
    const twice = run(play(level), input(), loop * 2 + 8 / SPEC.guard.speed);
    expect(twice.guards[0]?.position.x).toBeCloseTo(4, 5);
  });

  it('两个点的路线来回走', () => {
    const level = layout({ guards: [{ id: 'g', route: [{ x: -3, z: 5 }, { x: 3, z: 5 }] }] });
    const s = run(play(level), input(), 6 / SPEC.guard.speed + 1 / SPEC.guard.speed);
    expect(s.guards[0]?.position.x).toBeCloseTo(2, 6); // 到了 (3,5) 后往回走 1 m
    const route = s.world.guardRoutes[0];
    if (!route) throw new Error('没有路线');
    expect(pointOnRoute(route, 12).x).toBeCloseTo(-3, 9);
  });

  it('连续多帧重叠只扣一次；冷却结束后还在接触，再扣一次', () => {
    // 守卫在出生点上来回挪 0.2 m，始终和玩家重叠
    const level = layout({ timeLimit: 100, guards: [{ id: 'g', route: [{ x: -0.1, z: 0 }, { x: 0.1, z: 0 }] }] });
    const states = trace(play(level), input(), 3);
    const first = states.find((s) => s.hits.length === 1);
    expect(first?.timeLeft).toBeCloseTo(100 - (first?.simTime ?? 0) - SPEC.guard.penaltySeconds, 9);
    // 冷却期间（约 2 秒）一直重叠，也只扣了一次
    const duringCooldown = states.filter((s) => s.simTime < (first?.simTime ?? 0) + SPEC.guard.cooldownSeconds - 1e-6);
    expect(duringCooldown.every((s) => s.hits.length <= 1)).toBe(true);
    const last = states.at(-1);
    expect(last?.hits).toHaveLength(2);
    const [h1, h2] = last?.hits ?? [];
    expect((h2?.at ?? 0) - (h1?.at ?? 0)).toBeGreaterThanOrEqual(SPEC.guard.cooldownSeconds - 1e-9);
    expect((h2?.at ?? 0) - (h1?.at ?? 0)).toBeLessThanOrEqual(SPEC.guard.cooldownSeconds + STEP + 1e-9);
    expect(last?.timeLeft).toBeCloseTo(100 - 3 - 2 * SPEC.guard.penaltySeconds, 9);
  });

  it('测试小关 B：站着不动，守卫每经过一次扣一次，两次扣时的间隔不短于冷却时长', () => {
    const level = loadBuiltinLevel('test-b');
    if (!level) throw new Error('没有 test-b');
    const s = run(play(level), input(), 10);
    expect(s.hits.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < s.hits.length; i++) {
      expect((s.hits[i]?.at ?? 0) - (s.hits[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(SPEC.guard.cooldownSeconds);
    }
    // 路线来回 12 m，守卫每 6 m 经过出生点一次：10 秒内经过 3 次
    expect(s.hits).toHaveLength(3);
    expect(s.timeLeft).toBeCloseTo(level.timeLimit - 10 - 3 * SPEC.guard.penaltySeconds, 6);
  });

  it('不接触时不扣时间', () => {
    const level = layout({ guards: [{ id: 'g', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] }] });
    expect(run(play(level), input(), 10).hits).toEqual([]);
  });
});
