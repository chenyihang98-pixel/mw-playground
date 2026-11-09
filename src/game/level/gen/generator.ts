// 关卡生成器（P5）：种子 + 说明书 → 一份 P2 结构的布局（能通过 parseLevel）。纯模块，随机数只来自种子。
//
// 在粗网格（边长 GEN_CONFIG.generator.cell）上按顺序做：
// 1. 连通的可行走区域：地图最外一圈格子是通道；守卫的巡逻通道（loop：矩形一圈；back-and-forth：L 形）、
//    收集点和出生点的空地（3 × 3 格）、再加几条通往随机锚点的通道。每一块新挖的通道都用 L 形通道连到已有的通道上，
//    所以整个可行走区域是连通的。
// 2. 障碍和高台：高台占 2 × 2 格，坡道占高台一侧的 2 格，坡道低端外面的那一格必须是通道（所以经坡道能走上高台）；
//    盒子只放在没有被占用的格子里。高台、坡道、盒子都不占通道和空地，所以第 1 步的连通性不受影响。
//    盒子、高台离所在格子的边界至少 margin，通道因此足够宽。
// 3. 收集点、出生点和巡逻路线：收集点放在空地中央（clustered 放在同一块空地的各格；elevated 放在高台顶面），
//    出生点放在出生点空地的中央，巡逻路线沿第 1 步挖好的巡逻通道的格子中心（只在地面上，不上高台、不走坡道）。
// 放不下（找不到高台的位置、空地不够放障碍、出生点离巡逻路线不够远……）时返回原因，由调用方用下一个子种子重试。

import { SPEC } from '../../spec';
import { pointSegmentDistance, type Point2 } from '../geometry';
import type { LevelLayoutInput } from '../schema';
import { MAX_COLLECTIBLES_PER_PLATFORM, type Brief } from './brief';
import { GEN_CONFIG } from './config';
import { Rng, hash64 } from './random';

export type GenerateResult = { readonly ok: true; readonly layout: LevelLayoutInput } | { readonly ok: false; readonly reason: string };

type GenConfig = typeof GEN_CONFIG;

const FREE = 0;
const CORRIDOR = 1;
const PLATFORM = 2;
const RAMP = 3;
const BOX = 4;

interface Cell {
  readonly i: number;
  readonly j: number;
}

type Side = '+x' | '-x' | '+z' | '-z';

interface PlatformPlan {
  readonly i0: number;
  readonly j0: number;
  readonly side: Side;
  /** 坡道在高台这一侧的哪一列（0 或 1）。 */
  readonly column: 0 | 1;
}

/** 生成失败（放不下）：带原因，调用方换子种子重试。 */
class CannotFit extends Error {}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

class Plan {
  readonly n: number;
  readonly kind: Uint8Array;

  constructor(
    readonly size: number,
    readonly cell: number,
  ) {
    this.n = Math.round(size / cell);
    this.kind = new Uint8Array(this.n * this.n);
  }

  inside(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.n && j < this.n;
  }

  interior(i: number, j: number): boolean {
    return i >= 1 && j >= 1 && i <= this.n - 2 && j <= this.n - 2;
  }

  get(i: number, j: number): number {
    return this.inside(i, j) ? (this.kind[j * this.n + i] ?? FREE) : -1;
  }

  set(i: number, j: number, k: number): void {
    if (this.inside(i, j)) this.kind[j * this.n + i] = k;
  }

  center(i: number, j: number): Point2 {
    return { x: -this.size / 2 + (i + 0.5) * this.cell, z: -this.size / 2 + (j + 0.5) * this.cell };
  }

  /** 把格子挖成通道（只改还没被占用的格子）。 */
  carve(i: number, j: number): void {
    if (this.get(i, j) === FREE) this.set(i, j, CORRIDOR);
  }

