// 胶囊与盒子、高台、坡道的水平碰撞（XZ 平面上的圆与矩形），以及地图边界。纯模块。
//
// 规则：脚底高度为 y 时，实体里顶面高于 y + allowance 的部分是“墙”（站在地面上 allowance = 迈步高度，
// 在空中为 0）。胶囊在 XZ 平面上是半径 SPEC.capsule.radius 的圆，不能与墙重叠；被推出时只去掉
// 法向分量，所以能沿墙滑动。
//
// 坡道例外：坡道的顶面是斜坡、低端高度为 0、高端贴着高台，只有两个侧面是墙。所以圆心在坡道的横向范围内
// （在坡道上方，或正对着坡道的低端 / 高端）时，坡道不挡；圆心从坡道上越过高端时，所贴的高台也不挡。
// 判断用每一小段移动开始时的圆心：从侧面靠近时，圆心进入横向范围之前就已经被侧面挡住。

import { circleOverlapsRect, inRampLateralSpan, rectContains, regionAbove, type Rect, type Solid } from '../level/geometry';
import { SPEC } from '../spec';
import type { World } from './world';

const PUSH_EPSILON = 1e-7;
const RESOLVE_ITERATIONS = 6;

/** 圆心在 (x, z) 时，这个实体能不能挡住胶囊（与高度无关的部分）。 */
function canBlock(world: World, solid: Solid, x: number, z: number): boolean {
  if (solid.kind === 'ramp') return !inRampLateralSpan(solid, x, z);
  if (solid.kind === 'platform') {
    // 从贴着它的坡道上走（或跳）过去时，高台在坡道高端那一侧不是墙
    return !world.solids.some((s) => s.kind === 'ramp' && s.platform === solid.id && rectContains(s.rect, x, z));
  }
  return true;
}

/** 脚底高度 feetY、迈步余量 allowance、圆心在 (fromX, fromZ) 时会挡住胶囊的区域。 */
export function blockingRects(world: World, feetY: number, allowance: number, fromX: number, fromZ: number): Rect[] {
  const level = feetY + allowance;
  const rects: Rect[] = [];
  for (const solid of world.solids) {
    if (!canBlock(world, solid, fromX, fromZ)) continue;
    const region = regionAbove(solid, level);
    if (region) rects.push(region);
  }
  return rects;
}

/** 把圆推出矩形；不重叠时返回 null。 */
function pushOut(x: number, z: number, r: number, rect: Rect): { x: number; z: number } | null {
  const cx = Math.min(rect.maxX, Math.max(rect.minX, x));
  const cz = Math.min(rect.maxZ, Math.max(rect.minZ, z));
  const dx = x - cx;
  const dz = z - cz;
  const distSq = dx * dx + dz * dz;
  if (distSq >= r * r) return null;
  if (distSq > 0) {
    const dist = Math.sqrt(distSq);
    const push = r - dist + PUSH_EPSILON;
    return { x: x + (dx / dist) * push, z: z + (dz / dist) * push };
  }
  // 圆心在矩形里面：从最近的一条边推出去
  const toMinX = x - rect.minX;
  const toMaxX = rect.maxX - x;
  const toMinZ = z - rect.minZ;
  const toMaxZ = rect.maxZ - z;
  const nearest = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
  if (nearest === toMinX) return { x: rect.minX - r - PUSH_EPSILON, z };
  if (nearest === toMaxX) return { x: rect.maxX + r + PUSH_EPSILON, z };
  if (nearest === toMinZ) return { x, z: rect.minZ - r - PUSH_EPSILON };
  return { x, z: rect.maxZ + r + PUSH_EPSILON };
}

/** 把圆心限制在地图边界内（离边界至少一个半径）。 */
export function clampToBounds(world: World, x: number, z: number, r: number): { x: number; z: number } {
  const b = world.bounds;
  return {
    x: Math.min(b.maxX - r, Math.max(b.minX + r, x)),
    z: Math.min(b.maxZ - r, Math.max(b.minZ + r, z)),
  };
}

function penetrates(x: number, z: number, r: number, rects: readonly Rect[]): boolean {
  // 推出后正好相切的情况不算重叠，留一点余量。
  return rects.some((rect) => circleOverlapsRect(x, z, r - 1e-6, rect));
}

/** 解除圆与墙的重叠（迭代几次以处理墙角），并限制在地图内。 */
function resolve(x: number, z: number, r: number, rects: readonly Rect[], world: World): { x: number; z: number } {
  let p = clampToBounds(world, x, z, r);
  for (let i = 0; i < RESOLVE_ITERATIONS; i++) {
    let moved = false;
    for (const rect of rects) {
      const pushed = pushOut(p.x, p.z, r, rect);
      if (pushed) {
        p = clampToBounds(world, pushed.x, pushed.z, r);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return p;
}

/**
 * 把胶囊从 (x, z) 沿 (dx, dz) 移动，处理碰撞和边界。
 * 位移按不超过半个半径分段，避免一步穿过薄墙；某一段解不开重叠（例如挤进比直径还窄的缝）时停在上一段的位置。
 */
export function moveCapsule(
  world: World,
  x: number,
  z: number,
  dx: number,
  dz: number,
  feetY: number,
  allowance: number,
): { x: number; z: number } {
  const r = SPEC.capsule.radius;
  const distance = Math.hypot(dx, dz);
  const segments = Math.max(1, Math.ceil(distance / (r * 0.5)));
  let px = x;
  let pz = z;
  for (let i = 0; i < segments; i++) {
    const rects = blockingRects(world, feetY, allowance, px, pz);
    const next = resolve(px + dx / segments, pz + dz / segments, r, rects, world);
    if (penetrates(next.x, next.z, r, rects)) break;
    px = next.x;
    pz = next.z;
  }
  return { x: px, z: pz };
}
