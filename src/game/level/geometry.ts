// 由关卡布局推导出的几何：盒子、高台、坡道统一成“实体”（XZ 平面上的矩形 + 顶面高度函数）。
// 碰撞、关卡校验、渲染都用这里的结果。纯模块：不依赖 three。

import { SPEC } from '../spec';

export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** 坡道顶面升高的方向：例如 '+x' 表示 x 越大越高。 */
export type Rise = '+x' | '-x' | '+z' | '-z';
/** 坡道贴在高台的哪一侧。 */
export type Side = '+x' | '-x' | '+z' | '-z';

export interface Solid {
  readonly kind: 'box' | 'platform' | 'ramp';
  readonly id: string;
  readonly rect: Rect;
  /** 顶面最高处的高度（米）。盒子和高台是平顶，坡道是高端的高度。 */
  readonly height: number;
  /** 只有坡道有：顶面升高的方向。 */
  readonly rise?: Rise;
}

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export function rectFromCenter(center: Point2, size: Point2): Rect {
  return {
    minX: center.x - size.x / 2,
    maxX: center.x + size.x / 2,
    minZ: center.z - size.z / 2,
    maxZ: center.z + size.z / 2,
  };
}

export function rectContains(rect: Rect, x: number, z: number): boolean {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

/** 两个矩形的内部是否相交（只碰到边不算）。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

export function expandRect(rect: Rect, by: number): Rect {
  return { minX: rect.minX - by, maxX: rect.maxX + by, minZ: rect.minZ - by, maxZ: rect.maxZ + by };
}

export function rectInside(inner: Rect, outer: Rect): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minZ >= outer.minZ && inner.maxZ <= outer.maxZ;
}

/** 坡道沿升高方向的长度。 */
function riseLength(rect: Rect, rise: Rise): number {
  return rise === '+x' || rise === '-x' ? rect.maxX - rect.minX : rect.maxZ - rect.minZ;
}

/** 坡道上一点沿升高方向走过的比例（0 = 低端，1 = 高端）。 */
function riseFraction(rect: Rect, rise: Rise, x: number, z: number): number {
  const length = riseLength(rect, rise);
  let t: number;
  switch (rise) {
    case '+x':
      t = (x - rect.minX) / length;
      break;
    case '-x':
      t = (rect.maxX - x) / length;
      break;
    case '+z':
      t = (z - rect.minZ) / length;
      break;
    case '-z':
      t = (rect.maxZ - z) / length;
      break;
  }
  return Math.min(1, Math.max(0, t));
}

/** 实体在 (x, z) 处的顶面高度。调用方保证点在实体的矩形内。 */
export function surfaceHeight(solid: Solid, x: number, z: number): number {
  if (solid.rise === undefined) return solid.height;
  return solid.height * riseFraction(solid.rect, solid.rise, x, z);
}

/**
 * 实体里顶面高于 level 的部分（XZ 矩形）；没有则返回 null。
 * 平顶实体要么整块、要么没有；坡道的顶面是线性的，高于某个高度的部分仍是一个矩形。
 */
export function regionAbove(solid: Solid, level: number): Rect | null {
  if (level >= solid.height) return null;
  if (solid.rise === undefined || level < 0) return solid.rect;
  const r = solid.rect;
  const cut = (level / solid.height) * riseLength(r, solid.rise);
  switch (solid.rise) {
    case '+x':
      return { ...r, minX: r.minX + cut };
    case '-x':
      return { ...r, maxX: r.maxX - cut };
    case '+z':
      return { ...r, minZ: r.minZ + cut };
    case '-z':
      return { ...r, maxZ: r.maxZ - cut };
  }
}

/** 贴在高台某一侧的坡道的矩形和升高方向。坡道从远端的地面升到高台顶面。 */
export function rampGeometry(
  platform: Rect,
  ramp: { side: Side; length: number; width: number; offset: number },
): { rect: Rect; rise: Rise } {
  const cx = (platform.minX + platform.maxX) / 2 + ramp.offset;
  const cz = (platform.minZ + platform.maxZ) / 2 + ramp.offset;
  const half = ramp.width / 2;
  switch (ramp.side) {
    case '+x':
      return { rect: { minX: platform.maxX, maxX: platform.maxX + ramp.length, minZ: cz - half, maxZ: cz + half }, rise: '-x' };
    case '-x':
      return { rect: { minX: platform.minX - ramp.length, maxX: platform.minX, minZ: cz - half, maxZ: cz + half }, rise: '+x' };
    case '+z':
      return { rect: { minX: cx - half, maxX: cx + half, minZ: platform.maxZ, maxZ: platform.maxZ + ramp.length }, rise: '-z' };
    case '-z':
      return { rect: { minX: cx - half, maxX: cx + half, minZ: platform.minZ - ramp.length, maxZ: platform.minZ }, rise: '+z' };
  }
}

/** 布局里和几何有关的部分（schema 校验前后都能用）。 */
export interface GeometryInput {
  readonly size: { readonly width: number; readonly depth: number };
  readonly boxes: readonly { id: string; center: Point2; size: Point2; height: number }[];
  readonly platforms: readonly { id: string; center: Point2; size: Point2 }[];
  readonly ramps: readonly { id: string; platform: string; side: Side; length: number; width: number; offset: number }[];
}

export function mapBounds(layout: Pick<GeometryInput, 'size'>): Rect {
  return { minX: -layout.size.width / 2, maxX: layout.size.width / 2, minZ: -layout.size.depth / 2, maxZ: layout.size.depth / 2 };
}

/** 把布局里的盒子、高台、坡道转成实体。引用了不存在的高台的坡道会被跳过（schema 校验会报告）。 */
export function layoutSolids(layout: GeometryInput): Solid[] {
  const solids: Solid[] = [];
  for (const box of layout.boxes) {
    solids.push({ kind: 'box', id: box.id, rect: rectFromCenter(box.center, box.size), height: box.height });
  }
  const platformRects = new Map<string, Rect>();
  for (const platform of layout.platforms) {
    const rect = rectFromCenter(platform.center, platform.size);
    platformRects.set(platform.id, rect);
    solids.push({ kind: 'platform', id: platform.id, rect, height: SPEC.terrain.platformHeight });
  }
  for (const ramp of layout.ramps) {
    const platform = platformRects.get(ramp.platform);
    if (!platform) continue;
    const { rect, rise } = rampGeometry(platform, ramp);
    solids.push({ kind: 'ramp', id: ramp.id, rect, height: SPEC.terrain.platformHeight, rise });
  }
  return solids;
}

/** (x, z) 处的地面高度：所有包含这个点的实体顶面中最高的；都不包含时是地面 0。 */
export function groundHeightAt(solids: readonly Solid[], x: number, z: number): number {
  let height = 0;
  for (const solid of solids) {
    if (rectContains(solid.rect, x, z)) height = Math.max(height, surfaceHeight(solid, x, z));
  }
  return height;
}

/** 线段到矩形的最短距离（XZ 平面）。线段穿过矩形时为 0。 */
export function segmentRectDistance(a: Point2, b: Point2, rect: Rect): number {
  if (rectContains(rect, a.x, a.z) || rectContains(rect, b.x, b.z)) return 0;
  const corners: Point2[] = [
    { x: rect.minX, z: rect.minZ },
    { x: rect.maxX, z: rect.minZ },
    { x: rect.maxX, z: rect.maxZ },
    { x: rect.minX, z: rect.maxZ },
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const c = corners[i] ?? { x: 0, z: 0 };
    const d = corners[(i + 1) % 4] ?? { x: 0, z: 0 };
    if (segmentsIntersect(a, b, c, d)) return 0;
    best = Math.min(best, pointSegmentDistance(c, a, b), pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d));
  }
  return best;
}

export function pointSegmentDistance(p: Point2, a: Point2, b: Point2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.z - a.z) * abz) / lengthSq));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 圆（圆心 x,z，半径 r）与矩形的内部是否相交。 */
export function circleOverlapsRect(x: number, z: number, r: number, rect: Rect): boolean {
  const cx = Math.min(rect.maxX, Math.max(rect.minX, x));
  const cz = Math.min(rect.maxZ, Math.max(rect.minZ, z));
  return (x - cx) ** 2 + (z - cz) ** 2 < r * r;
}