  /** 从 a 到 b 挖一条 L 形通道（先横后竖或先竖后横）。 */
  carveL(rng: Rng, a: Cell, b: Cell): void {
    const horizontalFirst = rng.chance(0.5);
    const corner = horizontalFirst ? { i: b.i, j: a.j } : { i: a.i, j: b.j };
    for (const [from, to] of [
      [a, corner],
      [corner, b],
    ] as const) {
      const di = Math.sign(to.i - from.i);
      const dj = Math.sign(to.j - from.j);
      let i = from.i;
      let j = from.j;
      this.carve(i, j);
      while (i !== to.i || j !== to.j) {
        i += di;
        j += dj;
        this.carve(i, j);
      }
    }
  }

  /** 把一组新挖的格子连到已有的通道上：从其中一格挖 L 形通道到最近的、不在这组里的通道格子。 */
  connect(rng: Rng, cells: readonly Cell[]): void {
    const own = new Set(cells.map((c) => c.j * this.n + c.i));
    let best: { from: Cell; to: Cell; d: number } | null = null;
    for (const from of cells) {
      for (let j = 0; j < this.n; j++) {
        for (let i = 0; i < this.n; i++) {
          if (this.get(i, j) !== CORRIDOR || own.has(j * this.n + i)) continue;
          const d = Math.abs(i - from.i) + Math.abs(j - from.j);
          if (!best || d < best.d) best = { from, to: { i, j }, d };
        }
      }
    }
    if (best) this.carveL(rng, best.from, best.to);
  }

  /** 挖一块空地（以 c 为中心的 3 × 3 格），并连到已有的通道上。 */
  plaza(rng: Rng, c: Cell): Cell[] {
    const cells: Cell[] = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!this.inside(c.i + di, c.j + dj)) continue;
        this.carve(c.i + di, c.j + dj);
        cells.push({ i: c.i + di, j: c.j + dj });
      }
    }
    this.connect(rng, cells);
    return cells;
  }

  cellsOf(kind: number, predicate: (c: Cell) => boolean = () => true): Cell[] {
    const out: Cell[] = [];
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        if (this.get(i, j) === kind && predicate({ i, j })) out.push({ i, j });
      }
    }
    return out;
  }
}

function allCells(n: number): Cell[] {
  return Array.from({ length: n * n }, (_, k) => ({ i: k % n, j: Math.floor(k / n) }));
}

/** 从候选格子里挑 count 个尽量分散的（先要求两两距离不小于 spacing，挑不够就逐步放宽）。 */
function spread(rng: Rng, candidates: readonly Cell[], count: number, spacing: number): Cell[] {
  const shuffled = rng.shuffle(candidates);
  let minimum = spacing;
  for (let round = 0; round < 12; round++) {
    const chosen: Cell[] = [];
    for (const c of shuffled) {
      if (chosen.every((o) => Math.hypot(o.i - c.i, o.j - c.j) >= minimum)) chosen.push(c);
      if (chosen.length === count) return chosen;
    }
    minimum *= 0.75;
  }
  return shuffled.slice(0, count);
}

interface PatrolPlan {
  readonly cells: readonly Cell[];
  readonly route: readonly Cell[];
}

/** 第 1 步：巡逻通道。loop 是一个矩形的一圈；back-and-forth 是一段 L 形，路线点排成 A→K→Z→K（回到 A）。 */
function patrolCorridor(rng: Rng, plan: Plan, brief: Brief): PatrolPlan {
  const n = plan.n;
  for (let tries = 0; tries < 20; tries++) {
    if (brief.patrol === 'loop') {
      const w = rng.int(3, Math.min(5, n - 4));
      const h = rng.int(3, Math.min(5, n - 4));
      const i0 = rng.int(1, n - 1 - w);
      const j0 = rng.int(1, n - 1 - h);
      const cells: Cell[] = [];
      for (let i = i0; i < i0 + w; i++) {
        cells.push({ i, j: j0 }, { i, j: j0 + h - 1 });
      }
      for (let j = j0 + 1; j < j0 + h - 1; j++) {
        cells.push({ i: i0, j }, { i: i0 + w - 1, j });
      }
      return {
        cells,
        route: [
          { i: i0, j: j0 },
          { i: i0 + w - 1, j: j0 },
          { i: i0 + w - 1, j: j0 + h - 1 },
          { i: i0, j: j0 + h - 1 },
        ],
      };
    }
    const a: Cell = { i: rng.int(1, n - 2), j: rng.int(1, n - 2) };
    const k: Cell = { i: a.i + rng.pick([-1, 1]) * rng.int(2, 5), j: a.j };
    const z: Cell = { i: k.i, j: k.j + rng.pick([-1, 1]) * rng.int(2, 5) };
    if (!plan.interior(k.i, k.j) || !plan.interior(z.i, z.j)) continue;
    const cells: Cell[] = [];
    for (let i = Math.min(a.i, k.i); i <= Math.max(a.i, k.i); i++) cells.push({ i, j: a.j });
    for (let j = Math.min(k.j, z.j); j <= Math.max(k.j, z.j); j++) cells.push({ i: k.i, j });
    return { cells, route: [a, k, z, k] };
  }
  throw new CannotFit('放不下守卫的巡逻路线');
}

