// 关卡的硬检查（P5）：独立于生成器的模块。只用关卡布局本身、P2 的 schema / layoutProblems 和几何函数，
// 不用生成器内部的中间结果（生成器的粗网格、通道、预留区域等）。
//
// 检查项：布局通过 parseLevel（含 layoutProblems）；出生点的胶囊在地图内、不与障碍重叠；收集点数量不少于目标数；
// 每个必需的收集点都能从出生点走到；巡逻路线整段不穿过障碍、只在地面上；出生点离守卫的起点和巡逻路线足够远。
// 给了说明书时，再核对布局和说明书一致（档位、数量、分布、巡逻方式）。
//
// 寻路是保守的（判为能走到的，实际一定能走到；允许把少数实际能走的地方判为走不到）：
// - 网格边长 h（GEN_CONFIG.check.grid）。一个格子能站，要求格子中心离所有“墙”至少 R = 胶囊半径 + 半个格子对角线，
//   并且离地图边界至少 R。相邻（8 邻接）的两个能站的格子之间走直线时，线段上每一点离某个端点不超过半个对角线，
//   所以胶囊始终不碰墙。比胶囊直径窄的缝里没有能站的格子，一定判为走不过去。
// - 地面一层：墙是所有盒子、高台、坡道的矩形（不算迈上矮盒子，也不算从侧面走上坡道）。
// - 每个高台一层：格子中心在这个高台的矩形里，墙是除这个高台以外的所有实体的矩形。高台和地面之间不直接相连（不算跳上跳下）。
// - 坡道：只沿坡道的中线连接地面和高台。地面上的入口点在低端外 R + h，高台上的出口点在高端内 R + h；
//   中线两侧各 R 宽、从入口到出口的通道不能碰到别的实体（这条坡道和它的高台除外：中线在坡道的横向范围内，
//   按 P2 的碰撞规则坡道不挡，高台也不挡）。入口和出口所在的格子都要能站。上坡和下坡都只走这条通道。
// - 收集点：某个能到达的格子中心，按那一层的脚底高度，收集点中心到胶囊轴线的距离不超过收集半径，就算能收集到。

import { SPEC } from '../../spec';
import {
  circleOverlapsRect,
  groundHeightAt,
  layoutSolids,
  mapBounds,
  pointSegmentDistance,
  rectContains,
  rectsOverlap,
  segmentRectDistance,
  type Point2,
  type Rect,
  type Solid,
} from '../geometry';
import { layoutProblems, levelLayoutBaseSchema, type LevelLayout } from '../schema';
import { MAX_COLLECTIBLES_PER_PLATFORM, briefProblems, type Brief } from './brief';
import { GEN_CONFIG } from './config';

/** brief：说明书或参数的问题；layout：检查发现的布局问题。 */
export type ProblemCategory = 'brief' | 'layout';

export interface CheckProblem {
  readonly category: ProblemCategory;
  readonly code: string;
  readonly message: string;
}

export interface CheckOptions {
  readonly brief?: Brief;
  /** 寻路网格的边长（米）。 */
  readonly grid?: number;
  /** 出生点和守卫起点、巡逻路线之间的最小距离（米）。 */
  readonly spawnGuardDistance?: number;
}

/** 网格的格子总数上限：防止参数不当时分配过多内存。 */
const MAX_CELLS = 4_000_000;

interface Layer {
  readonly kind: 'ground' | 'platform';
  readonly platformId: string | null;
  readonly feet: number;
  /** 这一层在全局网格里的列、行范围。 */
  readonly ix0: number;
  readonly iz0: number;
  readonly nx: number;
  readonly nz: number;
  /** 这一层第一个节点的全局序号。 */
  readonly offset: number;
  readonly free: Uint8Array;
}

interface Portal {
  readonly ramp: string;
  readonly ground: number;
  readonly platform: number;
  readonly length: number;
}

/** 检查器自己建立的导航网格（时间推算也用它，而不是生成器的任何结构）。 */
export class Navigation {
  readonly layers: readonly Layer[];
  readonly nodeCount: number;
  readonly portals: readonly Portal[];
  private readonly portalEdges = new Map<number, { to: number; length: number }[]>();

