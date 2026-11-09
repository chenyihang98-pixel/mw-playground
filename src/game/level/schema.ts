// 关卡布局（zod）。游戏只通过这里加载关卡：结构校验 + 依赖玩法规格的语义校验。
// 语义校验也导出成独立函数，以后的地图生成器和检查器可以直接复用。

import { z } from 'zod';
import { SPEC } from '../spec';
import {
  circleOverlapsRect,
  expandRect,
  layoutSolids,
  mapBounds,
  rampGeometry,
  rectContains,
  rectFromCenter,
  rectInside,
  rectsOverlap,
  segmentRectDistance,
  type GeometryInput,
} from './geometry';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能用小写字母、数字和连字符');
const coord = z.number(); // zod 4 的 number 不接受 NaN / Infinity
const positive = z.number().positive();
const point = z.strictObject({ x: coord, z: coord });
const size2 = z.strictObject({ x: positive, z: positive });
const side = z.enum(['+x', '-x', '+z', '-z']);

const baseSchema = z.strictObject({
  id,
  name: z.string().min(1),
  /** 地图尺寸（米）：以原点为中心，x 方向宽 width，z 方向深 depth。 */
  size: z.strictObject({ width: positive, depth: positive }),
  /** 出生点（脚底）和朝向（弧度；0 表示面向 +Z）。 */
  spawn: z.strictObject({ x: coord, z: coord, yaw: coord }),
  /** 盒子障碍：底面在地面上，footprint 是轴对齐矩形。 */
  boxes: z.array(z.strictObject({ id, center: point, size: size2, height: positive })),
  /** 高台：高度统一取 SPEC.terrain.platformHeight。 */
  platforms: z.array(z.strictObject({ id, center: point, size: size2 })),
  /** 坡道：贴在某个高台的一侧，从地面升到高台顶面。offset 是沿这一侧相对中点的偏移。 */
  ramps: z.array(
    z.strictObject({ id, platform: id, side, length: positive, width: positive, offset: coord.default(0) }),
  ),
  /** 收集点：只给 XZ，高度按所在表面加 SPEC.collect.hoverHeight。 */
  collectibles: z.array(z.strictObject({ id, position: point })),
  /** 守卫：沿 route 的点循环巡逻（最后一个点回到第一个点）。 */
  guards: z.array(z.strictObject({ id, route: z.array(point).min(2) })),
  /** 时间限制（秒）。 */
  timeLimit: positive,
  /** 收集目标数。 */
  target: z.number().int().positive(),
});

export type LevelLayoutInput = z.input<typeof baseSchema>;
type ParsedLayout = z.output<typeof baseSchema>;

/** 只有结构校验（不含依赖规格的语义校验）。P5 的检查器先用它解析，再自己逐项报告问题。 */
export const levelLayoutBaseSchema = baseSchema;

export interface LayoutProblem {
  readonly path: (string | number)[];
  readonly message: string;
}

const EPS = 1e-9;

