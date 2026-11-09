// 片段的规则（纯函数，不依赖 three）：播放方式、用途识别、自动建议、手动覆盖、动作槽位、兜底方案。
// 片段一律按序号标识（稳定标识是“文件 SHA-256 + 序号”），名字只用来显示和识别用途。

import { CLIP_RULES } from './limits';

export type Purpose = 'idle' | 'walk' | 'run' | 'jump' | 'other';
export type Playback = 'loop' | 'once';
/** 加载后 clip.userData.loop 的情况：true / false 是明确值；缺失和非布尔值都算“未知”。 */
export type LoopRaw = 'true' | 'false' | 'missing' | 'other';

export const PURPOSES: readonly Purpose[] = ['idle', 'walk', 'run', 'jump', 'other'];
export const SLOT_PURPOSES = ['idle', 'walk', 'run', 'jump'] as const;
export type SlotPurpose = (typeof SLOT_PURPOSES)[number];

export const PURPOSE_LABELS: Readonly<Record<Purpose, string>> = {
  idle: '待机',
  walk: '走',
  run: '跑',
  jump: '跳',
  other: '其他',
};

/** 一个片段的原始事实（由加载后的 AnimationClip 得到）。 */
export interface ClipFacts {
  readonly index: number;
  /** 显示名：加载后的 clip.name（GLTFLoader 给无名片段起名 animation_<序号>）。 */
  readonly name: string;
  readonly duration: number;
  /** 所有轨道里最多的关键帧数。 */
  readonly keyframes: number;
  readonly loopRaw: LoopRaw;
  readonly loopValue: unknown;
  /** 带位移，并且没有锁定水平位移。 */
  readonly rootMotionActive: boolean;
}

export interface ClipOverrides {
  /** 手动指定的用途（按序号）。 */
  readonly purpose: ReadonlyMap<number, Purpose>;
  /** 手动指定的播放方式（按序号），与用途分开保存。 */
  readonly playback: ReadonlyMap<number, Playback>;
}

export const NO_OVERRIDES: ClipOverrides = { purpose: new Map(), playback: new Map() };

export function classifyLoop(userData: Readonly<Record<string, unknown>>): { raw: LoopRaw; value: unknown } {
  if (!Object.hasOwn(userData, 'loop')) return { raw: 'missing', value: undefined };
  const value = userData.loop;
  if (value === true) return { raw: 'true', value };
  if (value === false) return { raw: 'false', value };
  return { raw: 'other', value };
}

// ---------- 用途识别 ----------

/** 动作类关键词：名字里出现这些词时归为“其他”，优先于移动关键词（例如 “Rifle Aiming Idle” 是瞄准，不是待机）。 */
const ACTION_WORDS = ['aim', 'fire', 'firing', 'shoot', 'reload', 'attack', 'punch', 'kick', 'hit', 'death', 'die', 'dying', 'dance'];
const ACTION_CJK = ['瞄准', '射击', '开火', '换弹', '装弹', '攻击', '受击', '死亡', '跳舞'];

const PURPOSE_WORDS: readonly (readonly [Purpose, readonly string[], readonly string[]])[] = [
  // [用途, 英文词（按词首匹配）, 中文（按子串匹配）]；按这个顺序判断，先命中先用
  ['jump', ['jump'], ['跳']],
  ['run', ['run', 'sprint', 'jog'], ['奔跑', '跑']],
  ['walk', ['walk'], ['行走', '走']],
  ['idle', ['idle', 'stand'], ['待机', '站立']],
];

/** 把名字拆成小写英文词：按非字母数字分隔，并拆开驼峰（“RifleRun” → rifle, run；“TPose” → t, pose）。 */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** 按名字里的关键词判断用途。中英文都认，不区分大小写；认不出的归为“其他”。 */
export function recognizePurpose(name: string): Purpose {
  const tokens = nameTokens(name);
  const lower = name.toLowerCase();
  const hasWord = (words: readonly string[]) => tokens.some((t) => words.some((w) => t.startsWith(w)));
  if (hasWord(ACTION_WORDS) || ACTION_CJK.some((w) => lower.includes(w))) return 'other';
  for (const [purpose, words, cjk] of PURPOSE_WORDS) {
    if (hasWord(words) || cjk.some((w) => lower.includes(w))) return purpose;
  }
  return 'other';
}