  constructor(
    readonly h: number,
    readonly minX: number,
    readonly minZ: number,
    layers: Layer[],
    portals: Portal[],
  ) {
    this.layers = layers;
    this.nodeCount = layers.reduce((n, l) => n + l.nx * l.nz, 0);
    this.portals = portals;
    for (const p of portals) {
      const add = (from: number, to: number) => {
        const list = this.portalEdges.get(from) ?? [];
        list.push({ to, length: p.length });
        this.portalEdges.set(from, list);
      };
      add(p.ground, p.platform);
      add(p.platform, p.ground);
    }
  }

  private layerOf(node: number): Layer {
    for (const layer of this.layers) {
      if (node >= layer.offset && node < layer.offset + layer.nx * layer.nz) return layer;
    }
    throw new Error(`节点 ${String(node)} 不存在`);
  }

  /** 节点所在格子的中心和那一层的脚底高度。 */
  center(node: number): { x: number; z: number; feet: number } {
    const layer = this.layerOf(node);
    const local = node - layer.offset;
    const ix = layer.ix0 + (local % layer.nx);
    const iz = layer.iz0 + Math.floor(local / layer.nx);
    return { x: this.minX + (ix + 0.5) * this.h, z: this.minZ + (iz + 0.5) * this.h, feet: layer.feet };
  }

  isFree(node: number): boolean {
    const layer = this.layerOf(node);
    return layer.free[node - layer.offset] === 1;
  }

  /** 点所在格子在某一层里的节点；不在这一层的范围里时为 -1。 */
  nodeAt(layerIndex: number, x: number, z: number): number {
    const layer = this.layers[layerIndex];
    if (!layer) return -1;
    const ix = Math.floor((x - this.minX) / this.h) - layer.ix0;
    const iz = Math.floor((z - this.minZ) / this.h) - layer.iz0;
    if (ix < 0 || iz < 0 || ix >= layer.nx || iz >= layer.nz) return -1;
    return layer.offset + iz * layer.nx + ix;
  }

  /** 能站的格子之间的邻接（8 邻接，权重是中心距离；坡道通道是额外的边）。 */
  forEachNeighbor(node: number, visit: (to: number, length: number) => void): void {
    const layer = this.layerOf(node);
    const local = node - layer.offset;
    const x = local % layer.nx;
    const z = Math.floor(local / layer.nx);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= layer.nx || nz >= layer.nz) continue;
        const index = nz * layer.nx + nx;
        if (layer.free[index] !== 1) continue;
        visit(layer.offset + index, dx !== 0 && dz !== 0 ? this.h * Math.SQRT2 : this.h);
      }
    }
    for (const edge of this.portalEdges.get(node) ?? []) visit(edge.to, edge.length);
  }

  /** 多源最短路（Dijkstra，带位置索引的二叉堆，每个节点在堆里最多一份）。返回每个节点的路径长度（米），走不到的是 Infinity。 */
  distances(sources: readonly { node: number; cost: number }[]): Float64Array {
    const dist = new Float64Array(this.nodeCount).fill(Infinity);
    const heap = new Int32Array(this.nodeCount);
    const position = new Int32Array(this.nodeCount).fill(-1);
    const done = new Uint8Array(this.nodeCount);
    let size = 0;
    const key = (i: number) => dist[heap[i] ?? 0] ?? Infinity;
    const place = (i: number, node: number) => {
      heap[i] = node;
      position[node] = i;
    };
    const up = (start: number) => {
      let i = start;
      const node = heap[i] ?? 0;
      const k = dist[node] ?? Infinity;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (key(parent) <= k) break;
        place(i, heap[parent] ?? 0);
        i = parent;
      }
      place(i, node);
    };
    const down = (start: number) => {
      let i = start;
      const node = heap[i] ?? 0;
      const k = dist[node] ?? Infinity;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= size) break;
        const right = left + 1;
        const child = right < size && key(right) < key(left) ? right : left;
        if (key(child) >= k) break;
        place(i, heap[child] ?? 0);
        i = child;
      }
      place(i, node);
    };
    const update = (node: number, value: number) => {
      dist[node] = value;
      const at = position[node] ?? -1;
      if (at < 0) {
        place(size, node);
        size++;
        up(size - 1);
      } else {
        up(at);
      }
    };
    for (const s of sources) {
      if (s.cost < (dist[s.node] ?? Infinity)) update(s.node, s.cost);
    }
    while (size > 0) {
      const node = heap[0] ?? 0;
      size--;
      position[node] = -1;
      done[node] = 1;
      if (size > 0) {
        place(0, heap[size] ?? 0);
        down(0);
      }
      const base = dist[node] ?? Infinity;
      this.forEachNeighbor(node, (to, length) => {
        if (done[to] === 1) return;
        const next = base + length;
        if (next < (dist[to] ?? Infinity)) update(to, next);
      });
    }
    return dist;
  }
}

