// 只在开发和测试模式下能用 ?level= 打开的关卡（P6）：给“失败”结算截图用的限时很短的小关。
// 不出现在关卡选择里，也不在测试钩子的 listLevels 里；生产构建里 main.ts 不会调用这里，整个模块被去掉。
// 规则和别的关卡一样（时间到了就失败），只是时间限制短。

import { parseLevel } from '../game/level/schema';
import { packageOfLayout, type LevelPackage } from '../game/levels/package';

/** 测试小关：限时 6 秒，收集点在出生点远处的角落里，站着不动就会因为时间到而失败。 */
const TIMEOUT_LEVEL = {
  id: 'test-timeout',
  name: '测试小关：限时',
  size: { width: 20, depth: 20 },
  spawn: { x: 0, z: -6, yaw: 0 },
  boxes: [],
  platforms: [],
  ramps: [],
  collectibles: [{ id: 'gem-t', position: { x: 7, z: 7 } }],
  guards: [],
  timeLimit: 6,
  target: 1,
};

export function devLevelPackage(id: string): LevelPackage | null {
  if (id !== TIMEOUT_LEVEL.id) return null;
  return packageOfLayout(`dev:${TIMEOUT_LEVEL.id}`, parseLevel(structuredClone(TIMEOUT_LEVEL)));
}
