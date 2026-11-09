// 内置关卡（P5）：P2 的三张手工地图（视觉预设 grass / day / clear，原样保留）和由生成器做出、冻结下来的关卡。
// 冻结的关卡以保存的布局和规则为准，加载时不重新生成，也不重算时间。

import { BUILTIN_LEVEL_DATA, builtinLevelIds, loadBuiltinLevel } from '../level/builtin';
import { briefSchema } from '../level/gen/brief';
import { FALLBACK_LEVEL_ID, GENERATED_LEVELS } from '../level/generatedLevels';
import { parseLevel } from '../level/schema';
import { layoutHash, packageOfLayout, type LevelPackage } from './package';

export interface BuiltinEntry {
  readonly id: string;
  readonly title: string;
  /** P2 的手工地图或生成器做出的冻结关卡。 */
  readonly kind: 'handmade' | 'generated';
}

export function builtinEntries(): BuiltinEntry[] {
  return [
    ...builtinLevelIds().map((id) => ({ id, title: BUILTIN_LEVEL_DATA[id]?.name ?? id, kind: 'handmade' as const })),
    ...GENERATED_LEVELS.map((l) => ({ id: l.id, title: l.layout.name, kind: 'generated' as const })),
  ];
}

/** 内置关卡；未知 id 返回 null。 */
export function builtinPackage(id: string): LevelPackage | null {
  const handmade = loadBuiltinLevel(id);
  if (handmade) return packageOfLayout(`builtin:${id}`, handmade);
  const frozen = GENERATED_LEVELS.find((l) => l.id === id);
  if (!frozen) return null;
  const layout = parseLevel(structuredClone(frozen.layout));
  const brief = briefSchema.parse(frozen.brief);
  return {
    key: `builtin:${id}`,
    source: 'builtin',
    title: layout.name,
    layout,
    visual: brief.visual,
    rules: { ...frozen.rules },
    brief,
    seed: frozen.seed,
    schemaVersion: frozen.schemaVersion,
    generatorVersion: frozen.generatorVersion,
    adjustment: null,
    layoutHash: layoutHash(layout),
  };
}

/** 最终的回退关卡（新增的第 1 关）。 */
export function fallbackPackage(): LevelPackage {
  const pkg = builtinPackage(FALLBACK_LEVEL_ID);
  if (!pkg) throw new Error(`回退关卡 ${FALLBACK_LEVEL_ID} 不存在`);
  return pkg;
}
