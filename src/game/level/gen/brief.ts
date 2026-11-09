// 关卡说明书（P5 起，P8 的关卡工坊共用）：只描述“想要什么样的关卡”，不含坐标和时间限制。
// 具体布局由生成器根据种子做出来，再由独立的检查器核对。
//
// - schema（zod）检查字段和类型；strictObject 不接受多余的字段，所以坐标、时间限制之类的字段进不来。
// - 组合规则（briefProblems）另外检查，冲突时返回具体、能照着改的原因（P8 会交给模型修复），不悄悄改值。
// - 规范化只做两件事：去掉标题、开场白、台词首尾的空白；其余字段原样保留。

import { z } from 'zod';
import {
  DENSITIES,
  DISTRIBUTIONS,
  GEN_CONFIG,
  INTENTS,
  PATROLS,
  THEMES,
  TIERS,
  TIMES_OF_DAY,
  WEATHERS,
  type Density,
  type Distribution,
  type Intent,
  type Patrol,
  type Theme,
  type Tier,
  type TimeOfDay,
  type Weather,
} from './config';

export const BRIEF_SCHEMA_VERSION = 1;

/** elevated 时每个高台最多放几个收集点（高台顶面的空间有限）。 */
export const MAX_COLLECTIBLES_PER_PLATFORM = 2;

const b = GEN_CONFIG.brief;

const castSchema = z.strictObject({
  /** 名册里人物的 ID（文件内容的 SHA-256）。 */
  personId: z.string().trim().min(1).max(b.personIdMaxLength),
  role: z.enum(['companion', 'guard']),
  /** 一句台词（显示在关卡开始前的说明面板里）。 */
  line: z.string().trim().max(b.lineMaxLength),
});

export const visualPresetSchema = z.strictObject({
  theme: z.enum(THEMES),
  time: z.enum(TIMES_OF_DAY),
  weather: z.enum(WEATHERS),
});

export const briefSchema = z.strictObject({
  schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
  /** 地图档位。 */
  tier: z.enum(TIERS),
  /** 障碍密度。 */
  density: z.enum(DENSITIES),
  /** 高台数量。 */
  platforms: z.number().int().min(b.platforms.min).max(b.platforms.max),
  /** 收集点数量（范围随档位变化，见组合规则）。 */
  collectibles: z.number().int().min(1),
  /** 收集点分布。elevated 在界面上叫“只放在高台上”。 */
  distribution: z.enum(DISTRIBUTIONS),
  /** 守卫数量（上限随档位变化，见组合规则）。 */
  guards: z.number().int().min(0),
  /** 巡逻方式。 */
  patrol: z.enum(PATROLS),
  /** 难度意向。 */
  intent: z.enum(INTENTS),
  /** 视觉预设。 */
  visual: visualPresetSchema,
  title: z.string().trim().min(1).max(b.titleMaxLength),
  /** 开场白（可以为空）。 */
  opening: z.string().trim().max(b.openingMaxLength),
  /** 出场人物（可以为空）。 */
  cast: z.array(castSchema).max(b.maxCompanions + Math.max(...TIERS.map((t) => GEN_CONFIG.tiers[t].maxGuards))),
});

export type Brief = z.output<typeof briefSchema>;
export type BriefInput = z.input<typeof briefSchema>;
export type BriefCast = Brief['cast'][number];
export type VisualPreset = z.output<typeof visualPresetSchema>;
export type { Density, Distribution, Intent, Patrol, Theme, Tier, TimeOfDay, Weather };

export const DEFAULT_VISUAL: VisualPreset = Object.freeze({ theme: 'grass', time: 'day', weather: 'clear' });

/** 说明书错误：字段（路径）和能照着改的原因。 */
export interface BriefProblem {
  readonly path: string;
  readonly message: string;
}

/** 组合规则。rosterIds 给出时，出场人物必须在名册里。返回所有冲突；空数组表示没有问题。 */
export function briefProblems(brief: Brief, rosterIds?: ReadonlySet<string>): BriefProblem[] {
  const problems: BriefProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  const tier = GEN_CONFIG.tiers[brief.tier];
  const range = tier.collectibles;

  if (brief.collectibles < range.min || brief.collectibles > range.max) {
    add(
      'collectibles',
      `${brief.tier} 地图的收集点数量要在 ${String(range.min)}–${String(range.max)} 之间，现在是 ${String(brief.collectibles)}：改成这个范围里的数，或换一个地图档位`,
    );
  }
  if (brief.guards > tier.maxGuards) {
    add('guards', `${brief.tier} 地图最多 ${String(tier.maxGuards)} 个守卫，现在是 ${String(brief.guards)}：减少守卫，或换成更大的地图档位`);
  }
  if (brief.distribution === 'elevated') {
    if (brief.platforms === 0) {
      add('distribution', '收集点分布是 elevated（只放在高台上），但高台数量是 0：把高台数量改成 1–4，或换一种分布');
    } else if (brief.collectibles > brief.platforms * MAX_COLLECTIBLES_PER_PLATFORM) {
      add(
        'collectibles',
        `收集点只放在高台上时，每个高台最多 ${String(MAX_COLLECTIBLES_PER_PLATFORM)} 个：${String(brief.platforms)} 个高台最多 ${String(brief.platforms * MAX_COLLECTIBLES_PER_PLATFORM)} 个收集点，现在是 ${String(brief.collectibles)}：减少收集点、增加高台，或换一种分布`,
      );
    }
  }

  const guardCast = brief.cast.filter((c) => c.role === 'guard').length;
  const companionCast = brief.cast.filter((c) => c.role === 'companion').length;
  if (guardCast > brief.guards) {
    add('cast', `出场人物里有 ${String(guardCast)} 个守卫，但守卫数量是 ${String(brief.guards)}：减少出场的守卫，或把守卫数量加到 ${String(guardCast)}（不超过档位上限 ${String(tier.maxGuards)}）`);
  }
  if (companionCast > b.maxCompanions) {
    add('cast', `出场人物里有 ${String(companionCast)} 个同伴，最多 ${String(b.maxCompanions)} 个：减少出场的同伴`);
  }
  const seen = new Set<string>();
  brief.cast.forEach((c, i) => {
    if (seen.has(c.personId)) add(`cast.${String(i)}.personId`, `人物 ${c.personId} 在出场人物里出现了不止一次：每个人物只能出场一次`);
    seen.add(c.personId);
    if (rosterIds && !rosterIds.has(c.personId)) {
      add(`cast.${String(i)}.personId`, `出场人物 ${c.personId} 不在名册里：从名册里选人物，或去掉这一项`);
    }
  });
  return problems;
}

export type BriefResult = { readonly ok: true; readonly brief: Brief } | { readonly ok: false; readonly problems: readonly BriefProblem[] };

/** 解析并校验说明书：先按 schema，再按组合规则。不改值（只去掉文字首尾的空白）。 */
export function parseBrief(input: unknown, rosterIds?: ReadonlySet<string>): BriefResult {
  const version = typeof input === 'object' && input !== null ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== BRIEF_SCHEMA_VERSION) {
    const shown = typeof version === 'number' || typeof version === 'string' ? String(version) : '缺失';
    return { ok: false, problems: [{ path: 'schemaVersion', message: `说明书版本（${shown}）认不出：本版只认 schemaVersion ${String(BRIEF_SCHEMA_VERSION)}` }] };
  }
  const parsed = briefSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') || '(根)', message: issue.message })),
    };
  }
  const problems = briefProblems(parsed.data, rosterIds);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, brief: parsed.data };
}