/** 时长极短的片段（例如只有一帧的姿势片段）。 */
export function isShortClip(facts: Pick<ClipFacts, 'duration' | 'keyframes'>): boolean {
  return facts.duration < CLIP_RULES.shortClipSeconds || facts.keyframes <= 1;
}

// ---------- 决策 ----------

export type PlaybackSource = 'manual' | 'explicit' | 'inferred';

export interface ClipDecision {
  readonly index: number;
  /** 按名字识别的用途。 */
  readonly recognized: Purpose;
  /** 生效的用途：手动指定优先，否则是识别的用途。 */
  readonly purpose: Purpose;
  readonly purposeSource: 'manual' | 'auto';
  readonly playback: Playback;
  readonly playbackSource: PlaybackSource;
  readonly short: boolean;
  readonly rootMotionActive: boolean;
  /** 这个片段被选为某个动作槽位（待机 / 走 / 跑 / 跳）。 */
  readonly slot: SlotPurpose | null;
  /** 为什么没被选为槽位等说明。 */
  readonly notes: readonly string[];
}

export type Slots = Readonly<Record<SlotPurpose, number | null>>;

function inferPlayback(purpose: Purpose): Playback {
  return purpose === 'idle' || purpose === 'walk' || purpose === 'run' ? 'loop' : 'once';
}

function eligibleForAuto(facts: ClipFacts, purpose: SlotPurpose): string | null {
  if (purpose === 'jump') return null;
  if (isShortClip(facts)) return `时长极短（${facts.duration.toFixed(3)} 秒），不作为“${PURPOSE_LABELS[purpose]}”的自动建议`;
  if (facts.rootMotionActive) return `带位移，默认不作为“${PURPOSE_LABELS[purpose]}”的自动建议`;
  return null;
}

/**
 * 决定每个片段的用途、播放方式，以及每个动作槽位用哪个片段。
 *
 * 槽位规则（同一用途有多个片段时）：
 * 1. 有手动把用途设为这一项的片段：用其中序号最小的；
 * 2. 否则在“识别为这一用途、没有手动改成别的用途”的片段里选：待机、走、跑排除极短的片段和带位移的片段；
 *    优先 loop 明确为预期值的（待机、走、跑为 true，跳为 false），再按序号从小到大取第一个。
 */
export function decideClips(facts: readonly ClipFacts[], overrides: ClipOverrides = NO_OVERRIDES): { clips: ClipDecision[]; slots: Slots } {
  const effective = facts.map((f) => {
    const recognized = recognizePurpose(f.name);
    const manual = overrides.purpose.get(f.index);
    return { facts: f, recognized, purpose: manual ?? recognized, manual: manual !== undefined };
  });
  const notes = new Map<number, string[]>(facts.map((f) => [f.index, []]));
  const note = (index: number, text: string) => notes.get(index)?.push(text);

  const slots: Record<SlotPurpose, number | null> = { idle: null, walk: null, run: null, jump: null };
  for (const purpose of SLOT_PURPOSES) {
    const manual = effective.filter((e) => e.manual && e.purpose === purpose).sort((a, b) => a.facts.index - b.facts.index);
    if (manual.length > 0) {
      slots[purpose] = manual[0]?.facts.index ?? null;
      for (const extra of manual.slice(1)) note(extra.facts.index, `也被手动设为“${PURPOSE_LABELS[purpose]}”，使用序号更小的 #${String(slots[purpose])}`);
      for (const e of effective) {
        if (!e.manual && e.recognized === purpose) note(e.facts.index, `识别为“${PURPOSE_LABELS[purpose]}”，已被手动选择覆盖`);
      }
      continue;
    }
    const auto = effective.filter((e) => !e.manual && e.recognized === purpose);
    const eligible = auto.filter((e) => {
      const reason = eligibleForAuto(e.facts, purpose);
      if (reason) note(e.facts.index, reason);
      return reason === null;
    });
    const preferred = purpose === 'jump' ? 'false' : 'true';
    eligible.sort((a, b) => {
      const pa = a.facts.loopRaw === preferred ? 0 : 1;
      const pb = b.facts.loopRaw === preferred ? 0 : 1;
      return pa - pb || a.facts.index - b.facts.index;
    });
    const chosen = eligible[0];
    slots[purpose] = chosen?.facts.index ?? null;
    for (const other of eligible.slice(1)) {
      note(other.facts.index, `同为“${PURPOSE_LABELS[purpose]}”，建议使用 #${String(chosen?.facts.index)}；可以手动选择这一个`);
    }
  }

  const slotOf = new Map<number, SlotPurpose>();
  for (const purpose of SLOT_PURPOSES) {
    const index = slots[purpose];
    if (index !== null) slotOf.set(index, purpose);
  }

  const clips = effective.map((e): ClipDecision => {
    const manualPlayback = overrides.playback.get(e.facts.index);
    let playback: Playback;
    let playbackSource: PlaybackSource;
    if (manualPlayback !== undefined) {
      playback = manualPlayback;
      playbackSource = 'manual';
    } else if (e.facts.loopRaw === 'true' || e.facts.loopRaw === 'false') {
      playback = e.facts.loopRaw === 'true' ? 'loop' : 'once';
      playbackSource = 'explicit';
    } else {
      playback = inferPlayback(e.purpose);
      playbackSource = 'inferred';
    }
    return {
      index: e.facts.index,
      recognized: e.recognized,
      purpose: e.purpose,
      purposeSource: e.manual ? 'manual' : 'auto',
      playback,
      playbackSource,
      short: isShortClip(e.facts),
      rootMotionActive: e.facts.rootMotionActive,
      slot: slotOf.get(e.facts.index) ?? null,
      notes: notes.get(e.facts.index) ?? [],
    };
  });
  return { clips, slots };
}