/** 一个收集点能在哪些格子上收集到（能站的格子中心，按那一层的脚底高度，到胶囊轴线的距离不超过收集半径）。 */
export interface CollectibleReach {
  readonly id: string;
  readonly nodes: readonly number[];
}

export interface CheckReport {
  readonly ok: boolean;
  readonly problems: readonly CheckProblem[];
  /** 通过结构校验和语义校验之后的布局（parseLevel 的结果）；没通过时为 null。 */
  readonly level: LevelLayout | null;
  /** 检查器自己的导航网格（时间推算用）；参数或结构有问题时为 null。 */
  readonly navigation: Navigation | null;
  /** 出生点所在的起点（能站的格子和走到格子中心的距离）。 */
  readonly spawn: readonly { node: number; cost: number }[];
  readonly reach: readonly CollectibleReach[];
}

/** 收集点中心到胶囊轴线（脚底以上 r 到 h − r 的竖直线段）的距离。 */
function axisDistance(feet: number, x: number, z: number, point: { x: number; y: number; z: number }): number {
  const r = SPEC.capsule.radius;
  const bottom = feet + r;
  const top = feet + SPEC.capsule.height - r;
  const vertical = point.y > top ? point.y - top : point.y < bottom ? bottom - point.y : 0;
  return Math.hypot(point.x - x, point.z - z, vertical);
}

