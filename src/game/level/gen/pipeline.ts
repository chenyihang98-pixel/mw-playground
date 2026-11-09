// 从说明书做出一关（P5）：校验说明书 → 最多 attempts 次布局尝试（每次用由种子派生的子种子）→ 硬检查 → 时间推算。
// 纯模块，确定性：种子、说明书和生成器版本都相同时，结果也相同。
//
// - 说明书错误（schema 或组合冲突、人物不在名册里）：直接返回，不改值。
// - 放不下：所有尝试都放不下时返回原因，交给调用方。
// - 检查没通过：生成器做出了本不该做出的布局，是程序缺陷。直接返回（kind: 'rejected'），不用别的子种子重试掩盖。
// - 太远：路线时间按最紧的系数也超过档位的上限时返回，不截到上限。
// - 程序调整（可选，最多一次，规则固定）：放不下时障碍密度降一档，已经是 low 时收集点数减到档位范围的下限；
//   太远时收集点数减到下限，已经是下限时不调整。调整后的说明书和原因都记下来，然后重新生成、重新检查。

import { parseLevel, type LevelLayout } from '../schema';
import { BRIEF_SCHEMA_VERSION, parseBrief, type Brief, type BriefProblem } from './brief';
import { checkLevel, type CheckProblem } from './checker';
import { GEN_CONFIG, type Density } from './config';
import { generateLayout } from './generator';
import { deriveSeed } from './random';
import { decideTimeLimit, routeTime } from './timing';

type GenConfig = typeof GEN_CONFIG;

export interface Adjustment {
  readonly reason: 'cannot-fit' | 'too-far';
  /** 触发调整的原因（调整前那一次的失败说明）。 */
  readonly message: string;
  /** 改了什么（例如“障碍密度 high → mid”）。 */
  readonly change: string;
  readonly from: Brief;
  readonly to: Brief;
}

export interface ProducedLevel {
  /** 最终用的说明书（调整过时是调整后的）。 */
  readonly brief: Brief;
  /** 调用方给的说明书（规范化之后）。 */
  readonly requestedBrief: Brief;
  readonly seed: string;
  readonly layout: LevelLayout;
  readonly timeLimit: number;
  /** 路线时间 T（秒）和路径长度（米）。 */
  readonly routeSeconds: number;
  readonly routeDistance: number;
  readonly adjustment: Adjustment | null;
  /** 用了几次布局尝试（含调整之后的）。 */
  readonly attempts: number;
  readonly schemaVersion: number;
  readonly generatorVersion: number;
}

export type ProduceResult =
  | { readonly ok: true; readonly level: ProducedLevel }
  | { readonly ok: false; readonly kind: 'brief'; readonly problems: readonly BriefProblem[] }
  | {
      readonly ok: false;
      readonly kind: 'cannot-fit' | 'too-far';
      readonly message: string;
      readonly reasons: readonly string[];
      readonly attempts: number;
      readonly adjustment: Adjustment | null;
    }
  | { readonly ok: false; readonly kind: 'rejected'; readonly problems: readonly CheckProblem[]; readonly attempts: number; readonly adjustment: Adjustment | null };

export interface ProduceOptions {
  /** 名册里现有人物的 ID：说明书里的出场人物必须在这里面。 */
  readonly rosterIds?: ReadonlySet<string>;
  /** 是否允许一次程序调整（默认允许）。 */
  readonly adjust?: boolean;
  /** 替换配置（测试用）。 */
  readonly config?: GenConfig;
}

type RunResult =
  | { readonly ok: true; readonly layout: LevelLayout; readonly timeLimit: number; readonly routeSeconds: number; readonly routeDistance: number; readonly attempts: number }
  | { readonly ok: false; readonly kind: 'cannot-fit' | 'too-far'; readonly message: string; readonly reasons: readonly string[]; readonly attempts: number }
  | { readonly ok: false; readonly kind: 'rejected'; readonly problems: readonly CheckProblem[]; readonly attempts: number };

