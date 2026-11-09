// 选择关卡并启动游戏。关卡一律经过 schema 校验（loadBuiltinLevel → parseLevel）。

import { BUILTIN_LEVEL_DATA, DEFAULT_LEVEL_ID, builtinLevelIds, loadBuiltinLevel } from './level/builtin';
import type { LevelLayout } from './level/schema';

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

export function levelList(): { id: string; name: string }[] {
  return builtinLevelIds().map((id) => ({ id, name: BUILTIN_LEVEL_DATA[id]?.name ?? id }));
}