function buildNavigation(level: LevelLayout, solids: readonly Solid[], h: number): Navigation {
  const bounds = mapBounds(level);
  const R = SPEC.capsule.radius + (h * Math.SQRT2) / 2;
  const nxAll = Math.floor((bounds.maxX - bounds.minX) / h);
  const nzAll = Math.floor((bounds.maxZ - bounds.minZ) / h);
  const layers: Layer[] = [];
  let offset = 0;

  /** 在一层里标出能站的格子：中心在 inside 里、离边界至少 R、离所有墙至少 R。 */
  const makeLayer = (kind: Layer['kind'], platformId: string | null, feet: number, area: Rect, walls: readonly Rect[]): Layer => {
    const ix0 = Math.max(0, Math.floor((area.minX - bounds.minX) / h));
    const iz0 = Math.max(0, Math.floor((area.minZ - bounds.minZ) / h));
    const ix1 = Math.min(nxAll - 1, Math.ceil((area.maxX - bounds.minX) / h));
    const iz1 = Math.min(nzAll - 1, Math.ceil((area.maxZ - bounds.minZ) / h));
    const nx = Math.max(0, ix1 - ix0 + 1);
    const nz = Math.max(0, iz1 - iz0 + 1);
    const free = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      const cz = bounds.minZ + (iz0 + z + 0.5) * h;
      for (let x = 0; x < nx; x++) {
        const cx = bounds.minX + (ix0 + x + 0.5) * h;
        const insideMap = cx >= bounds.minX + R && cx <= bounds.maxX - R && cz >= bounds.minZ + R && cz <= bounds.maxZ - R;
        const insideArea = cx > area.minX && cx < area.maxX && cz > area.minZ && cz < area.maxZ;
        free[z * nx + x] = insideMap && insideArea ? 1 : 0;
      }
    }
    // 只遍历每面墙膨胀后的范围，耗时和墙的面积成正比
    for (const wall of walls) {
      const wx0 = Math.max(0, Math.floor((wall.minX - R - bounds.minX) / h) - ix0);
      const wz0 = Math.max(0, Math.floor((wall.minZ - R - bounds.minZ) / h) - iz0);
      const wx1 = Math.min(nx - 1, Math.ceil((wall.maxX + R - bounds.minX) / h) - ix0);
      const wz1 = Math.min(nz - 1, Math.ceil((wall.maxZ + R - bounds.minZ) / h) - iz0);
      for (let z = wz0; z <= wz1; z++) {
        const cz = bounds.minZ + (iz0 + z + 0.5) * h;
        for (let x = wx0; x <= wx1; x++) {
          const index = z * nx + x;
          if (free[index] !== 1) continue;
          const cx = bounds.minX + (ix0 + x + 0.5) * h;
          if (circleOverlapsRect(cx, cz, R, wall)) free[index] = 0;
        }
      }
    }
    const layer: Layer = { kind, platformId, feet, ix0, iz0, nx, nz, offset, free };
    offset += nx * nz;
    return layer;
  };

  layers.push(makeLayer('ground', null, 0, bounds, solids.map((s) => s.rect)));
  for (const platform of solids.filter((s) => s.kind === 'platform')) {
    layers.push(makeLayer('platform', platform.id, platform.height, platform.rect, solids.filter((s) => s !== platform).map((s) => s.rect)));
  }

  const portals: Portal[] = [];
  const navigation = new Navigation(h, bounds.minX, bounds.minZ, layers, []);
  for (const ramp of solids.filter((s) => s.kind === 'ramp')) {
    const platformIndex = layers.findIndex((l) => l.platformId === ramp.platform);
    const platform = solids.find((s) => s.kind === 'platform' && s.id === ramp.platform);
    if (platformIndex < 0 || !platform || ramp.rise === undefined) continue;
    const r = ramp.rect;
    const along = ramp.rise === '+x' || ramp.rise === '-x';
    const sign = ramp.rise === '+x' || ramp.rise === '+z' ? 1 : -1;
    const lateral = along ? (r.minZ + r.maxZ) / 2 : (r.minX + r.maxX) / 2;
    const low = along ? (sign > 0 ? r.minX : r.maxX) : sign > 0 ? r.minZ : r.maxZ;
    const high = along ? (sign > 0 ? r.maxX : r.minX) : sign > 0 ? r.maxZ : r.minZ;
    const reach = R + h;
    const entry = low - sign * reach;
    const exit = high + sign * reach;
    const E: Point2 = along ? { x: entry, z: lateral } : { x: lateral, z: entry };
    const P: Point2 = along ? { x: exit, z: lateral } : { x: lateral, z: exit };
    if (!rectContains(platform.rect, P.x, P.z)) continue;
    // 通道：入口到出口的线段，两侧各 R
    const corridor: Rect = {
      minX: Math.min(E.x, P.x) - R,
      maxX: Math.max(E.x, P.x) + R,
      minZ: Math.min(E.z, P.z) - R,
      maxZ: Math.max(E.z, P.z) + R,
    };
    const blocked = solids.some((s) => s !== ramp && s !== platform && rectsOverlap(s.rect, corridor));
    const insideMap = corridor.minX >= bounds.minX && corridor.maxX <= bounds.maxX && corridor.minZ >= bounds.minZ && corridor.maxZ <= bounds.maxZ;
    if (blocked || !insideMap) continue;
    const groundNode = navigation.nodeAt(0, E.x, E.z);
    const platformNode = navigation.nodeAt(platformIndex, P.x, P.z);
    if (groundNode < 0 || platformNode < 0 || !navigation.isFree(groundNode) || !navigation.isFree(platformNode)) continue;
    const g = navigation.center(groundNode);
    const p = navigation.center(platformNode);
    portals.push({
      ramp: ramp.id,
      ground: groundNode,
      platform: platformNode,
      length: Math.hypot(g.x - E.x, g.z - E.z) + Math.hypot(P.x - E.x, P.z - E.z) + Math.hypot(p.x - P.x, p.z - P.z),
    });
  }
  return new Navigation(h, bounds.minX, bounds.minZ, layers, portals);
}

/** 从出生点开始的起点：离出生点不超过半个格子对角线的、能站的地面格子。 */
function spawnSources(nav: Navigation, spawn: Point2): { node: number; cost: number }[] {
  const sources: { node: number; cost: number }[] = [];
  const delta = (nav.h * Math.SQRT2) / 2;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const node = nav.nodeAt(0, spawn.x + dx * nav.h, spawn.z + dz * nav.h);
      if (node < 0 || !nav.isFree(node)) continue;
      const c = nav.center(node);
      const d = Math.hypot(c.x - spawn.x, c.z - spawn.z);
      if (d <= delta + 1e-9 && !sources.some((s) => s.node === node)) sources.push({ node, cost: d });
    }
  }
  return sources;
}

