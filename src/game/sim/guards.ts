// 守卫：沿巡逻路线循环移动；与玩家胶囊的接触判定。纯函数。

import { SPEC } from '../spec';
import { groundAt, type GuardRoute, type Vec3, type World } from './world';

export interface GuardState {
  readonly id: string;
  /** 沿路线走过的距离（对路线总长取模）。 */
  readonly distance: number;
  /** 脚底中心。 */
  readonly position: Vec3;
  /** 朝向（弧度，0 表示面向 +Z）。 */
  readonly facing: number;
}

/** 路线上距离起点 distance 处的位置和前进方向。 */
export function pointOnRoute(route: GuardRoute, distance: number): { x: number; z: number; facing: number } {
  const n = route.points.length;
  let remaining = route.totalLength > 0 ? ((distance % route.totalLength) + route.totalLength) % route.totalLength : 0;
  for (let i = 0; i < n; i++) {
    const a = route.points[i];
    const b = route.points[(i + 1) % n];
    const length = route.segmentLengths[i] ?? 0;
    if (!a || !b) break;
    if (remaining <= length || i === n - 1) {
      const t = length > 0 ? Math.min(1, remaining / length) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, facing: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    remaining -= length;
  }
  const first = route.points[0] ?? { x: 0, z: 0 };
  return { x: first.x, z: first.z, facing: 0 };
}

export function guardAt(world: World, route: GuardRoute, distance: number): GuardState {
  const p = pointOnRoute(route, distance);
  return { id: route.id, distance, position: { x: p.x, y: groundAt(world, p.x, p.z), z: p.z }, facing: p.facing };
}

export function spawnGuards(world: World): GuardState[] {
  return world.guardRoutes.map((route) => guardAt(world, route, 0));
}

export function stepGuards(world: World, guards: readonly GuardState[], dt: number): GuardState[] {
  return guards.map((guard, i) => {
    const route = world.guardRoutes[i];
    if (!route || route.totalLength <= 0) return guard;
    return guardAt(world, route, (guard.distance + SPEC.guard.speed * dt) % route.totalLength);
  });
}

/** 两个竖直胶囊（脚底位置 a、b）是否接触：水平距离小于两个半径之和，并且竖直范围有重叠。 */
export function capsulesTouch(a: Vec3, b: Vec3): boolean {
  const horizontal = Math.hypot(a.x - b.x, a.z - b.z);
  return horizontal < 2 * SPEC.capsule.radius && Math.abs(a.y - b.y) < SPEC.capsule.height;
}