function run(brief: Brief, seed: string, config: GenConfig): RunResult {
  const reasons: string[] = [];
  const total = config.generator.attempts;
  for (let attempt = 0; attempt < total; attempt++) {
    const generated = generateLayout(brief, deriveSeed(seed, `attempt-${String(attempt)}`), config);
    if (!generated.ok) {
      if (!reasons.includes(generated.reason)) reasons.push(generated.reason);
      continue;
    }
    const report = checkLevel(generated.layout, { brief, grid: config.check.grid, spawnGuardDistance: config.check.spawnGuardDistance });
    if (!report.ok) return { ok: false, kind: 'rejected', problems: report.problems, attempts: attempt + 1 };
    const route = routeTime(report);
    if (!route) {
      return {
        ok: false,
        kind: 'rejected',
        problems: [{ category: 'layout', code: 'route', message: '检查通过了，但路线时间算不出来（有收集点走不到）' }],
        attempts: attempt + 1,
      };
    }
    const decision = decideTimeLimit(route.seconds, brief.intent, brief.tier, config);
    if (!decision.ok) return { ok: false, kind: 'too-far', message: decision.message, reasons: [decision.message], attempts: attempt + 1 };
    const layout = parseLevel({ ...generated.layout, timeLimit: decision.timeLimit });
    return { ok: true, layout, timeLimit: decision.timeLimit, routeSeconds: route.seconds, routeDistance: route.distance, attempts: attempt + 1 };
  }
  const tier = config.tiers[brief.tier];
  return {
    ok: false,
    kind: 'cannot-fit',
    reasons,
    attempts: total,
    message: `放不下：${brief.tier} 地图（${String(tier.size)} m）试了 ${String(total)} 次都放不下这么多收集点、高台、守卫和障碍，可以减少数量或换成更大的地图档位`,
  };
}

const LOWER_DENSITY: Readonly<Record<Density, Density | null>> = { high: 'mid', mid: 'low', low: null };

/** 程序调整的固定规则；没有可调的时返回 null。 */
export function adjustBrief(brief: Brief, reason: 'cannot-fit' | 'too-far', config: GenConfig = GEN_CONFIG): { brief: Brief; change: string } | null {
  const minimum = config.tiers[brief.tier].collectibles.min;
  if (reason === 'cannot-fit') {
    const lower = LOWER_DENSITY[brief.density];
    if (lower) return { brief: { ...brief, density: lower }, change: `障碍密度 ${brief.density} → ${lower}` };
  }
  if (brief.collectibles > minimum) {
    return { brief: { ...brief, collectibles: minimum }, change: `收集点数 ${String(brief.collectibles)} → ${String(minimum)}（档位范围的下限）` };
  }
  return null;
}

/** 从说明书和种子做出一关。 */
export function produceLevel(input: unknown, seed: string, options: ProduceOptions = {}): ProduceResult {
  const config = options.config ?? GEN_CONFIG;
  const parsed = parseBrief(input, options.rosterIds);
  if (!parsed.ok) return { ok: false, kind: 'brief', problems: parsed.problems };
  const requested = parsed.brief;

  const finish = (brief: Brief, result: RunResult, adjustment: Adjustment | null, attemptsBefore: number): ProduceResult => {
    const attempts = attemptsBefore + result.attempts;
    if (result.ok) {
      return {
        ok: true,
        level: {
          brief,
          requestedBrief: requested,
          seed,
          layout: result.layout,
          timeLimit: result.timeLimit,
          routeSeconds: result.routeSeconds,
          routeDistance: result.routeDistance,
          adjustment,
          attempts,
          schemaVersion: BRIEF_SCHEMA_VERSION,
          generatorVersion: config.generator.version,
        },
      };
    }
    if (result.kind === 'rejected') return { ok: false, kind: 'rejected', problems: result.problems, attempts, adjustment };
    return { ok: false, kind: result.kind, message: result.message, reasons: result.reasons, attempts, adjustment };
  };

  const first = run(requested, seed, config);
  if (first.ok || first.kind === 'rejected' || options.adjust === false) return finish(requested, first, null, 0);
  const adjusted = adjustBrief(requested, first.kind, config);
  if (!adjusted) return finish(requested, first, null, 0);
  const adjustment: Adjustment = { reason: first.kind, message: first.message, change: adjusted.change, from: requested, to: adjusted.brief };
  const second = run(adjusted.brief, deriveSeed(seed, 'adjusted'), config);
  return finish(adjusted.brief, second, adjustment, first.attempts);
}
