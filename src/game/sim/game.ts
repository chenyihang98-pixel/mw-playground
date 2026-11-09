// 游戏规则：收集、计时、守卫扣时、胜负、暂停、重开。全部是纯函数，按固定步长推进：
// 输入状态 + 输入 + 步长 → 新状态。不依赖墙钟，也不依赖 three 的对象；渲染层只读状态。

import type { LevelLayout } from '../level/schema';
import { SPEC } from '../spec';
import { regroupCompanions, spawnCompanions, stepCompanions, type CompanionState } from './companions';
import { capsulesTouch, spawnGuards, stepGuards, type GuardState } from './guards';
import { spawnPlayer, stepPlayer, type InputFrame, type PlayerState } from './player';
import { buildWorld, type Vec3, type World } from './world';

export type Phase = 'ready' | 'playing' | 'paused' | 'won' | 'lost';

export interface HitRecord {
  /** 模拟时间（秒，从开始游玩算起）。 */
  readonly at: number;
  readonly guard: string;
  /** 扣时之后的剩余时间。 */
  readonly timeLeftAfter: number;
}

export interface GameResult {
  readonly outcome: 'won' | 'lost';
  readonly reason: 'collected' | 'time';
  readonly at: number;
}

export interface GameState {
  readonly level: LevelLayout;
  readonly world: World;
  readonly phase: Phase;
  /** 已推进的模拟时间（秒）。只在 playing 时增加。 */
  readonly simTime: number;
  readonly steps: number;
  readonly timeLeft: number;
  readonly player: PlayerState;
  readonly guards: readonly GuardState[];
  /** 同伴（P4）：跟随主角，只和地图碰撞，不影响胜负。 */
  readonly companions: readonly CompanionState[];
  /** 已收集的收集点 id（按收集顺序）。 */
  readonly collected: readonly string[];
  /** 守卫扣时后的剩余冷却（秒）；为 0 时再接触才会扣时。 */
  readonly hitCooldown: number;
  readonly hits: readonly HitRecord[];
  readonly result: GameResult | null;
}

const COOLDOWN_EPSILON = 1e-9;
const TIME_EPSILON = 1e-9;

/** 关卡的初始状态（phase = ready，等玩家点“开始”）。companionIds 是同伴的标识（按顺序），同伴出现在主角身后附近。 */
export function createInitialState(level: LevelLayout, companionIds: readonly string[] = []): GameState {
  const world = buildWorld(level);
  const player = spawnPlayer(world, level.spawn.x, level.spawn.z, level.spawn.yaw);
  return {
    level,
    world,
    phase: 'ready',
    simTime: 0,
    steps: 0,
    timeLeft: level.timeLimit,
    player,
    guards: spawnGuards(world),
    companions: spawnCompanions(world, player, companionIds),
    collected: [],
    hitCooldown: 0,
    hits: [],
    result: null,
  };
}

export function startGame(state: GameState): GameState {
  return state.phase === 'ready' ? { ...state, phase: 'playing' } : state;
}

export function setPaused(state: GameState, paused: boolean): GameState {
  if (paused && state.phase === 'playing') return { ...state, phase: 'paused' };
  if (!paused && state.phase === 'paused') return { ...state, phase: 'playing' };
  return state;
}

export function togglePause(state: GameState): GameState {
  return setPaused(state, state.phase === 'playing');
}

/** 重开：恢复关卡的初始状态（同伴保持同一组，回到初始位置）。 */
export function restartGame(state: GameState): GameState {
  return createInitialState(state.level, state.companions.map((c) => c.id));
}

/**
 * 换一组同伴（名册里的分工变了）：已有的保留当前状态，新加入的出现在主角附近，不在 ids 里的移除。
 * 还没开始时，所有同伴都回到开局的位置。
 */
export function setCompanions(state: GameState, ids: readonly string[]): GameState {
  const same = ids.length === state.companions.length && ids.every((id, i) => state.companions[i]?.id === id);
  if (same) return state;
  const companions =
    state.phase === 'ready' ? spawnCompanions(state.world, state.player, ids) : regroupCompanions(state.world, state.player, state.companions, ids);
  return { ...state, companions };
}

