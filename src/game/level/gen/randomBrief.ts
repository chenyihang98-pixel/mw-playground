// 随机说明书（P5 的“随机一关”）：由种子决定，只产出合法的组合（不会出现 elevated 配 0 个高台这类组合）。纯模块。
// 出场人物从名册里现有的人物中选，可以为空。
// F6：标题、开场白、台词按当前语言生成。随机数从同样长度的词条列表里选（选的是词条，调用时再取当前语言的文字），
// 所以同一个种子在各语言下抽到的数和组合都相同；中文下和 F6 之前逐字一致（单元测试核对）。

import { MAX_COLLECTIBLES_PER_PLATFORM, BRIEF_SCHEMA_VERSION, parseBrief, type Brief, type BriefCast } from './brief';
import { DENSITIES, DISTRIBUTIONS, GEN_CONFIG, INTENTS, PATROLS, THEMES, TIERS, TIMES_OF_DAY, WEATHERS, type Distribution, type Tier } from './config';
import { Rng } from './random';
import { t as tr, type MessageKey } from '../../../i18n';

export interface RosterPerson {
  readonly id: string;
  readonly name: string;
}

const TITLES: readonly MessageKey[] = [
  'randomText.title0',
  'randomText.title1',
  'randomText.title2',
  'randomText.title3',
  'randomText.title4',
  'randomText.title5',
  'randomText.title6',
  'randomText.title7',
  'randomText.title8',
  'randomText.title9',
];
/** 最后一项是没有开场白（空字符串）。 */
const OPENINGS: readonly (MessageKey | null)[] = ['randomText.opening0', 'randomText.opening1', 'randomText.opening2', 'randomText.opening3', null];
const COMPANION_LINES: readonly MessageKey[] = ['randomText.companionLine0', 'randomText.companionLine1', 'randomText.companionLine2', 'randomText.companionLine3'];
const GUARD_LINES: readonly MessageKey[] = ['randomText.guardLine0', 'randomText.guardLine1', 'randomText.guardLine2', 'randomText.guardLine3'];

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
    ...shuffled.slice(0, companionCount).map((p) => ({ personId: p.id, role: 'companion' as const, line: tr(rng.pick(COMPANION_LINES)) })),
    ...shuffled.slice(companionCount, companionCount + guardCount).map((p) => ({ personId: p.id, role: 'guard' as const, line: tr(rng.pick(GUARD_LINES)) })),
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
    title: tr(rng.pick(TITLES)),
    opening: textOf(rng.pick(OPENINGS)),
    cast,
  };
  // 只产出合法的组合：按同样的规则校验一遍（不合法就是这里的规则写错了，直接报错暴露出来）
  const checked = parseBrief(brief, new Set(people.map((p) => p.id)));
  if (!checked.ok) throw new Error(`随机说明书不合法：${checked.problems.map((p) => `${p.path}：${p.message}`).join('；')}`);
  return checked.brief;
}

function textOf(key: MessageKey | null): string {
  return key === null ? '' : tr(key);
}