/** 依赖玩法规格的语义校验。返回所有问题；空数组表示布局可用。 */
export function layoutProblems(layout: ParsedLayout): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const add = (path: (string | number)[], message: string) => problems.push({ path, message });
  const r = SPEC.capsule.radius;
  const bounds = mapBounds(layout);
  const geometry: GeometryInput = layout;
  const solids = layoutSolids(geometry);

  // id 全局唯一
  const seen = new Map<string, string>();
  const groups = [
    ['boxes', layout.boxes],
    ['platforms', layout.platforms],
    ['ramps', layout.ramps],
    ['collectibles', layout.collectibles],
    ['guards', layout.guards],
  ] as const;
  for (const [group, items] of groups) {
    items.forEach((item, i) => {
      const previous = seen.get(item.id);
      if (previous) add([group, i, 'id'], `id "${item.id}" 与 ${previous} 重复`);
      else seen.set(item.id, `${group}[${i}]`);
    });
  }

  if (layout.target > layout.collectibles.length) {
    add(['target'], `收集目标数 ${layout.target} 大于收集点数量 ${layout.collectibles.length}`);
  }

  // 实体都在地图里，互不重叠（坡道和它所属的高台只是贴边）
  for (const solid of solids) {
    if (!rectInside(solid.rect, bounds)) add([`${solid.kind}:${solid.id}`], `${solid.id} 超出地图边界`);
  }
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i];
      const b = solids[j];
      if (a && b && rectsOverlap(a.rect, b.rect)) add([`${a.kind}:${a.id}`], `${a.id} 与 ${b.id} 重叠`);
    }
  }

  // 坡道：所属高台存在；不比最大坡度陡；宽度能让胶囊通过；不超出高台这一侧
  const platforms = new Map(layout.platforms.map((p) => [p.id, rectFromCenter(p.center, p.size)]));
  layout.ramps.forEach((ramp, i) => {
    const platform = platforms.get(ramp.platform);
    if (!platform) {
      add(['ramps', i, 'platform'], `坡道 ${ramp.id} 引用的高台 ${ramp.platform} 不存在`);
      return;
    }
    const gradient = SPEC.terrain.platformHeight / ramp.length;
    if (gradient > SPEC.terrain.rampMaxGradient + EPS) {
      add(
        ['ramps', i, 'length'],
        `坡道 ${ramp.id} 太陡：长度 ${ramp.length} m 时坡度 ${((Math.atan(gradient) * 180) / Math.PI).toFixed(1)}°，最大 ${SPEC.terrain.rampMaxSlopeDeg}°（长度至少 ${SPEC.terrain.rampMinLength.toFixed(3)} m）`,
      );
    }
    if (ramp.width <= 2 * r) add(['ramps', i, 'width'], `坡道 ${ramp.id} 宽 ${ramp.width} m，不大于胶囊直径 ${2 * r} m`);
    const sideLength = ramp.side === '+x' || ramp.side === '-x' ? platform.maxZ - platform.minZ : platform.maxX - platform.minX;
    if (Math.abs(ramp.offset) + ramp.width / 2 > sideLength / 2 + EPS) {
      add(['ramps', i], `坡道 ${ramp.id} 超出了高台 ${ramp.platform} 这一侧的范围`);
    }
    // rampGeometry 只是为了确认能算出几何；实体列表里已经包含它
    rampGeometry(platform, ramp);
  });

  // 出生点：胶囊整个在地图内，不和任何实体重叠
  const spawnArea = expandRect(bounds, -r);
  if (!rectContains(spawnArea, layout.spawn.x, layout.spawn.z)) add(['spawn'], '出生点离地图边界不足一个胶囊半径');
  for (const solid of solids) {
    if (circleOverlapsRect(layout.spawn.x, layout.spawn.z, r, solid.rect)) add(['spawn'], `出生点与 ${solid.id} 重叠`);
  }

  // 收集点：在地图内，不在盒子里面
  layout.collectibles.forEach((c, i) => {
    if (!rectContains(spawnArea, c.position.x, c.position.z)) add(['collectibles', i], `收集点 ${c.id} 离地图边界不足一个胶囊半径`);
    for (const solid of solids) {
      if (solid.kind === 'box' && rectContains(solid.rect, c.position.x, c.position.z)) {
        add(['collectibles', i], `收集点 ${c.id} 在盒子 ${solid.id} 里面`);
      }
    }
  });

  // 守卫：路线的点在地图内；每段路线（含回到起点的一段）与所有实体保持一个胶囊半径以上
  layout.guards.forEach((guard, g) => {
    guard.route.forEach((p, k) => {
      if (!rectContains(spawnArea, p.x, p.z)) add(['guards', g, 'route', k], `守卫 ${guard.id} 的路线点离地图边界不足一个胶囊半径`);
    });
    const n = guard.route.length;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const a = guard.route[k];
      const b = guard.route[(k + 1) % n];
      if (!a || !b) continue;
      total += Math.hypot(b.x - a.x, b.z - a.z);
      for (const solid of solids) {
        if (segmentRectDistance(a, b, solid.rect) < r) {
          add(['guards', g, 'route', k], `守卫 ${guard.id} 的第 ${k} 段路线离 ${solid.id} 不足一个胶囊半径`);
        }
      }
    }
    if (total <= EPS) add(['guards', g, 'route'], `守卫 ${guard.id} 的路线长度为 0`);
  });

  return problems;
}

export const levelLayoutSchema = baseSchema.superRefine((layout, ctx) => {
  for (const problem of layoutProblems(layout)) {
    ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message });
  }
});

export type LevelLayout = z.output<typeof levelLayoutSchema>;

export class LevelError extends Error {}

/** 解析并校验关卡布局。不合法时抛出 LevelError，消息里列出前几条问题。 */
export function parseLevel(input: unknown): LevelLayout {
  const result = levelLayoutSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 6).map((issue) => `${issue.path.map(String).join('.') || '（根）'}：${issue.message}`);
  throw new LevelError(`关卡布局不合法：${issues.join('；')}`);
}
