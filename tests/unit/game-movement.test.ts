// 移动、碰撞、高台：直接驱动模拟，不需要浏览器。

import { describe, expect, it } from 'vitest';
import { moveDirection } from '../../src/game/sim';
import { SPEC } from '../../src/game/spec';
import { STEP, input, layout, play, run, trace } from '../helpers/game';

const r = SPEC.capsule.radius;

describe('移动', () => {
  it('走：1 秒走 walkSpeed 米', () => {
    const s = run(play(layout()), input({ forward: 1 }), 1);
    expect(s.player.position.z).toBeCloseTo(SPEC.move.walkSpeed, 6);
    expect(s.player.position.x).toBeCloseTo(0, 9);
    expect(s.player.horizontalSpeed).toBeCloseTo(SPEC.move.walkSpeed, 6);
  });

  it('跑（Shift）：1 秒跑 runSpeed 米', () => {
    const s = run(play(layout()), input({ forward: 1, run: true }), 1);
    expect(s.player.position.z).toBeCloseTo(SPEC.move.runSpeed, 6);
    expect(s.player.running).toBe(true);
  });

  it('斜着走不超速：W + D 的速度仍是 walkSpeed', () => {
    const s = run(play(layout()), input({ forward: 1, right: 1 }), 1);
    expect(Math.hypot(s.player.position.x, s.player.position.z)).toBeCloseTo(SPEC.move.walkSpeed, 6);
    const fast = run(play(layout()), input({ forward: 1, right: 1, run: true }), 1);
    expect(Math.hypot(fast.player.position.x, fast.player.position.z)).toBeCloseTo(SPEC.move.runSpeed, 6);
  });

  it('按相机方向移动：W 朝相机前方，D 朝相机右方', () => {
    const yaw = Math.PI / 2; // 相机看向 +X
    const forward = moveDirection(input({ forward: 1, cameraYaw: yaw }));
    expect(forward.x).toBeCloseTo(1, 12);
    expect(forward.z).toBeCloseTo(0, 12);
    const right = moveDirection(input({ right: 1, cameraYaw: 0 })); // 相机看向 +Z 时右手边是 -X
    expect(right.x).toBeCloseTo(-1, 12);
    expect(right.z).toBeCloseTo(0, 12);
    const s = run(play(layout()), input({ forward: 1, cameraYaw: yaw }), 1);
    expect(s.player.position.x).toBeCloseTo(SPEC.move.walkSpeed, 6);
  });

  it('角色朝向转向移动方向', () => {
    const s = run(play(layout()), input({ forward: 1, cameraYaw: Math.PI / 2 }), 1);
    expect(s.player.facing).toBeCloseTo(Math.PI / 2, 6);
  });

  it('跳：最高点不超过规格里的最大跳跃高度，落回地面', () => {
    // jump 是边沿输入：只在按下后的第一步为 true
    const takeoff = run(play(layout()), input({ jump: true }), STEP);
    const states = [takeoff, ...trace(takeoff, input(), 1.5)];
    const peak = Math.max(...states.map((s) => s.player.position.y));
    expect(peak).toBeLessThanOrEqual(SPEC.jump.maxHeight);
    expect(peak).toBeGreaterThan(SPEC.jump.maxHeight * 0.9);
    const last = states.at(-1);
    expect(last?.player.position.y).toBe(0);
    expect(last?.player.grounded).toBe(true);
  });
});

describe('碰撞', () => {
  // z = 3 处一堵横墙，挡住正前方
  const wall = layout({ boxes: [{ id: 'wall', center: { x: 0, z: 3 }, size: { x: 10, z: 1 }, height: 2 }] });

  it('不穿墙：停在墙前，离墙面正好一个胶囊半径', () => {
    const s = run(play(wall), input({ forward: 1, run: true }), 3);
    expect(s.player.position.z).toBeLessThanOrEqual(2.5 - r + 1e-6);
    expect(s.player.position.z).toBeGreaterThan(2.5 - r - 1e-3);
  });

  it('沿墙滑动：斜着撞墙时继续沿墙面移动', () => {
    // 先走到墙边，再按 W + A（相机看 +Z 时 A 朝 +X）
    const atWall = run(play(wall), input({ forward: 1 }), 2);
    const slid = run(atWall, input({ forward: 1, right: -1 }), 1);
    expect(slid.player.position.x - atWall.player.position.x).toBeGreaterThan(1.4);
    expect(slid.player.position.z).toBeLessThanOrEqual(2.5 - r + 1e-6);
  });

  it('不出边界：一直往后走停在地图边缘内一个半径处', () => {
    const s = run(play(layout()), input({ forward: -1, run: true }), 10);
    expect(s.player.position.z).toBeCloseTo(-15 + r, 6);
    const side = run(play(layout()), input({ right: 1, run: true }), 10);
    expect(side.player.position.x).toBeCloseTo(-15 + r, 6);
  });

  function gap(width: number) {
    return layout({
      boxes: [
        { id: 'left', center: { x: -3 - width / 2, z: 3 }, size: { x: 6, z: 1 }, height: 2 },
        { id: 'right', center: { x: 3 + width / 2, z: 3 }, size: { x: 6, z: 1 }, height: 2 },
      ],
    });
  }

  it('胶囊半径生效：比胶囊直径窄的缝过不去', () => {
    expect(0.6).toBeLessThan(2 * r);
    const s = run(play(gap(0.6)), input({ forward: 1 }), 4);
    expect(s.player.position.z).toBeLessThan(2.5);
    // 偏一点再挤也过不去
    const offset = run(play(gap(0.6)), input({ forward: 1, right: 0.2 }), 4);
    expect(offset.player.position.z).toBeLessThan(2.5);
  });

  it('比胶囊直径宽的缝能过', () => {
    expect(0.9).toBeGreaterThan(2 * r);
    const s = run(play(gap(0.9)), input({ forward: 1 }), 4);
    expect(s.player.position.z).toBeGreaterThan(4);
  });
});

