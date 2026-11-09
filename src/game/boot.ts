// 选择关卡并启动游戏。关卡一律经过 schema 校验（loadBuiltinLevel → parseLevel）。
// P5 起 ?level= 也能选由生成器做出的内置关卡（gen-1 等）；默认仍进入 meadow。

import { BUILTIN_LEVEL_DATA, DEFAULT_LEVEL_ID, builtinLevelIds, loadBuiltinLevel } from './level/builtin';
import type { LevelLayout } from './level/schema';
import { builtinEntries, builtinPackage } from './levels/catalog';
import type { LevelPackage } from './levels/package';

/** 要加载的关卡。requested 为 null 或未知 id 时用默认地图（未知 id 打一条警告）。 */
export function resolveLevel(requested: string | null): LevelLayout {
  if (requested !== null) {
    const level = loadBuiltinLevel(requested);
    if (level) return level;
    console.warn(`未知关卡 "${requested}"，改用默认关卡 ${DEFAULT_LEVEL_ID}。可选：${builtinLevelIds().join('、')}`);
  }
  const fallback = loadBuiltinLevel(DEFAULT_LEVEL_ID);
  if (!fallback) throw new Error(`默认关卡 ${DEFAULT_LEVEL_ID} 不存在`);
  return fallback;
}

/** 启动时要加载的一关（含视觉预设和规则）。requested 为 null 或未知 id 时用默认地图（未知 id 打一条警告）。 */
export function resolveLevelPackage(requested: string | null): LevelPackage {
  if (requested !== null) {
    const pkg = builtinPackage(requested);
    if (pkg) return pkg;
    console.warn(`未知关卡 "${requested}"，改用默认关卡 ${DEFAULT_LEVEL_ID}。可选：${builtinEntries().map((e) => e.id).join('、')}`);
  }
  const fallback = builtinPackage(DEFAULT_LEVEL_ID);
  if (!fallback) throw new Error(`默认关卡 ${DEFAULT_LEVEL_ID} 不存在`);
  return fallback;
}

/** 测试钩子的 listLevels：P2 的三张手工地图（原样保留）。P5 的内置关卡在关卡选择界面里，也能用 ?level= 打开。 */
export function levelList(): { id: string; name: string }[] {
  return builtinLevelIds().map((id) => ({ id, name: BUILTIN_LEVEL_DATA[id]?.name ?? id }));
}
