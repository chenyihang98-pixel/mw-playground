// 模拟用的世界数据：由关卡布局一次性推导出来，之后只读。纯模块。

import { groundHeightAt, layoutSolids, mapBounds, type Point2, type Rect, type Solid } from '../level/geometry';
import type { LevelLayout } from '../level/schema';
import { SPEC } from '../spec';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CollectibleSpot {
  readonly id: string;
  /** 收集点中心：所在表面高度 + SPEC.collect.hoverHeight。 */
  readonly center: Vec3;
}

export interface GuardRoute {
  readonly id: string;
  readonly points: readonly Point2[];
  /** 第 i 段从 points[i] 到 points[(i+1) % n]。 */
  readonly segmentLengths: readonly number[];
  readonly totalLength: number;
}

export interface World {
  readonly bounds: Rect;
  readonly solids: readonly Solid[];
  readonly collectibles: readonly CollectibleSpot[];
  readonly guardRoutes: readonly GuardRoute[];
}

export function buildWorld(level: LevelLayout): World {
  const solids = layoutSolids(level);
  return {
    bounds: mapBounds(level),
    solids,
    collectibles: level.collectibles.map((c) => ({
      id: c.id,
      center: {
        x: c.position.x,
        y: groundHeightAt(solids, c.position.x, c.position.z) + SPEC.collect.hoverHeight,
        z: c.position.z,
      },
    })),
    guardRoutes: level.guards.map((g) => {
      const n = g.route.length;
      const segmentLengths = g.route.map((p, i) => {
        const q = g.route[(i + 1) % n] ?? p;
        return Math.hypot(q.x - p.x, q.z - p.z);
      });
      return { id: g.id, points: g.route, segmentLengths, totalLength: segmentLengths.reduce((a, b) => a + b, 0) };
    }),
  };
}

export function groundAt(world: World, x: number, z: number): number {
  return groundHeightAt(world.solids, x, z);
}