/** 高台占的 2 × 2 格、坡道占的 2 格，以及坡道低端外面那一格（入口）。 */
function platformCells(p: PlatformPlan): { block: Cell[]; ramp: Cell[]; entrance: Cell } {
  const block = [
    { i: p.i0, j: p.j0 },
    { i: p.i0 + 1, j: p.j0 },
    { i: p.i0, j: p.j0 + 1 },
    { i: p.i0 + 1, j: p.j0 + 1 },
  ];
  const along = p.side === '+x' || p.side === '-x';
  const lane = along ? p.j0 + p.column : p.i0 + p.column;
  const start = p.side === '+x' ? p.i0 + 2 : p.side === '-x' ? p.i0 - 1 : p.side === '+z' ? p.j0 + 2 : p.j0 - 1;
  const step = p.side === '+x' || p.side === '+z' ? 1 : -1;
  const at = (k: number): Cell => (along ? { i: start + step * k, j: lane } : { i: lane, j: start + step * k });
  return { block, ramp: [at(0), at(1)], entrance: at(2) };
}

/** 第 2 步：找一个能放高台的位置（高台和坡道的格子都没被占用，入口是通道）。 */
function placePlatform(rng: Rng, plan: Plan): PlatformPlan | null {
  const candidates: PlatformPlan[] = [];
  for (let j0 = 1; j0 <= plan.n - 3; j0++) {
    for (let i0 = 1; i0 <= plan.n - 3; i0++) {
      for (const side of ['+x', '-x', '+z', '-z'] as const) {
        for (const column of [0, 1] as const) {
          const p: PlatformPlan = { i0, j0, side, column };
          const { block, ramp, entrance } = platformCells(p);
          if (![...block, ...ramp].every((c) => plan.interior(c.i, c.j) && plan.get(c.i, c.j) === FREE)) continue;
          if (plan.get(entrance.i, entrance.j) !== CORRIDOR) continue;
          candidates.push(p);
        }
      }
    }
  }
  return candidates.length > 0 ? rng.pick(candidates) : null;
}

function describe(brief: Brief): string {
  return `${brief.tier} 地图（${String(GEN_CONFIG.tiers[brief.tier].size)} m）放 ${String(brief.collectibles)} 个收集点、${String(brief.platforms)} 个高台、${String(brief.guards)} 个守卫和 ${brief.density} 密度的障碍`;
}

