// 一关的完整内容（P5）：布局 + 视觉预设 + 生效的规则 + 来源。内置关卡、随机关卡、已保存的关卡都用这个结构加载。
// 重玩已保存的关卡时直接用这里保存的布局和规则，不重新生成，也不重算时间。

import { DEFAULT_VISUAL, type Brief, type VisualPreset } from '../level/gen/brief';
import type { ProducedLevel } from '../level/gen/pipeline';
import { canonicalJson, hash64 } from '../level/gen/random';
import type { LevelLayout } from '../level/schema';
import type { GameRules } from '../sim';
import { SPEC } from '../spec';

/** 来源：内置、随机、程序调整（随机生成时说明书被调整过），以后还有模型（P8）。 */
export type LevelSource = 'builtin' | 'random' | 'adjusted' | 'model';

/** 这一关最终生效的规则：时间限制、收集目标数、守卫扣时和冷却。 */
export interface LevelRules extends GameRules {
  readonly timeLimit: number;
  readonly target: number;
}

export interface LevelAdjustment {
  readonly reason: 'cannot-fit' | 'too-far';
  readonly change: string;
  readonly message: string;
  /** 调整前的说明书。 */
  readonly requestedBrief: Brief;
}

export interface LevelPackage {
  /** 'builtin:<id>'、'saved:<id>' 或 'preview:<布局哈希>'。 */
  readonly key: string;
  readonly source: LevelSource;
  readonly title: string;
  readonly layout: LevelLayout;
  readonly visual: VisualPreset;
  readonly rules: LevelRules;
  /** 由说明书生成的关卡才有（P2 的三张手工地图没有）。 */
  readonly brief: Brief | null;
  readonly seed: string | null;
  readonly schemaVersion: number | null;
  readonly generatorVersion: number | null;
  readonly adjustment: LevelAdjustment | null;
  /** 布局的哈希（规范 JSON 的 64 位 FNV-1a）。 */
  readonly layoutHash: string;
}

export function layoutHash(layout: LevelLayout): string {
  return hash64(canonicalJson(layout));
}

/** 按当前的规格得到的规则（生成新关卡时用；已保存的关卡用保存的值）。 */
export function rulesFromLayout(layout: LevelLayout): LevelRules {
  return { timeLimit: layout.timeLimit, target: layout.target, penaltySeconds: SPEC.guard.penaltySeconds, cooldownSeconds: SPEC.guard.cooldownSeconds };
}

/** P2 的手工地图：视觉预设 grass / day / clear。 */
export function packageOfLayout(key: string, layout: LevelLayout, visual: VisualPreset = DEFAULT_VISUAL): LevelPackage {
  return {
    key,
    source: 'builtin',
    title: layout.name,
    layout,
    visual,
    rules: rulesFromLayout(layout),
    brief: null,
    seed: null,
    schemaVersion: null,
    generatorVersion: null,
    adjustment: null,
    layoutHash: layoutHash(layout),
  };
}

/** 随机生成（预览）的关卡。确认之后才保存。 */
export function packageOfProduced(level: ProducedLevel): LevelPackage {
  const hash = layoutHash(level.layout);
  return {
    key: `preview:${hash}`,
    source: level.adjustment ? 'adjusted' : 'random',
    title: level.brief.title,
    layout: level.layout,
    visual: level.brief.visual,
    rules: rulesFromLayout(level.layout),
    brief: level.brief,
    seed: level.seed,
    schemaVersion: level.schemaVersion,
    generatorVersion: level.generatorVersion,
    adjustment: level.adjustment
      ? { reason: level.adjustment.reason, change: level.adjustment.change, message: level.adjustment.message, requestedBrief: level.adjustment.from }
      : null,
    layoutHash: hash,
  };
}