/** 每个收集点能在哪些能站的格子上收集到。 */
function collectibleReach(nav: Navigation, level: LevelLayout, solids: readonly Solid[]): CollectibleReach[] {
  const radius = SPEC.collect.radius;
  return level.collectibles.map((c) => {
    const point = { x: c.position.x, y: groundHeightAt(solids, c.position.x, c.position.z) + SPEC.collect.hoverHeight, z: c.position.z };
    const nodes: number[] = [];
    nav.layers.forEach((layer, layerIndex) => {
      const steps = Math.ceil(radius / nav.h) + 1;
      for (let dz = -steps; dz <= steps; dz++) {
        for (let dx = -steps; dx <= steps; dx++) {
          const node = nav.nodeAt(layerIndex, point.x + dx * nav.h, point.z + dz * nav.h);
          if (node < 0 || !nav.isFree(node) || nodes.includes(node)) continue;
          const center = nav.center(node);
          if (axisDistance(layer.feet, center.x, center.z, point) <= radius - 1e-6) nodes.push(node);
        }
      }
    });
    return { id: c.id, nodes };
  });
}

function isBackAndForth(route: readonly Point2[]): boolean {
  const n = route.length;
  for (let k = 1; k < n; k++) {
    const a = route[k];
    const b = route[n - k];
    if (!a || !b || Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.z - b.z) > 1e-9) return false;
  }
  return true;
}

