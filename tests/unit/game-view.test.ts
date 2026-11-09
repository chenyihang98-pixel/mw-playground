// 视觉层里可以单独测的部分：小人的尺寸和层级、程序化姿态、键位、时间格式、测试钩子对象。
// three 的对象在 Node 里可以直接创建（不需要 WebGL）。

import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createGameTestHooks, deepFreeze } from '../../src/dev/gameTestHooks';
import { keyAction, movementAxes } from '../../src/game/input/keys';
import { CharacterView } from '../../src/game/render/characterView';
import { GUARD_PALETTE, PLAYER_PALETTE, buildHumanoid } from '../../src/game/render/humanoid';
import { rampGeometry } from '../../src/game/render/levelView';
import { computePose, gaitOf } from '../../src/game/render/pose';
import { formatTime } from '../../src/game/ui/format';
import { SPEC } from '../../src/game/spec';

describe('默认主角', () => {
  it('小人的显示高度等于胶囊高度，脚底在原点，宽度在胶囊半径以内', () => {
    const rig = buildHumanoid(PLAYER_PALETTE);
    rig.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(rig.root);
    expect(box.max.y - box.min.y).toBeCloseTo(SPEC.capsule.height, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThanOrEqual(SPEC.capsule.radius);
    expect(Math.max(Math.abs(box.min.z), Math.abs(box.max.z))).toBeLessThanOrEqual(SPEC.capsule.radius);
  });

  it('面向 +Z：鼻子在 +Z 一侧', () => {
    const rig = buildHumanoid(PLAYER_PALETTE);
    rig.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(rig.root);
    expect(box.max.z).toBeGreaterThan(Math.abs(box.min.z));
  });

  it('视觉模型挂在外层节点下的模型槽里；外层节点跟随物理位置和朝向', () => {
    const view = new CharacterView('player', PLAYER_PALETTE);
    expect(view.root.children).toContain(view.modelSlot);
    expect(view.modelSlot.name).toBe('model-slot');
    expect(view.modelSlot.children.map((c) => c.name)).toEqual(['humanoid']);
    view.update({ position: { x: 1, y: 1.2, z: -3 }, facing: Math.PI / 2, horizontalSpeed: 0, grounded: true, vy: 0 }, 1 / 60, 0);
    expect(view.root.position.toArray()).toEqual([1, 1.2, -3]);
    view.root.updateMatrixWorld(true);
    // 朝向 π/2 时，模型的 +Z 方向转到世界 +X
    const forward = new Vector3(0, 0, 1).applyQuaternion(view.root.quaternion);
    expect(forward.x).toBeCloseTo(1, 9);
    expect(view.modelSlot.position.toArray()).toEqual([0, 0, 0]);
  });

  it('守卫用同款小人，换一种配色', () => {
    expect(GUARD_PALETTE.shirt).not.toBe(PLAYER_PALETTE.shirt);
    const a = new Box3().setFromObject(buildHumanoid(PLAYER_PALETTE).root);
    const b = new Box3().setFromObject(buildHumanoid(GUARD_PALETTE).root);
    expect(b.max.y).toBeCloseTo(a.max.y, 9);
  });
});

describe('程序化姿态', () => {
  const base = { vy: 0, gaitPhase: Math.PI / 2, time: 0 };

  it('按速度和是否着地分出待机、走、跑、跳', () => {
    expect(gaitOf({ speed: 0, grounded: true })).toBe('idle');
    expect(gaitOf({ speed: SPEC.move.walkSpeed, grounded: true })).toBe('walk');
    expect(gaitOf({ speed: SPEC.move.runSpeed, grounded: true })).toBe('run');
    expect(gaitOf({ speed: SPEC.move.walkSpeed, grounded: false })).toBe('jump');
  });

  it('走路时两腿反向摆动，手臂与同侧腿反向；跑步摆幅更大、身体前倾更多', () => {
    const walk = computePose({ ...base, speed: SPEC.move.walkSpeed, grounded: true });
    expect(walk.hipL).toBeCloseTo(-walk.hipR, 12);
    expect(Math.sign(walk.shoulderL)).toBe(-Math.sign(walk.hipL));
    const run = computePose({ ...base, speed: SPEC.move.runSpeed, grounded: true });
    expect(Math.abs(run.hipL)).toBeGreaterThan(Math.abs(walk.hipL));
    expect(run.lean).toBeGreaterThan(walk.lean);
    expect(run.bob).toBeGreaterThan(walk.bob);
  });

  it('跳跃时抬臂收腿；待机时只有轻微起伏', () => {
    const jump = computePose({ ...base, speed: 0, grounded: false, vy: 3 });
    expect(jump.shoulderL).toBeLessThan(-1.5);
    expect(jump.kneeL).toBeGreaterThan(0.5);
    const idle = computePose({ ...base, speed: 0, grounded: true, time: 1 });
    expect(Math.abs(idle.hipL)).toBe(0);
    expect(Math.abs(idle.bob)).toBeLessThan(0.02);
  });
});

describe('输入和界面', () => {
  it('WASD 移动、Shift 跑、空格跳、Esc / P 暂停', () => {
    expect(['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(keyAction)).toEqual(['forward', 'left', 'back', 'right']);
    expect(keyAction('ShiftLeft')).toBe('run');
    expect(keyAction('Space')).toBe('jump');
    expect(keyAction('Escape')).toBe('pause');
    expect(keyAction('KeyP')).toBe('pause');
    expect(keyAction('KeyQ')).toBeNull();
    expect(keyAction('toString')).toBeNull();
    expect(movementAxes(new Set(['forward', 'right', 'run']))).toEqual({ forward: 1, right: 1, run: true });
    expect(movementAxes(new Set(['forward', 'back']))).toEqual({ forward: 0, right: 0, run: false });
  });

  it('剩余时间格式 m:ss.s，向上取到 0.1 秒，不显示负数', () => {
    expect(formatTime(120)).toBe('2:00.0');
    expect(formatTime(59.95)).toBe('1:00.0');
    expect(formatTime(9.01)).toBe('0:09.1');
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(-3)).toBe('0:00.0');
  });

  it('坡道的楔形几何最高处等于高台高度', () => {
    const geometry = rampGeometry({ minX: 0, maxX: 3, minZ: 0, maxZ: 2 }, SPEC.terrain.platformHeight, '+x');
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.max.y).toBeCloseTo(SPEC.terrain.platformHeight, 6); // 顶点是 float32
    expect(geometry.boundingBox?.min.y).toBe(0);
  });
});

describe('测试钩子对象', () => {
  it('只有读状态和列关卡；快照是冻结的副本，改不到源数据', () => {
    const source = { value: { timeLeft: 10, list: [1, 2] } };
    const hooks = createGameTestHooks({ snapshot: () => source.value }, [{ id: 'a', name: 'A' }]);
    expect(Object.keys(hooks).sort()).toEqual(['getState', 'kind', 'listLevels', 'version']);
    expect(Object.isFrozen(hooks)).toBe(true);
    const snapshot = hooks.getState();
    expect(snapshot).toEqual(source.value);
    expect(snapshot).not.toBe(source.value);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.list)).toBe(true);
    expect(() => {
      (snapshot as { timeLeft: number }).timeLeft = 0;
    }).toThrow(TypeError);
    expect(source.value.timeLeft).toBe(10);
    expect(Object.isFrozen(source.value)).toBe(false);
    expect(hooks.listLevels()).toEqual([{ id: 'a', name: 'A' }]);
    expect(Object.isFrozen(deepFreeze({ a: { b: 1 } }).a)).toBe(true);
  });
});
