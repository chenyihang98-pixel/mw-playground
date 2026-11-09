// 驱动模拟的测试辅助：构造关卡、按固定步长推进。全部在 Node 里运行，不需要浏览器。

import { parseLevel, type LevelLayout, type LevelLayoutInput } from '../../src/game/level/schema';
import { NO_INPUT, createInitialState, startGame, stepGame, type GameState, type InputFrame } from '../../src/game/sim';
import { SPEC } from '../../src/game/spec';

export const STEP = SPEC.sim.fixedStep;

/** 一张 30×30 的空地图；收集点放在角落，避免测试时被顺手收集。 */
export function layout(overrides: Partial<LevelLayoutInput> = {}): LevelLayout {
  return parseLevel({
    id: 'unit',
    name: '单元测试',
    size: { width: 30, depth: 30 },
    spawn: { x: 0, z: 0, yaw: 0 },
    boxes: [],
    platforms: [],
    ramps: [],
    collectibles: [{ id: 'far', position: { x: 13, z: 13 } }],
    guards: [],
    timeLimit: 600,
    target: 1,
    ...overrides,
  });
}

export function play(level: LevelLayout): GameState {
  return startGame(createInitialState(level));
}

export function input(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...NO_INPUT, ...overrides };
}

/** 用同一个输入推进 seconds 秒（按固定步长取整）。 */
export function run(state: GameState, frame: InputFrame, seconds: number): GameState {
  let current = state;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) current = stepGame(current, frame, STEP);
  return current;
}

/** 推进 seconds 秒，每步记录一次状态。 */
export function trace(state: GameState, frame: InputFrame, seconds: number): GameState[] {
  const states: GameState[] = [];
  let current = state;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    current = stepGame(current, frame, STEP);
    states.push(current);
  }
  return states;
}
