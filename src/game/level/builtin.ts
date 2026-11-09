// 内置的三张图。这里只是原始数据；游戏通过 loadBuiltinLevel → parseLevel 加载，一律经过 schema 校验。

import { parseLevel, type LevelLayout, type LevelLayoutInput } from './schema';

/** 手工固定地图：若干障碍、一个带坡道的高台（高台上有收集点）、两个守卫。 */
const meadow: LevelLayoutInput = {
  id: 'meadow',
  name: '草地',
  size: { width: 40, depth: 40 },
  spawn: { x: 0, z: -15, yaw: 0 },
  boxes: [
    { id: 'crate-1', center: { x: -6, z: -8 }, size: { x: 2, z: 2 }, height: 1 },
    { id: 'crate-2', center: { x: -4.2, z: -8 }, size: { x: 1.2, z: 1.2 }, height: 0.5 },
    { id: 'wall-1', center: { x: 4, z: -4 }, size: { x: 6, z: 0.6 }, height: 2 },
    { id: 'crate-3', center: { x: -12, z: 6 }, size: { x: 2, z: 3 }, height: 1.5 },
    { id: 'crate-4', center: { x: 12, z: -10 }, size: { x: 1.5, z: 1.5 }, height: 1 },
    { id: 'wall-2', center: { x: -2, z: 10 }, size: { x: 0.6, z: 6 }, height: 2.5 },
  ],
  platforms: [{ id: 'plateau', center: { x: 9, z: 8 }, size: { x: 6, z: 6 } }],
  ramps: [{ id: 'plateau-ramp', platform: 'plateau', side: '-z', length: 2.6, width: 2.4 }],
  collectibles: [
    { id: 'gem-1', position: { x: 0, z: -9 } },
    { id: 'gem-2', position: { x: 9, z: 8.5 } },
    { id: 'gem-3', position: { x: -12, z: 0 } },
    { id: 'gem-4', position: { x: 14, z: -14 } },
    { id: 'gem-5', position: { x: -8, z: 14 } },
  ],
  guards: [
    {
      id: 'guard-west',
      route: [
        { x: -9, z: -3 },
        { x: -1, z: -3 },
        { x: -1, z: 3 },
        { x: -9, z: 3 },
      ],
    },
    {
      id: 'guard-east',
      route: [
        { x: 16, z: -12 },
        { x: 16, z: 14 },
      ],
    },
  ],
  timeLimit: 120,
  target: 4,
};

/** 测试小关 A：出生点正前方 4 m 有一个收集点，没有守卫，目标数 1。 */
const testA: LevelLayoutInput = {
  id: 'test-a',
  name: '测试小关 A',
  size: { width: 20, depth: 20 },
  spawn: { x: 0, z: -6, yaw: 0 },
  boxes: [],
  platforms: [],
  ramps: [],
  collectibles: [{ id: 'gem-a', position: { x: 0, z: -2 } }],
  guards: [],
  timeLimit: 120,
  target: 1,
};

/** 测试小关 B：一个守卫的巡逻路线来回经过出生点，收集点在远处。 */
const testB: LevelLayoutInput = {
  id: 'test-b',
  name: '测试小关 B',
  size: { width: 24, depth: 24 },
  spawn: { x: 0, z: 0, yaw: 0 },
  boxes: [],
  platforms: [],
  ramps: [],
  collectibles: [{ id: 'gem-b', position: { x: 0, z: 10 } }],
  guards: [
    {
      id: 'guard-b',
      route: [
        { x: -3, z: 0 },
        { x: 3, z: 0 },
      ],
    },
  ],
  timeLimit: 300,
  target: 1,
};

export const BUILTIN_LEVEL_DATA: Readonly<Record<string, LevelLayoutInput>> = Object.freeze({
  meadow,
  'test-a': testA,
  'test-b': testB,
});

export const DEFAULT_LEVEL_ID = 'meadow';

export function builtinLevelIds(): string[] {
  return Object.keys(BUILTIN_LEVEL_DATA);
}

/** 加载内置关卡（经过 schema 校验）。未知 id 返回 null。 */
export function loadBuiltinLevel(id: string): LevelLayout | null {
  const data = Object.hasOwn(BUILTIN_LEVEL_DATA, id) ? BUILTIN_LEVEL_DATA[id] : undefined;
  return data ? parseLevel(structuredClone(data)) : null;
}
