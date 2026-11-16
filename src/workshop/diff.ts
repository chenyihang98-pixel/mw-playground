// 说明书之间的主要差别（P8）：程序调整前后、请求和回退关卡之间。给玩家看的简短说明。纯模块。
// F7：按 tr 的语言写（工坊服务按请求的语言传进来；没给时用当前语言）。

import type { Brief } from '../game/level/gen/brief';
import { t, type MessageKey, type Translate } from '../i18n';

const TIER: Readonly<Record<string, MessageKey>> = { small: 'diff.tierSmall', medium: 'diff.tierMedium', large: 'diff.tierLarge' };
const DENSITY: Readonly<Record<string, MessageKey>> = { low: 'density.low', mid: 'density.mid', high: 'density.high' };
const DISTRIBUTION: Readonly<Record<string, MessageKey>> = {
  scattered: 'distribution.scattered',
  edge: 'distribution.edge',
  elevated: 'distribution.elevated',
  clustered: 'distribution.clustered',
};
const PATROL: Readonly<Record<string, MessageKey>> = { loop: 'patrol.loop', 'back-and-forth': 'patrol.backAndForth' };
const INTENT: Readonly<Record<string, MessageKey>> = { relaxed: 'intent.relaxed', normal: 'intent.normal', tense: 'intent.tense' };
const THEME: Readonly<Record<string, MessageKey>> = { grass: 'theme.grass', sand: 'theme.sand', snow: 'theme.snow' };
const TIME: Readonly<Record<string, MessageKey>> = { day: 'time.day', dusk: 'time.dusk', night: 'time.night' };
const WEATHER: Readonly<Record<string, MessageKey>> = { clear: 'weather.clear', fog: 'weather.fog', rain: 'weather.rain' };

/** from → to 改了哪些（只列玩家看得出来的字段）。 */
export function briefDifferences(from: Brief, to: Brief, tr: Translate = t): string[] {
  const say = (table: Readonly<Record<string, MessageKey>>, value: string) => {
    const key = table[value];
    return key ? tr(key) : value;
  };
  const count = (n: number) => tr('preview.count', { count: String(n) });
  const look = (b: Brief) => `${say(THEME, b.visual.theme)} · ${say(TIME, b.visual.time)} · ${say(WEATHER, b.visual.weather)}`;
  const out: string[] = [];
  const add = (label: MessageKey, a: string, b: string) => {
    if (a !== b) out.push(tr('diff.change', { label: tr(label), from: a, to: b }));
  };
  add('preview.map', say(TIER, from.tier), say(TIER, to.tier));
  add('diff.obstacles', say(DENSITY, from.density), say(DENSITY, to.density));
  add('preview.platforms', count(from.platforms), count(to.platforms));
  add('preview.gems', count(from.collectibles), count(to.collectibles));
  add('diff.distribution', say(DISTRIBUTION, from.distribution), say(DISTRIBUTION, to.distribution));
  add('preview.guards', count(from.guards), count(to.guards));
  add('diff.patrol', say(PATROL, from.patrol), say(PATROL, to.patrol));
  add('diff.intent', say(INTENT, from.intent), say(INTENT, to.intent));
  add('preview.visual', look(from), look(to));
  if (from.cast.length !== to.cast.length) add('diff.cast', count(from.cast.length), count(to.cast.length));
  return out;
}

/** 回退关卡和请求的主要差别。requested 是模型最后一次写出的合法说明书（没有时为 null）。fallbackTitle 是回退关卡在这种语言里的名字。 */
export function fallbackDifferences(requested: Brief | null, fallback: Brief, fallbackTitle: string, tr: Translate = t): string[] {
  if (!requested) return [tr('diff.noBrief', { title: fallbackTitle })];
  return [tr('diff.notYours', { title: fallbackTitle }), ...briefDifferences(requested, fallback, tr)];
}