/** 收集点中心到玩家胶囊轴线（脚底以上 r 到 h − r 的竖直线段）的距离。 */
export function distanceToCapsuleAxis(feet: Vec3, point: Vec3): number {
  const r = SPEC.capsule.radius;
  const bottom = feet.y + r;
  const top = feet.y + SPEC.capsule.height - r;
  const vertical = point.y > top ? point.y - top : point.y < bottom ? bottom - point.y : 0;
  return Math.hypot(point.x - feet.x, point.z - feet.z, vertical);
}

/** 推进一步。只有 playing 时才推进；暂停、未开始、已分胜负时原样返回。 */
export function stepGame(state: GameState, input: InputFrame, dt: number = SPEC.sim.fixedStep): GameState {
  if (state.phase !== 'playing' || !(dt > 0) || !Number.isFinite(dt)) return state;
  const simTime = state.simTime + dt;
  const player = stepPlayer(state.world, state.player, input, dt);

  const newlyCollected = state.world.collectibles
    .filter((c) => !state.collected.includes(c.id) && distanceToCapsuleAxis(player.position, c.center) <= SPEC.collect.radius)
    .map((c) => c.id);
  const collected = newlyCollected.length > 0 ? [...state.collected, ...newlyCollected] : state.collected;

  const guards = stepGuards(state.world, state.guards, dt);
  // 同伴只读主角的位置；收集和扣时下面只看主角，同伴不参与
  const companions = stepCompanions(state.world, state.companions, player, dt);
  let timeLeft = state.timeLeft - dt;
  let hitCooldown = state.hitCooldown - dt;
  if (hitCooldown <= COOLDOWN_EPSILON) hitCooldown = 0;
  let hits = state.hits;
  if (hitCooldown === 0) {
    const toucher = guards.find((g) => capsulesTouch(g.position, player.position));
    if (toucher) {
      timeLeft -= SPEC.guard.penaltySeconds;
      hitCooldown = SPEC.guard.cooldownSeconds;
      hits = [...hits, { at: simTime, guard: toucher.id, timeLeftAfter: Math.max(0, timeLeft) }];
    }
  }

  let phase: Phase = 'playing';
  let result: GameResult | null = null;
  if (collected.length >= state.level.target) {
    phase = 'won';
    result = { outcome: 'won', reason: 'collected', at: simTime };
  } else if (timeLeft <= TIME_EPSILON) {
    // 固定步长累加有浮点误差：2 秒的限时在第 120 步时可能还剩 1e-15 秒，按用完处理。
    timeLeft = 0;
    phase = 'lost';
    result = { outcome: 'lost', reason: 'time', at: simTime };
  }

  return {
    ...state,
    phase,
    simTime,
    steps: state.steps + 1,
    timeLeft,
    player,
    guards,
    companions,
    collected,
    hitCooldown,
    hits,
    result,
  };
}

export interface AdvanceResult {
  readonly state: GameState;
  /** 剩下不足一步的时间，留给下一帧。 */
  readonly accumulator: number;
  readonly steps: number;
}

/**
 * 固定步长累加器：把一帧经过的时间（elapsed，秒）换成若干个固定步。
 * 本身是纯函数，elapsed 由调用方给出（页面里来自 requestAnimationFrame，测试里直接给数）。
 * 只有 playing 时推进；其他阶段丢弃累计的时间，所以暂停期间的时间不会在继续时补上。
 * input.jump 只用于这一帧的第一步。
 */
export function advance(state: GameState, input: InputFrame, accumulator: number, elapsed: number): AdvanceResult {
  if (state.phase !== 'playing') return { state, accumulator: 0, steps: 0 };
  const step = SPEC.sim.fixedStep;
  let acc = accumulator + (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0);
  let current = state;
  let frameInput = input;
  let steps = 0;
  while (acc >= step - 1e-9 && steps < SPEC.sim.maxStepsPerFrame) {
    current = stepGame(current, frameInput, step);
    acc -= step;
    steps++;
    frameInput = frameInput.jump ? { ...frameInput, jump: false } : frameInput;
    if (current.phase !== 'playing') return { state: current, accumulator: 0, steps };
  }
  // 卡顿时最多追 maxStepsPerFrame 步，多出来的时间丢掉。
  return { state: current, accumulator: Math.min(Math.max(acc, 0), step), steps };
}