// ---------- 兜底 ----------

export type MotionSource =
  | { readonly kind: 'clip'; readonly index: number; readonly timeScale: number }
  | { readonly kind: 'firstFrame'; readonly index: number }
  | { readonly kind: 'bindPose' }
  | { readonly kind: 'sway' };

export interface AnimationPlan {
  readonly idle: MotionSource;
  readonly walk: MotionSource;
  readonly run: MotionSource;
  /** 没有跳的片段时为 null：跳跃时保持当前的动作。 */
  readonly jump: MotionSource | null;
  /** 没有任何适用的移动动作：移动时让模型整体上下晃动、向前倾。 */
  readonly sway: boolean;
  readonly notices: readonly string[];
}

export const NO_MOVEMENT_NOTICE = '没有适用的移动动作，将使用整体摆动效果';

/**
 * 兜底规则：
 * - 没有走：用跑，放慢播放（走速 / 跑速）；没有跑：用走，加快播放（跑速 / 走速）。
 * - 没有待机：用走（含上一条由跑得到的走）的第一帧静止；也没有走：用绑定姿态。
 * - 走和跑都没有（包括静态模型，以及只有节点动画、但用途都不是移动的模型）：移动时整体摆动。
 */
export function planAnimations(slots: Slots, speeds: { walkSpeed: number; runSpeed: number }): AnimationPlan {
  const notices: string[] = [];
  let walk: MotionSource | null = null;
  let run: MotionSource | null = null;
  if (slots.walk !== null) walk = { kind: 'clip', index: slots.walk, timeScale: 1 };
  if (slots.run !== null) run = { kind: 'clip', index: slots.run, timeScale: 1 };
  if (walk === null && slots.run !== null) {
    walk = { kind: 'clip', index: slots.run, timeScale: speeds.walkSpeed / speeds.runSpeed };
    notices.push('没有“走”的片段：用“跑”的片段放慢播放');
  }
  if (run === null && slots.walk !== null) {
    run = { kind: 'clip', index: slots.walk, timeScale: speeds.runSpeed / speeds.walkSpeed };
    notices.push('没有“跑”的片段：用“走”的片段加快播放');
  }
  const sway = walk === null || run === null;
  if (sway) notices.push(NO_MOVEMENT_NOTICE);

  let idle: MotionSource;
  if (slots.idle !== null) {
    idle = { kind: 'clip', index: slots.idle, timeScale: 1 };
  } else if (walk?.kind === 'clip') {
    idle = { kind: 'firstFrame', index: walk.index };
    notices.push('没有“待机”的片段：用“走”的第一帧静止');
  } else {
    idle = { kind: 'bindPose' };
    notices.push('没有“待机”的片段：使用绑定姿态');
  }
  const jump: MotionSource | null = slots.jump !== null ? { kind: 'clip', index: slots.jump, timeScale: 1 } : null;
  if (jump === null) notices.push('没有“跳”的片段：跳跃时保持当前的动作');

  return {
    idle,
    walk: walk ?? { kind: 'sway' },
    run: run ?? { kind: 'sway' },
    jump,
    sway,
    notices,
  };
}
