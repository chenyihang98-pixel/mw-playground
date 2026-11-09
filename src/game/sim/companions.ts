// 同伴：跟随主角的角色。纯函数，按固定步长推进，和主角用同一套移动规则（stepPlayer：走跑速度、迈步、坡道、
// 重力、从边缘掉落、地图碰撞）。
//
// - 跟随：朝各自的目标点移动（SPEC.companion.follow：同伴 0 左后方、同伴 1 右后方、同伴 2 左后方更靠后，
//   左右按主角的朝向算；P6 起不再在主角正后方），到了就停下；离目标点远时跑，近时走。同伴不跳。
// - 碰撞：只和地图（障碍、高台侧面、边界）碰撞；和主角、其他同伴、守卫之间不做碰撞，可以重叠，所以不会推挡主角。
// - 被卡住：离主角超过 stuckDistance 并持续 stuckSeconds，就传送到主角附近一个站在可行走表面上、胶囊不和障碍
//   重叠的位置；找不到就留在原地，隔 retrySeconds 再试。
// - 同伴不影响胜负：收集和守卫扣时只看主角（见 game.ts）。

import { SPEC } from '../spec';
import { circleOverlapsRect } from '../level/geometry';
import { blockingRects } from './collision';
import { NO_INPUT, stepPlayer, type InputFrame, type PlayerState } from './player';
import { groundAt, type Vec3, type World } from './world';

export interface CompanionState {
  /** 外部给的标识（名册里人物的 id）。模拟只用它区分同伴，不关心含义。 */
  readonly id: string;
  /** 身体：和主角相同的状态结构（位置、竖直速度、着地、朝向、水平速度）。 */
  readonly body: PlayerState;
  /** 正在朝目标点移动（到了就停下，离开 resumeRadius 才重新起步）。 */
  readonly following: boolean;
  /** 连续离主角超过 stuckDistance 的时间（秒）。 */
  readonly farTime: number;
  /** 传送过几次。 */
  readonly teleports: number;
}

/** 第 slot 个同伴的跟随偏移（SPEC.companion.follow；超出的序号用最后一个）。 */
export function followOffset(slot: number): { readonly back: number; readonly right: number } {
  const offsets = SPEC.companion.follow;
  return offsets[Math.max(0, Math.min(slot, offsets.length - 1))] ?? { back: 0, right: 0 };
}

/** 跟随的目标点：主角身后 back、右边 right（负数是左边），左右按主角的朝向算。 */
export function followTarget(player: PlayerState, slot: number): { x: number; z: number } {
  const f = player.facing;
  // 前 = (sin f, cos f)；右 = (-cos f, sin f)（与 moveDirection 一致）
  const { back, right } = followOffset(slot);
  return {
    x: player.position.x - Math.sin(f) * back - Math.cos(f) * right,
    z: player.position.z - Math.cos(f) * back + Math.sin(f) * right,
  };
}

/**
 * (x, z) 能不能站一个同伴：胶囊在地图内；脚下是可行走的表面，高度和 refY 相差不超过迈步高度；
 * 胶囊不和任何会挡住它的实体重叠（按脚底高度、迈步余量为 0 计算，比移动时更严）。
 */
export function canStand(world: World, x: number, z: number, refY: number): boolean {
  const r = SPEC.capsule.radius;
  const b = world.bounds;
  if (!(x >= b.minX + r && x <= b.maxX - r && z >= b.minZ + r && z <= b.maxZ - r)) return false;
  const feetY = groundAt(world, x, z);
  if (Math.abs(feetY - refY) > SPEC.move.stepHeight) return false;
  return !blockingRects(world, feetY, 0, x, z).some((rect) => circleOverlapsRect(x, z, r - 1e-6, rect));
}

/**
 * 主角附近能站的位置：先试这个同伴的跟随目标点，再从主角身后开始、左右交替，一圈一圈往外找
 * （间距 placeSpacing，最多 placeRings 圈，每圈 placeDirections 个方向）。找不到返回 null。确定性：不用随机数。
 */
