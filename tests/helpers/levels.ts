// 关卡生成和检查（P5）测试的辅助：说明书和人工构造的布局。

import { BRIEF_SCHEMA_VERSION, type BriefInput } from '../../src/game/level/gen/brief';
import type { LevelLayoutInput } from '../../src/game/level/schema';

export function brief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    tier: 'medium',
    density: 'mid',
    platforms: 2,
    collectibles: 4,
    distribution: 'scattered',
    guards: 1,
    patrol: 'loop',
    intent: 'normal',
    visual: { theme: 'grass', time: 'day', weather: 'clear' },
    title: '测试关卡',
    opening: '',
    cast: [],
    ...overrides,
  };
}

/** 一张 20 × 20 的空地图：出生点在 (0, −8)，一个收集点在 (0, 8)。 */
export function handmade(overrides: Partial<LevelLayoutInput> = {}): LevelLayoutInput {
  return {
    id: 'hand',
    name: '人工构造',
    size: { width: 20, depth: 20 },
    spawn: { x: 0, z: -8, yaw: 0 },
    boxes: [],
    platforms: [],
    ramps: [],
    collectibles: [{ id: 'gem', position: { x: 0, z: 8 } }],
    guards: [],
    timeLimit: 60,
    target: 1,
    ...overrides,
  };
}

/** 横跨地图（z 在 −0.5 到 0.5 之间）的一道墙，中间留宽 gap 的缝。 */
export function wallWithGap(gap: number, height = 2): LevelLayoutInput['boxes'] {
  const half = 10;
  const side = half - gap / 2;
  return [
    { id: 'wall-left', center: { x: -half + side / 2, z: 0 }, size: { x: side, z: 1 }, height },
    { id: 'wall-right', center: { x: half - side / 2, z: 0 }, size: { x: side, z: 1 }, height },
  ];
}
