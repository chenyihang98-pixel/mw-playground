// 说明书之间的主要差别（P8）：程序调整前后、请求和回退关卡之间。给玩家看的简短说明。纯模块。

import type { Brief } from '../game/level/gen/brief';

const TIER: Readonly<Record<string, string>> = { small: '小地图', medium: '中地图', large: '大地图' };
const DENSITY: Readonly<Record<string, string>> = { low: '少', mid: '中', high: '多' };
const DISTRIBUTION: Readonly<Record<string, string>> = { scattered: '分散', edge: '靠边', elevated: '只放在高台上', clustered: '集中' };
const PATROL: Readonly<Record<string, string>> = { loop: '绕圈', 'back-and-forth': '来回' };
const INTENT: Readonly<Record<string, string>> = { relaxed: '轻松', normal: '普通', tense: '紧张' };
const THEME: Readonly<Record<string, string>> = { grass: '草地', sand: '沙地', snow: '雪地' };
const TIME: Readonly<Record<string, string>> = { day: '白天', dusk: '黄昏', night: '夜晚' };
const WEATHER: Readonly<Record<string, string>> = { clear: '晴', fog: '雾', rain: '雨' };

const say = (table: Readonly<Record<string, string>>, value: string) => table[value] ?? value;

/** from → to 改了哪些（只列玩家看得出来的字段）。 */
export function briefDifferences(from: Brief, to: Brief): string[] {
  const out: string[] = [];
  const add = (label: string, a: string, b: string) => {
    if (a !== b) out.push(`${label}：${a} → ${b}`);
  };
  add('地图', say(TIER, from.tier), say(TIER, to.tier));
  add('障碍', say(DENSITY, from.density), say(DENSITY, to.density));
  add('高台', `${String(from.platforms)} 个`, `${String(to.platforms)} 个`);
  add('宝石', `${String(from.collectibles)} 个`, `${String(to.collectibles)} 个`);
  add('宝石分布', say(DISTRIBUTION, from.distribution), say(DISTRIBUTION, to.distribution));
  add('守卫', `${String(from.guards)} 个`, `${String(to.guards)} 个`);
  add('巡逻', say(PATROL, from.patrol), say(PATROL, to.patrol));
  add('难度', say(INTENT, from.intent), say(INTENT, to.intent));
  add(
    '视觉',
    `${say(THEME, from.visual.theme)} · ${say(TIME, from.visual.time)} · ${say(WEATHER, from.visual.weather)}`,
    `${say(THEME, to.visual.theme)} · ${say(TIME, to.visual.time)} · ${say(WEATHER, to.visual.weather)}`,
  );
  if (from.cast.length !== to.cast.length) out.push(`出场人物：${String(from.cast.length)} 个 → ${String(to.cast.length)} 个`);
  return out;
}

/** 回退关卡和请求的主要差别。requested 是模型最后一次写出的合法说明书（没有时为 null）。 */
export function fallbackDifferences(requested: Brief | null, fallback: Brief, fallbackTitle: string): string[] {
  if (!requested) return [`模型没有写出可用的说明书，回退关卡“${fallbackTitle}”不是按你的描述做的`];
  return [`不是按你的描述生成的关卡，换成了内置的“${fallbackTitle}”`, ...briefDifferences(requested, fallback)];
}
