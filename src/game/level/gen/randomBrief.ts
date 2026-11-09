// 随机说明书（P5 的“随机一关”）：由种子决定，只产出合法的组合（不会出现 elevated 配 0 个高台这类组合）。纯模块。
// 出场人物从名册里现有的人物中选，可以为空。

import { MAX_COLLECTIBLES_PER_PLATFORM, BRIEF_SCHEMA_VERSION, parseBrief, type Brief, type BriefCast } from './brief';
import { DENSITIES, DISTRIBUTIONS, GEN_CONFIG, INTENTS, PATROLS, THEMES, TIERS, TIMES_OF_DAY, WEATHERS, type Distribution, type Tier } from './config';
import { Rng } from './random';

export interface RosterPerson {
  readonly id: string;
  readonly name: string;
}

const TITLES = ['宝石小径', '迷雾庭院', '箱子迷宫', '高台寻宝', '巡逻之夜', '沙丘拾遗', '雪地小镇', '黄昏集市', '石阶之间', '风中的宝石'];
const OPENINGS = [
  '宝石散落在各处，赶在时间用完之前把它们都找回来。',
  '守卫在附近巡逻，绕开他们，收集所有宝石。',
  '这片地方的路有些曲折，看清方向再出发。',
  '高处也许藏着宝石，找找坡道在哪里。',
  '',
];
const COMPANION_LINES = ['我跟着你，别走太快。', '一起去找宝石吧！', '我在后面看着呢。', '前面好像有东西。'];
const GUARD_LINES = ['站住！', '这里不许通过。', '我会一直盯着你。', '又有人来了……'];

/** 由种子做一份随机的、合法的说明书。tier 给出时固定档位。 */
export function randomBrief(seed: string, people: readonly RosterPerson[] = [], options: { tier?: Tier } = {}): Brief {
  const rng = new Rng(seed);
  const tier = options.tier ?? rng.pick(TIERS);
  const t = GEN_CONFIG.tiers[tier];
  const maxPlatforms = tier === 'small' ? 2 : tier === 'medium' ? 3 : GEN_CONFIG.brief.platforms.max;
  const platforms = rng.int(0, maxPlatforms);
  // elevated 只在高台够放下档位下限数量的收集点时才可选
  const distributions: Distribution[] = DISTRIBUTIONS.filter(
    (d) => d !== 'elevated' || (platforms > 0 && platforms * MAX_COLLECTIBLES_PER_PLATFORM >= t.collectibles.min),
  );
  const distribution = rng.pick(distributions);
  const maxCollectibles = distribution === 'elevated' ? Math.min(t.collectibles.max, platforms * MAX_COLLECTIBLES_PER_PLATFORM) : t.collectibles.max;
  const collectibles = rng.int(t.collectibles.min, maxCollectibles);
  const guards = rng.int(0, t.maxGuards);

  const shuffled = rng.shuffle(people);
  const companionCount = rng.int(0, Math.min(GEN_CONFIG.brief.maxCompanions, shuffled.length));
  const guardCount = rng.int(0, Math.min(guards, shuffled.length - companionCount));
  const cast: BriefCast[] = [
    ...shuffled.slice(0, companionCount).map((p) => ({ personId: p.id, role: 'companion' as const, line: rng.pick(COMPANION_LINES) })),
    ...shuffled.slice(companionCount, companionCount + guardCount).map((p) => ({ personId: p.id, role: 'guard' as const, line: rng.pick(GUARD_LINES) })),
  ];

  const brief: Brief = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    tier,
    density: rng.pick(DENSITIES),
    platforms,
    collectibles,
    distribution,
    guards,
    patrol: rng.pick(PATROLS),
    intent: rng.pick(INTENTS),
    visual: { theme: rng.pick(THEMES), time: rng.pick(TIMES_OF_DAY), weather: rng.pick(WEATHERS) },
    title: rng.pick(TITLES),
    opening: rng.pick(OPENINGS),
    cast,
  };
  // 只产出合法的组合：按同样的规则校验一遍（不合法就是这里的规则写错了，直接报错暴露出来）
  const checked = parseBrief(brief, new Set(people.map((p) => p.id)));
  if (!checked.ok) throw new Error(`随机说明书不合法：${checked.problems.map((p) => `${p.path}：${p.message}`).join('；')}`);
  return checked.brief;
}