export function findSpotNear(world: World, player: PlayerState, slot: number): Vec3 | null {
  const refY = groundAt(world, player.position.x, player.position.z);
  const candidates: { x: number; z: number }[] = [followTarget(player, slot)];
  const c = SPEC.companion;
  const behind = player.facing + Math.PI;
  for (let ring = 1; ring <= c.placeRings; ring++) {
    const radius = c.placeSpacing * ring;
    for (let k = 0; k < c.placeDirections; k++) {
      // 0, +1, -1, +2, -2, …：从身后开始左右交替
      const step = Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
      const angle = behind + (step * 2 * Math.PI) / c.placeDirections;
      candidates.push({ x: player.position.x + Math.sin(angle) * radius, z: player.position.z + Math.cos(angle) * radius });
    }
  }
  for (const p of candidates) {
    if (canStand(world, p.x, p.z, refY)) return { x: p.x, y: groundAt(world, p.x, p.z), z: p.z };
  }
  return null;
}

function standingAt(position: Vec3, facing: number): PlayerState {
  return { position, vy: 0, grounded: true, facing, horizontalSpeed: 0, running: false };
}

/** 开局时的同伴：在主角身后附近、不和障碍重叠的位置；实在找不到时和主角站在一起（可以重叠）。 */
export function spawnCompanion(world: World, player: PlayerState, id: string, slot: number): CompanionState {
  const spot = findSpotNear(world, player, slot) ?? player.position;
  return { id, body: standingAt(spot, player.facing), following: false, farTime: 0, teleports: 0 };
}

export function spawnCompanions(world: World, player: PlayerState, ids: readonly string[]): CompanionState[] {
  return ids.map((id, slot) => spawnCompanion(world, player, id, slot));
}

/**
 * 换一组同伴：已有的（按 id）保留当前状态，新加入的在主角附近出现，不在 ids 里的移除。
 */
export function regroupCompanions(world: World, player: PlayerState, current: readonly CompanionState[], ids: readonly string[]): CompanionState[] {
  const existing = new Map(current.map((c) => [c.id, c]));
  return ids.map((id, slot) => existing.get(id) ?? spawnCompanion(world, player, id, slot));
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 推进一个同伴一步。player 是这一步之后的主角。 */
export function stepCompanion(world: World, companion: CompanionState, player: PlayerState, slot: number, dt: number): CompanionState {
  const c = SPEC.companion;
  const body = companion.body;
  const target = followTarget(player, slot);
  const dx = target.x - body.position.x;
  const dz = target.z - body.position.z;
  const distance = Math.hypot(dx, dz);
  const following = companion.following ? distance > c.arriveRadius : distance > c.resumeRadius;

  let input: InputFrame = NO_INPUT;
  if (following) {
    const run = distance > c.runDistance;
    const speed = run ? SPEC.move.runSpeed : SPEC.move.walkSpeed;
    // 最后一小段按剩下的距离减速，正好停在目标点上，不会冲过头
    const forward = Math.min(1, distance / (speed * dt));
    input = { forward, right: 0, run, jump: false, cameraYaw: Math.atan2(dx, dz) };
  }
  let next = stepPlayer(world, body, input, dt);

  const far = Math.hypot(horizontalDistance(next.position, player.position), next.position.y - player.position.y) > c.stuckDistance;
  let farTime = far ? companion.farTime + dt : 0;
  let teleports = companion.teleports;
  let stillFollowing = following;
  if (farTime >= c.stuckSeconds - 1e-9) {
    const spot = findSpotNear(world, player, slot);
    if (spot) {
      next = standingAt(spot, player.facing);
      farTime = 0;
      teleports++;
      stillFollowing = false;
    } else {
      // 找不到位置：留在原地，隔 retrySeconds 再试
      farTime = c.stuckSeconds - c.retrySeconds;
    }
  }
  return { id: companion.id, body: next, following: stillFollowing, farTime, teleports };
}

export function stepCompanions(world: World, companions: readonly CompanionState[], player: PlayerState, dt: number): CompanionState[] {
  return companions.map((companion, slot) => stepCompanion(world, companion, player, slot, dt));
}
