// 统一玩法规格：所有角色共用的参数只在这里定义。
// 控制器、碰撞、守卫、关卡校验，以及以后的生成器和检查器，都只从这个模块取值，不各写各的常数。
// 纯模块：不依赖 three、DOM 或墙钟。

const DEG = Math.PI / 180;

const capsule = {
  /** 胶囊半径（米）。碰撞、守卫接触、关卡校验都用它。 */
  radius: 0.35,
  /** 胶囊总高（米，脚底到头顶）。与模匠人形的默认身高 1.75 m 一致，默认主角的视觉模型也按这个高度拼。 */
  height: 1.75,
} as const;

const move = {
  /** 走路速度（米/秒）。 */
  walkSpeed: 2.2,
  /** 跑步速度（米/秒，按住 Shift）。 */
  runSpeed: 5,
  /** 朝向转向移动方向的最大角速度（弧度/秒）。 */
  turnRate: 12,
  /** 站在地面上时能直接迈上去的高度差（米）；也用作下坡时贴地的最大落差。 */
  stepHeight: 0.3,
} as const;

const jumpBase = {
  /** 起跳竖直初速度（米/秒）。 */
  speed: 4.5,
  /** 重力加速度（米/秒²）。 */
  gravity: 15,
} as const;

const jump = {
  ...jumpBase,
  /** 最大跳跃高度 = 初速度² / (2 × 重力)。 */
  maxHeight: (jumpBase.speed * jumpBase.speed) / (2 * jumpBase.gravity),
} as const;

const terrainBase = {
  /** 所有高台的高度（米）。必须大于最大跳跃高度：高台只能从坡道上去。 */
  platformHeight: 1.2,
  /** 坡道允许的最大坡度（度）。关卡里的坡道不能比它陡。 */
  rampMaxSlopeDeg: 30,
} as const;

const terrain = {
  ...terrainBase,
  /** 最大坡度对应的斜率（高/长）。 */
  rampMaxGradient: Math.tan(terrainBase.rampMaxSlopeDeg * DEG),
  /** 高台坡道的最短水平长度（米）= 高台高度 / 最大斜率。 */
  rampMinLength: terrainBase.platformHeight / Math.tan(terrainBase.rampMaxSlopeDeg * DEG),
} as const;

const guard = {
  /** 守卫巡逻速度（米/秒）。 */
  speed: 2,
  /** 守卫接触玩家时扣掉的剩余时间（秒）。 */
  penaltySeconds: 10,
  /** 扣时后的冷却时长（秒）：冷却期间再接触不扣时间。冷却是玩家身上的，对所有守卫共用。 */
  cooldownSeconds: 2,
} as const;

const collect = {
  /** 收集半径（米）：收集点中心到玩家胶囊轴线的距离不超过它就算收集到。 */
  radius: 0.8,
  /** 收集点中心离所在表面（地面或高台顶面）的高度（米）。 */
  hoverHeight: 0.9,
} as const;

const companion = {
  /** 跟随的目标点在主角身后的距离（米）。 */
  followDistance: 1.8,
  /** 有多个同伴时，各自的目标点左右错开的间距（米）。 */
  lateralSpacing: 1.1,
  /** 离目标点不超过这个距离就停下（米）。 */
  arriveRadius: 0.3,
  /** 停下之后，离目标点超过这个距离才重新起步（米），避免在目标点附近来回抖动。 */
  resumeRadius: 0.8,
  /** 离目标点超过这个距离时用跑步速度，否则用走路速度（米）。 */
  runDistance: 4,
  /** 被卡住的判定：离主角超过这个距离（米）…… */
  stuckDistance: 8,
  /** ……并且持续这么久（秒），就传送到主角附近。 */
  stuckSeconds: 3,
  /** 找不到可以传送的位置时，隔多久再试一次（秒）。 */
  retrySeconds: 0.5,
  /** 开局和传送时找位置：在主角周围按这个间距一圈一圈往外找（米），最多 placeRings 圈。 */
  placeSpacing: 1.8,
  /** 找位置时最多找几圈。 */
  placeRings: 3,
  /** 每一圈取几个方向（从主角身后开始，左右交替）。 */
  placeDirections: 16,
} as const;

const sim = {
  /** 模拟的固定步长（秒）。 */
  fixedStep: 1 / 60,
  /** 每帧最多推进的步数（渲染卡顿时防止一次追太多步）。 */
  maxStepsPerFrame: 8,
} as const;

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child as object);
  }
  return Object.freeze(value);
}

export const SPEC = deepFreeze({ capsule, move, jump, terrain, guard, collect, companion, sim });

/** 规格的结构（数值放宽成 number，便于构造变体做校验测试）。 */
type Widen<T> = { readonly [K in keyof T]: T[K] extends number ? number : Widen<T[K]> };
export type GameplaySpec = Widen<typeof SPEC>;

/** 检查规格之间的约束，返回违反的条目；空数组表示没有问题。 */
export function specProblems(spec: GameplaySpec = SPEC): string[] {
  const problems: string[] = [];
  if (spec.terrain.platformHeight <= spec.jump.maxHeight) {
    problems.push(
      `高台高度 ${spec.terrain.platformHeight} m 不大于最大跳跃高度 ${spec.jump.maxHeight.toFixed(3)} m：高台可以直接跳上去`,
    );
  }
  if (spec.terrain.platformHeight <= spec.move.stepHeight) {
    problems.push(`高台高度 ${spec.terrain.platformHeight} m 不大于迈步高度 ${spec.move.stepHeight} m：高台可以直接走上去`);
  }
  if (spec.capsule.height <= 2 * spec.capsule.radius) problems.push('胶囊高度必须大于直径');
  if (spec.move.runSpeed <= spec.move.walkSpeed) problems.push('跑步速度必须大于走路速度');
  // 坡道上走的时候，胶囊前沿比脚底高出 斜率 × 半径，必须能迈上去，否则坡道会挡路。
  if (spec.terrain.rampMaxGradient * spec.capsule.radius >= spec.move.stepHeight) {
    problems.push('最大坡度下胶囊半径范围内的升高不小于迈步高度：沿坡道走会被挡住');
  }
  const c = spec.companion;
  if (c.resumeRadius <= c.arriveRadius) problems.push('同伴重新起步的距离必须大于停下的距离');
  if (c.placeSpacing * c.placeRings >= c.stuckDistance) {
    problems.push('同伴找位置的最大范围不小于“被卡住”的距离：传送后可能马上又被判为卡住');
  }
  if (c.followDistance + c.lateralSpacing >= c.stuckDistance) problems.push('同伴的跟随位置离主角太远，会被判为卡住');
  return problems;
}