function generate(brief: Brief, seed: string, config: GenConfig): LevelLayoutInput {
  const rng = new Rng(seed);
  const tier = config.tiers[brief.tier];
  const g = config.generator;
  const plan = new Plan(tier.size, g.cell);
  const n = plan.n;
  const minGuardDistance = config.check.spawnGuardDistance + g.cell / 2;

  // ---------- 1. 连通的可行走区域 ----------
  for (let k = 0; k < n; k++) {
    plan.set(k, 0, CORRIDOR);
    plan.set(k, n - 1, CORRIDOR);
    plan.set(0, k, CORRIDOR);
    plan.set(n - 1, k, CORRIDOR);
  }
  const patrols: PatrolPlan[] = [];
  for (let k = 0; k < brief.guards; k++) {
    const patrol = patrolCorridor(rng.child(`patrol-${String(k)}`), plan, brief);
    for (const c of patrol.cells) plan.carve(c.i, c.j);
    plan.connect(rng, patrol.cells);
    patrols.push(patrol);
  }
  const routeSegments = (): [Point2, Point2][] =>
    patrols.flatMap((p) => p.route.map((c, k): [Point2, Point2] => [plan.center(c.i, c.j), plan.center((p.route[(k + 1) % p.route.length] ?? c).i, (p.route[(k + 1) % p.route.length] ?? c).j)]));
  const farFromRoutes = (c: Cell, distance: number) => {
    const p = plan.center(c.i, c.j);
    return routeSegments().every(([a, b]) => pointSegmentDistance(p, a, b) >= distance);
  };

  // 收集点的空地
  const collectibleCells: Cell[] = [];
  const spacing = Math.max(3, n / (Math.sqrt(brief.collectibles) + 1));
  if (brief.distribution === 'scattered' || brief.distribution === 'edge') {
    const interior = allCells(n).filter((c) => plan.interior(c.i, c.j));
    // edge：空地挨着地图最外一圈的通道
    const candidates = brief.distribution === 'edge' ? interior.filter((c) => c.i === 1 || c.j === 1 || c.i === n - 2 || c.j === n - 2) : interior;
    const centers = spread(rng, candidates, brief.collectibles, spacing);
    if (centers.length < brief.collectibles) throw new CannotFit('放不下这么多收集点');
    for (const c of centers) {
      plan.plaza(rng, c);
      collectibleCells.push(c);
    }
  } else if (brief.distribution === 'clustered') {
    const center: Cell = { i: rng.int(2, n - 3), j: rng.int(2, n - 3) };
    const cells = plan.plaza(rng, center);
    const chosen = rng.shuffle(cells).slice(0, brief.collectibles);
    if (chosen.length < brief.collectibles) throw new CannotFit('一块空地放不下这么多收集点');
    collectibleCells.push(...chosen);
  }

  // 出生点的空地：离巡逻路线足够远，离收集点至少 4 m
  const spawnCandidates = allCells(n).filter(
    (c) =>
      plan.interior(c.i, c.j) &&
      farFromRoutes(c, minGuardDistance) &&
      collectibleCells.every((o) => Math.hypot(o.i - c.i, o.j - c.j) * g.cell >= 4),
  );
  if (spawnCandidates.length === 0) throw new CannotFit('放不下出生点（离守卫的巡逻路线要足够远）');
  const spawnCell = rng.pick(spawnCandidates);
  plan.plaza(rng, spawnCell);

  // 再加几条通往随机锚点的通道
  const anchors = Math.max(2, Math.round(n / 4));
  for (let k = 0; k < anchors; k++) {
    const a: Cell = { i: rng.int(1, n - 2), j: rng.int(1, n - 2) };
    plan.carve(a.i, a.j);
    plan.connect(rng, [a]);
  }

  // ---------- 2. 障碍和高台 ----------
  const platforms: PlatformPlan[] = [];
  for (let k = 0; k < brief.platforms; k++) {
    const p = placePlatform(rng, plan);
    if (!p) throw new CannotFit(`放不下第 ${String(k + 1)} 个高台`);
    const { block, ramp } = platformCells(p);
    for (const c of block) plan.set(c.i, c.j, PLATFORM);
    for (const c of ramp) plan.set(c.i, c.j, RAMP);
    platforms.push(p);
  }
  const boxCount = tier.obstacles[brief.density];
  const boxCells = rng.shuffle(plan.cellsOf(FREE, (c) => plan.interior(c.i, c.j))).slice(0, boxCount);
  if (boxCells.length < boxCount) throw new CannotFit(`放不下 ${String(boxCount)} 个障碍（只剩 ${String(boxCells.length)} 格空位）`);
  for (const c of boxCells) plan.set(c.i, c.j, BOX);

  // ---------- 3. 收集点、出生点和巡逻路线 ----------
  const m = g.margin;
  const half = g.cell / 2;
  const boxes = boxCells.map((c, k) => {
    const center = plan.center(c.i, c.j);
    const sx = rng.range(0.8, g.cell - 2 * m);
    const sz = rng.range(0.8, g.cell - 2 * m);
    const jitterX = half - m - sx / 2;
    const jitterZ = half - m - sz / 2;
    return {
      id: `box-${String(k + 1)}`,
      center: { x: round(center.x + rng.range(-jitterX, jitterX)), z: round(center.z + rng.range(-jitterZ, jitterZ)) },
      size: { x: round(sx), z: round(sz) },
      height: round(rng.range(g.boxHeight.min, g.boxHeight.max)),
    };
  });

  const platformLayouts = platforms.map((p, k) => {
    const a = plan.center(p.i0, p.j0);
    const center = { x: round(a.x + half), z: round(a.z + half) };
    const side = 2 * g.cell - 2 * m;
    return { id: `plat-${String(k + 1)}`, center, size: { x: round(side), z: round(side) } };
  });
  const ramps = platforms.map((p, k) => {
    const length = round(Math.max(SPEC.terrain.rampMinLength + 0.2, rng.range(g.rampLength.min, g.rampLength.max)));
    const width = round(rng.range(g.rampWidth.min, g.rampWidth.max));
    return { id: `ramp-${String(k + 1)}`, platform: `plat-${String(k + 1)}`, side: p.side, length, width, offset: (p.column === 0 ? -1 : 1) * half };
  });

  const collectibles: Point2[] = [];
  if (brief.distribution === 'elevated') {
    if (platformLayouts.length === 0) throw new CannotFit('没有高台可以放收集点');
    const perPlatform = new Map<number, number>();
    for (let k = 0; k < brief.collectibles; k++) {
      const index = k % platformLayouts.length;
      perPlatform.set(index, (perPlatform.get(index) ?? 0) + 1);
    }
    for (const [index, count] of perPlatform) {
      const p = platformLayouts[index];
      if (!p || count > MAX_COLLECTIBLES_PER_PLATFORM) throw new CannotFit('高台上放不下这么多收集点');
      if (count === 1) collectibles.push(p.center);
      else collectibles.push({ x: round(p.center.x - 0.7), z: p.center.z }, { x: round(p.center.x + 0.7), z: p.center.z });
    }
  } else {
    for (const c of collectibleCells) {
      const p = plan.center(c.i, c.j);
      collectibles.push({ x: round(p.x), z: round(p.z) });
    }
  }

  const spawnPoint = plan.center(spawnCell.i, spawnCell.j);
  const nearest = collectibles.reduce<Point2 | null>((best, c) => {
    if (!best) return c;
    return Math.hypot(c.x - spawnPoint.x, c.z - spawnPoint.z) < Math.hypot(best.x - spawnPoint.x, best.z - spawnPoint.z) ? c : best;
  }, null);
  const yaw = nearest ? round(Math.atan2(nearest.x - spawnPoint.x, nearest.z - spawnPoint.z)) : 0;

  return {
    id: `gen-${hash64(seed).slice(0, 10)}`,
    name: brief.title,
    size: { width: tier.size, depth: tier.size },
    spawn: { x: round(spawnPoint.x), z: round(spawnPoint.z), yaw },
    boxes,
    platforms: platformLayouts,
    ramps,
    collectibles: collectibles.map((p, k) => ({ id: `gem-${String(k + 1)}`, position: { x: round(p.x), z: round(p.z) } })),
    guards: patrols.map((patrol, k) => ({
      id: `guard-${String(k + 1)}`,
      route: patrol.route.map((c) => {
        const p = plan.center(c.i, c.j);
        return { x: round(p.x), z: round(p.z) };
      }),
    })),
    // 时间限制由时间推算决定；这里先放档位的上限，推算之后替换
    timeLimit: tier.timeLimit.max,
    target: collectibles.length,
  };
}

/** 用一个（子）种子做一次布局。放不下时返回原因。 */
export function generateLayout(brief: Brief, seed: string, config: GenConfig = GEN_CONFIG): GenerateResult {
  try {
    return { ok: true, layout: generate(brief, seed, config) };
  } catch (error) {
    if (error instanceof CannotFit) return { ok: false, reason: `${describe(brief)}：${error.message}` };
    throw error;
  }
}
