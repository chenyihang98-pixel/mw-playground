// 难度估计和时间推算（P5）。纯模块。系数、余量、上下限都在 config.ts，是估计值，以后会按试玩结果调整。
//
// - 路线时间 T：从出生点出发，每次去最近的（按检查器网格上的路径长度）还没收集的必需收集点，按跑速算。不求最优路线。
// - 太远：T × 三档难度系数里最小的那个 + 最低余量 > 档位的时间上限。太远就返回“太远”，不截到上限当作合理。
// - 否则：timeLimit = 把（T × 本关难度意向的系数 + 最低余量）向上取整到秒，再限制在档位的上下限之间。

import { SPEC } from '../../spec';
import type { CheckReport } from './checker';
import { GEN_CONFIG, INTENTS, type Intent, type Tier } from './config';
import { t } from '../../../i18n';

type GenConfig = typeof GEN_CONFIG;

export interface RouteEstimate {
  /** 按检查器网格算的路径总长（米）。 */
  readonly distance: number;
  /** 按跑速算的路线时间 T（秒）。 */
  readonly seconds: number;
  /** 收集的顺序（收集点 id）。 */
  readonly order: readonly string[];
}

/** 路线时间：用检查器自己的导航网格（不用生成器的任何结构）。检查没通过或有收集点走不到时返回 null。 */
export function routeTime(report: CheckReport): RouteEstimate | null {
  const nav = report.navigation;
  const level = report.level;
  if (!nav || !level || report.spawn.length === 0) return null;
  let sources: readonly { node: number; cost: number }[] = report.spawn;
  const remaining = [...report.reach];
  const order: string[] = [];
  let distance = 0;
  while (order.length < level.target) {
    const dist = nav.distances(sources);
    let best: { index: number; node: number; d: number } | null = null;
    remaining.forEach((c, index) => {
      for (const node of c.nodes) {
        const d = dist[node] ?? Infinity;
        if (Number.isFinite(d) && (!best || d < best.d)) best = { index, node, d };
      }
    });
    const chosen = best as { index: number; node: number; d: number } | null;
    if (!chosen) return null;
    distance += chosen.d;
    const [collected] = remaining.splice(chosen.index, 1);
    if (collected) order.push(collected.id);
    sources = [{ node: chosen.node, cost: 0 }];
  }
  return { distance, seconds: distance / SPEC.move.runSpeed, order };
}

export type TimeDecision =
  | { readonly ok: true; readonly timeLimit: number; readonly raw: number; readonly routeSeconds: number }
  | { readonly ok: false; readonly reason: 'too-far'; readonly message: string; readonly routeSeconds: number; readonly needed: number };

/** 三档难度系数里最小的那个（tense）。 */
export function tightestFactor(config: GenConfig = GEN_CONFIG): number {
  return Math.min(...INTENTS.map((intent) => config.timing.intent[intent]));
}

/** 按路线时间决定时间限制，或判定“太远”。config 可以替换（测试用；已保存的关卡不再调用这里）。 */
export function decideTimeLimit(routeSeconds: number, intent: Intent, tier: Tier, config: GenConfig = GEN_CONFIG): TimeDecision {
  const bounds = config.tiers[tier].timeLimit;
  const margin = config.timing.margin;
  const needed = routeSeconds * tightestFactor(config) + margin;
  if (!Number.isFinite(routeSeconds) || needed > bounds.max) {
    return {
      ok: false,
      reason: 'too-far',
      routeSeconds,
      needed,
      message:
        t('timing.tooFar', { route: routeSeconds.toFixed(1), factor: String(tightestFactor(config)), margin: String(margin), needed: needed.toFixed(0), tier, max: String(bounds.max) }),
    };
  }
  const raw = routeSeconds * config.timing.intent[intent] + margin;
  const timeLimit = Math.min(bounds.max, Math.max(bounds.min, Math.ceil(raw)));
  return { ok: true, timeLimit, raw, routeSeconds };
}