/** 布局和说明书是否一致（档位、数量、分布、巡逻方式）。不一致是布局问题。 */
function briefMismatches(level: LevelLayout, solids: readonly Solid[], brief: Brief): string[] {
  const out: string[] = [];
  const tier = GEN_CONFIG.tiers[brief.tier];
  if (level.size.width !== tier.size || level.size.depth !== tier.size) {
    out.push(`地图尺寸 ${String(level.size.width)} × ${String(level.size.depth)} m 与说明书的档位 ${brief.tier}（${String(tier.size)} m）不符`);
  }
  if (level.platforms.length !== brief.platforms) out.push(`高台有 ${String(level.platforms.length)} 个，说明书要 ${String(brief.platforms)} 个`);
  if (level.collectibles.length !== brief.collectibles) out.push(`收集点有 ${String(level.collectibles.length)} 个，说明书要 ${String(brief.collectibles)} 个`);
  if (level.guards.length !== brief.guards) out.push(`守卫有 ${String(level.guards.length)} 个，说明书要 ${String(brief.guards)} 个`);
  if (brief.distribution === 'elevated') {
    const platforms = solids.filter((s) => s.kind === 'platform');
    const counts = new Map<string, number>();
    for (const c of level.collectibles) {
      const on = platforms.find((p) => rectContains(p.rect, c.position.x, c.position.z));
      if (!on) out.push(`收集点 ${c.id} 不在高台上（说明书要求只放在高台上）`);
      else counts.set(on.id, (counts.get(on.id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      if (n > MAX_COLLECTIBLES_PER_PLATFORM) out.push(`高台 ${id} 上有 ${String(n)} 个收集点，每个高台最多 ${String(MAX_COLLECTIBLES_PER_PLATFORM)} 个`);
    }
  }
  if (brief.patrol === 'back-and-forth') {
    for (const g of level.guards) {
      if (!isBackAndForth(g.route)) out.push(`守卫 ${g.id} 的路线不是来回各走一遍（A→…→Z→…→A）`);
    }
  }
  return out;
}

/** 检查一份布局。返回所有问题；ok 为 true 时没有问题。 */
export function checkLevel(input: unknown, options: CheckOptions = {}): CheckReport {
  const problems: CheckProblem[] = [];
  const fail = (category: ProblemCategory, code: string, message: string) => problems.push({ category, code, message });
  const empty = (): CheckReport => ({ ok: false, problems, level: null, navigation: null, spawn: [], reach: [] });

  // 说明书或参数的问题
  const h = options.grid ?? GEN_CONFIG.check.grid;
  const minDistance = options.spawnGuardDistance ?? GEN_CONFIG.check.spawnGuardDistance;
  if (!Number.isFinite(h) || h <= 0) fail('brief', 'parameter', `网格边长 ${String(h)} 不对：必须是正数`);
  if (!Number.isFinite(minDistance) || minDistance < 0) fail('brief', 'parameter', `出生点和守卫的最小距离 ${String(minDistance)} 不对：必须是非负数`);
  if (options.brief) for (const p of briefProblems(options.brief)) fail('brief', 'brief', `说明书 ${p.path}：${p.message}`);
  if (problems.length > 0) return empty();

  // 结构和语义（parseLevel 的两部分）
  const base = levelLayoutBaseSchema.safeParse(input);
  if (!base.success) {
    for (const issue of base.error.issues) fail('layout', 'layout-schema', `${issue.path.map(String).join('.') || '（根）'}：${issue.message}`);
    return empty();
  }
  const level: LevelLayout = base.data;
  for (const p of layoutProblems(base.data)) fail('layout', 'layout-rules', `${p.path.map(String).join('.') || '（根）'}：${p.message}`);

  const solids = layoutSolids(level);
  const bounds = mapBounds(level);
  const r = SPEC.capsule.radius;
  const cells = Math.ceil((bounds.maxX - bounds.minX) / h) * Math.ceil((bounds.maxZ - bounds.minZ) / h) * (1 + level.platforms.length);
  if (cells > MAX_CELLS) {
    fail('brief', 'parameter', `网格边长 ${String(h)} m 对这张 ${String(level.size.width)} × ${String(level.size.depth)} m 的地图太细（${String(cells)} 个格子）：加大网格边长`);
    return { ...empty(), level: null };
  }

  // 出生空间：胶囊在地图内、不与障碍重叠
  const spawn = level.spawn;
  if (spawn.x < bounds.minX + r || spawn.x > bounds.maxX - r || spawn.z < bounds.minZ + r || spawn.z > bounds.maxZ - r) {
    fail('layout', 'spawn', '出生点的胶囊超出地图边界');
  }
  for (const s of solids) {
    if (circleOverlapsRect(spawn.x, spawn.z, r, s.rect)) fail('layout', 'spawn', `出生点的胶囊与 ${s.id} 重叠`);
  }

  // 收集点数量
  if (level.collectibles.length < level.target) {
    fail('layout', 'collectible-count', `收集点只有 ${String(level.collectibles.length)} 个，少于目标数 ${String(level.target)}`);
  }

  // 巡逻路线：整段不穿过障碍（按守卫的胶囊半径），只在地面上；离出生点足够远
  for (const g of level.guards) {
    const n = g.route.length;
    for (let k = 0; k < n; k++) {
      const a = g.route[k];
      const b = g.route[(k + 1) % n];
      if (!a || !b) continue;
      for (const s of solids) {
        const d = segmentRectDistance(a, b, s.rect);
        if (d < r) {
          fail(
            'layout',
            'patrol',
            d === 0 ? `守卫 ${g.id} 的第 ${String(k)} 段路线穿过 ${s.id}（不在地面上）` : `守卫 ${g.id} 的第 ${String(k)} 段路线离 ${s.id} 只有 ${d.toFixed(2)} m，守卫的胶囊会碰到它`,
          );
        }
      }
      if (pointSegmentDistance(spawn, a, b) < minDistance) {
        fail('layout', 'spawn-guard-distance', `出生点离守卫 ${g.id} 的第 ${String(k)} 段路线不到 ${String(minDistance)} m`);
      }
    }
    for (const p of g.route) {
      if (p.x < bounds.minX + r || p.x > bounds.maxX - r || p.z < bounds.minZ + r || p.z > bounds.maxZ - r) {
        fail('layout', 'patrol', `守卫 ${g.id} 的路线点 (${String(p.x)}, ${String(p.z)}) 离地图边界不足一个胶囊半径`);
      }
    }
  }

  if (options.brief) for (const m of briefMismatches(level, solids, options.brief)) fail('layout', 'brief-mismatch', `布局与说明书不符：${m}`);

  // 寻路：每个必需的收集点都能从出生点走到
  const navigation = buildNavigation(level, solids, h);
  const sources = spawnSources(navigation, spawn);
  const reach = collectibleReach(navigation, level, solids);
  if (sources.length === 0) {
    fail('layout', 'spawn', '出生点附近没有足够的空间（保守的寻路网格上没有能站的格子）');
  } else {
    const dist = navigation.distances(sources);
    const reachable = reach.filter((c) => c.nodes.some((n) => Number.isFinite(dist[n] ?? Infinity)));
    if (reachable.length < level.target) {
      const missing = reach.filter((c) => !reachable.includes(c)).map((c) => c.id);
      fail('layout', 'unreachable', `从出生点走不到的收集点：${missing.join('、')}（能走到 ${String(reachable.length)} 个，目标 ${String(level.target)} 个）`);
    }
  }

  return { ok: problems.length === 0, problems, level: problems.length === 0 ? level : null, navigation, spawn: sources, reach };
}