describe('高台和坡道', () => {
  // 高台 z ∈ [4, 8]，南侧（-z）贴一条坡道 z ∈ [1.6, 4]
  const plateau = layout({
    platforms: [{ id: 'p', center: { x: 0, z: 6 }, size: { x: 4, z: 4 } }],
    ramps: [{ id: 'ramp', platform: 'p', side: '-z', length: 2.4, width: 2 }],
  });
  const H = SPEC.terrain.platformHeight;

  it('沿坡道走上高台，在顶面行走', () => {
    const states = trace(play(plateau), input({ forward: 1 }), 2.6);
    const onRamp = states.find((s) => s.player.position.z > 2.8 && s.player.position.z < 3.2);
    expect(onRamp?.player.position.y).toBeGreaterThan(0.3);
    expect(onRamp?.player.position.y).toBeLessThan(H);
    expect(onRamp?.player.grounded).toBe(true);
    const top = states.at(-1);
    expect(top?.player.position.z).toBeGreaterThan(5);
    expect(top?.player.position.y).toBeCloseTo(H, 9);
    expect(top?.player.grounded).toBe(true);
  });

  it('从高台边缘走下去会掉到地面', () => {
    const top = run(play(plateau), input({ forward: 1 }), 2.6);
    const states = trace(top, input({ forward: 1 }), 3);
    expect(states.some((s) => !s.player.grounded && s.player.position.y < H && s.player.position.y > 0)).toBe(true);
    const last = states.at(-1);
    expect(last?.player.position.z).toBeGreaterThan(8);
    expect(last?.player.position.y).toBe(0);
    expect(last?.player.grounded).toBe(true);
  });

  it('沿坡道走下来一直贴着坡面', () => {
    const top = run(play(plateau), input({ forward: 1 }), 2.6);
    const states = trace(top, input({ forward: -1 }), 3);
    const onRamp = states.filter((s) => s.player.position.z > 1.8 && s.player.position.z < 3.8);
    expect(onRamp.length).toBeGreaterThan(5);
    expect(onRamp.every((s) => s.player.grounded)).toBe(true);
  });

  it('跳不上高台：贴着侧面一直跳，也上不去', () => {
    // 没有坡道的高台，从正南方走过去连续起跳
    const level = layout({ platforms: [{ id: 'p', center: { x: 0, z: 6 }, size: { x: 4, z: 4 } }] });
    let s = play(level);
    let peak = 0;
    for (let i = 0; i < 6 * 60; i++) {
      s = run(s, input({ forward: 1, jump: i % 30 === 0 }), 1 / 60);
      peak = Math.max(peak, s.player.position.y);
    }
    expect(peak).toBeLessThanOrEqual(SPEC.jump.maxHeight);
    expect(s.player.position.z).toBeLessThanOrEqual(4 - r + 1e-6);
    expect(s.player.position.y).toBeLessThan(H);
  });

  it('从坡道侧面高处走不上去（侧面高过迈步高度的部分是墙）', () => {
    // 从坡道东侧、靠近高台的位置往西走：那里坡面高过迈步高度
    const level = layout({
      spawn: { x: 3, z: 3.6, yaw: 0 },
      platforms: [{ id: 'p', center: { x: 0, z: 6 }, size: { x: 4, z: 4 } }],
      ramps: [{ id: 'ramp', platform: 'p', side: '-z', length: 2.4, width: 2 }],
    });
    const s = run(play(level), input({ right: 1 }), 2); // 相机看 +Z，D 朝 -X
    expect(s.player.position.x).toBeGreaterThanOrEqual(1 + r - 1e-6);
    expect(s.player.position.y).toBe(0);
  });
});
