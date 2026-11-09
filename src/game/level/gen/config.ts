// 关卡生成（P5）的配置：说明书各字段的范围、档位、生成器的尺度、检查器的网格、难度系数和时间上下限。
// 纯模块。改这里的值时同时改 docs/status.md 的 P5 一节。
// 难度系数、余量、时间上下限都是估计值，以后会按试玩结果调整；已保存的关卡不受影响（保存的是最终的 timeLimit）。

export const TIERS = ['small', 'medium', 'large'] as const;
export type Tier = (typeof TIERS)[number];

export const DENSITIES = ['low', 'mid', 'high'] as const;
export type Density = (typeof DENSITIES)[number];

export const DISTRIBUTIONS = ['scattered', 'edge', 'elevated', 'clustered'] as const;
export type Distribution = (typeof DISTRIBUTIONS)[number];

export const PATROLS = ['loop', 'back-and-forth'] as const;
export type Patrol = (typeof PATROLS)[number];

export const INTENTS = ['relaxed', 'normal', 'tense'] as const;
export type Intent = (typeof INTENTS)[number];

export const THEMES = ['grass', 'sand', 'snow'] as const;
export const TIMES_OF_DAY = ['day', 'dusk', 'night'] as const;
export const WEATHERS = ['clear', 'fog', 'rain'] as const;
export type Theme = (typeof THEMES)[number];
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];
export type Weather = (typeof WEATHERS)[number];

export interface TierConfig {
  /** 地图边长（米，正方形）。 */
  readonly size: number;
  /** 收集点数量的范围（含两端）。 */
  readonly collectibles: { readonly min: number; readonly max: number };
  /** 守卫数量的上限。 */
  readonly maxGuards: number;
  /** 时间限制的上下限（秒）。 */
  readonly timeLimit: { readonly min: number; readonly max: number };
  /** 各档障碍密度对应的障碍（盒子）数量。 */
  readonly obstacles: Readonly<Record<Density, number>>;
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child as object);
  }
  return Object.freeze(value);
}

export const GEN_CONFIG = deepFreeze({
  tiers: {
    small: { size: 24, collectibles: { min: 2, max: 5 }, maxGuards: 1, timeLimit: { min: 30, max: 120 }, obstacles: { low: 8, mid: 16, high: 48 } },
    medium: { size: 36, collectibles: { min: 3, max: 7 }, maxGuards: 2, timeLimit: { min: 40, max: 180 }, obstacles: { low: 14, mid: 32, high: 60 } },
    large: { size: 48, collectibles: { min: 4, max: 9 }, maxGuards: 3, timeLimit: { min: 60, max: 240 }, obstacles: { low: 26, mid: 60, high: 110 } },
  } satisfies Readonly<Record<Tier, TierConfig>>,
  brief: {
    /** 高台数量的范围（含两端）。 */
    platforms: { min: 0, max: 4 },
    /** 同伴最多几个（与名册的规则一致）。 */
    maxCompanions: 3,
    titleMaxLength: 24,
    openingMaxLength: 160,
    lineMaxLength: 48,
    /** 人物 ID 最长几个字符（名册里是 64 位十六进制的 SHA-256）。 */
    personIdMaxLength: 128,
  },
  generator: {
    /** 生成器版本：生成规则变了就加 1。已保存和内置的关卡以冻结的布局为准，不因版本变化重新生成。 */
    version: 1,
    /** 每份说明书最多做几次布局尝试（每次用由种子派生的子种子）。 */
    attempts: 8,
    /** 粗网格的格子边长（米）：通道、障碍、高台都按格子摆。 */
    cell: 2,
    /** 盒子、高台离所在格子边界的最小距离（米），通道因此至少宽 cell + 2 × margin。 */
    margin: 0.35,
    /** 盒子的高度范围（米）。 */
    boxHeight: { min: 0.6, max: 2.4 },
    /** 坡道的宽度和长度范围（米）。长度不小于 SPEC.terrain.rampMinLength。 */
    rampWidth: { min: 1.1, max: 1.3 },
    rampLength: { min: 2.6, max: 3.6 },
  },
  check: {
    /** 寻路网格的边长（米）。障碍按“胶囊半径 + 半个格子对角线”膨胀，判定是保守的。 */
    grid: 0.25,
    /** 出生点和守卫起点、巡逻路线之间的最小距离（米）。 */
    spawnGuardDistance: 5,
  },
  timing: {
    /** 难度意向的系数：时间限制 ≈ 路线时间 × 系数 + 余量。 */
    intent: { relaxed: 2.6, normal: 2, tense: 1.5 } satisfies Readonly<Record<Intent, number>>,
    /** 最低余量（秒）。 */
    margin: 20,
  },
  random: {
    /** “随机一关”最多尝试几份说明书；都失败就加载回退关卡。 */
    briefs: 3,
  },
});

/** 难度系数里最小的那个（tense），判定“太远”用。 */
export function minimumIntentFactor(): number {
  return Math.min(...INTENTS.map((intent) => GEN_CONFIG.timing.intent[intent]));
}
