// 关卡在界面上的说明（P6）：来源、难度估计、视觉预设的叫法，以及俯视小地图。只读关卡数据，不改玩法。
//
// 难度估计：用 P5 的检查器和路线时间（checkLevel + routeTime，和生成器无关）算出按跑速收集完需要的时间 T，
// 再看这一关的时间限制相当于 T 的几倍（先扣掉生成时用的最低余量）：
//   系数 ≥ 2.3 → 轻松；≥ 1.75 → 普通；更小 → 紧张（三档的分界取 P5 难度系数 2.6 / 2.0 / 1.5 的中点）。
// 守卫扣时、跳跃和绕路都没算进去，所以只是估计；检查器算不出路线时显示“无法估计”。结果按布局哈希和时间限制缓存。

import { checkLevel } from '../level/gen/checker';
import { GEN_CONFIG } from '../level/gen/config';
import { routeTime } from '../level/gen/timing';
import type { LevelPackage } from '../levels/package';
import type { TagColor } from '../../ui/dom';
import type { DifficultyLabel } from '../appTypes';

export type { DifficultyLabel };

export interface DifficultyEstimate {
  /** 算不出时为 null（界面显示“无法估计”）。 */
  readonly label: DifficultyLabel | null;
  /** 按跑速收集完的路线时间（秒）。 */
  readonly routeSeconds: number | null;
  /** （时间限制 − 余量）/ 路线时间。 */
  readonly factor: number | null;
}

/** 分界：P5 三档难度系数（2.6 / 2.0 / 1.5）相邻两档的中点。 */
export const DIFFICULTY_THRESHOLDS = { relaxed: 2.3, normal: 1.75 } as const;

const cache = new Map<string, DifficultyEstimate>();

export function difficultyOf(factor: number): DifficultyLabel {
  if (factor >= DIFFICULTY_THRESHOLDS.relaxed) return '轻松';
  if (factor >= DIFFICULTY_THRESHOLDS.normal) return '普通';
  return '紧张';
}

export function estimateDifficulty(pkg: LevelPackage): DifficultyEstimate {
  const key = `${pkg.layoutHash}:${String(pkg.rules.timeLimit)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let estimate: DifficultyEstimate = { label: null, routeSeconds: null, factor: null };
  try {
    // 出生点和守卫的距离不影响路线时间：P2 的测试小关 B 守卫就从出生点经过
    const report = checkLevel(pkg.layout, { spawnGuardDistance: 0 });
    const route = routeTime(report);
    if (route && route.seconds > 0) {
      const factor = (pkg.rules.timeLimit - GEN_CONFIG.timing.margin) / route.seconds;
      estimate = { label: difficultyOf(factor), routeSeconds: route.seconds, factor };
    }
  } catch {
    // 估计不出来不影响选关
  }
  cache.set(key, estimate);
  return estimate;
}

export const DIFFICULTY_COLORS: Readonly<Record<DifficultyLabel, TagColor>> = { 轻松: 'green', 普通: 'blue', 紧张: 'red' };

export interface SourceBadge {
  readonly text: string;
  readonly color: TagColor;
}

/** 来源的叫法。内置关卡再分 P2 的手工地图和生成器做的冻结关卡。 */
export function sourceBadge(pkg: LevelPackage, builtinKind?: 'handmade' | 'generated'): SourceBadge {
  switch (pkg.source) {
    case 'builtin':
      if (pkg.key.startsWith('dev:')) return { text: '测试关卡', color: 'default' };
      return { text: builtinKind === 'generated' || (builtinKind === undefined && pkg.brief !== null) ? '内置 · 生成' : '内置 · 手工', color: 'default' };
    case 'random':
      return { text: '随机', color: 'purple' };
    case 'adjusted':
      return { text: '随机 · 程序调整', color: 'orange' };
    case 'model':
      return { text: '模型生成', color: 'purple' };
  }
}

export const THEME_LABELS: Readonly<Record<string, string>> = { grass: '草地', sand: '沙地', snow: '雪地' };
export const TIME_LABELS: Readonly<Record<string, string>> = { day: '白天', dusk: '黄昏', night: '夜晚' };
export const WEATHER_LABELS: Readonly<Record<string, string>> = { clear: '晴', fog: '雾', rain: '雨' };

/** 视觉预设的叫法，例如“雪地 · 夜晚 · 雨”。 */
export function visualLabel(pkg: LevelPackage): string {
  const v = pkg.visual;
  return [THEME_LABELS[v.theme] ?? v.theme, TIME_LABELS[v.time] ?? v.time, WEATHER_LABELS[v.weather] ?? v.weather].join(' · ');
}

const MAP_GROUND: Readonly<Record<string, string>> = { grass: '#86b86a', sand: '#e1c58e', snow: '#eef2f7' };
const MAP_NIGHT_TINT: Readonly<Record<string, string>> = { day: 'rgba(0,0,0,0)', dusk: 'rgba(120,60,40,0.12)', night: 'rgba(20,30,70,0.28)' };

/**
 * 俯视的小地图：地面、盒子、高台、坡道、巡逻路线、收集点、出生点。大小按画布宽度缩放。
 * 朝向和出生时的视角一致：+Z（出生时面向的方向）朝上，+X 在左边。
 */
export function drawLevelMap(canvas: HTMLCanvasElement, pkg: LevelPackage): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const layout = pkg.layout;
  const size = Math.max(layout.size.width, layout.size.depth);
  const scale = canvas.width / size;
  const unit = canvas.width / 260;
  const offX = (size - layout.size.width) / 2;
  const offZ = (size - layout.size.depth) / 2;
  const px = (x: number) => (layout.size.width / 2 - x + offX) * scale;
  const pz = (z: number) => (layout.size.depth / 2 - z + offZ) * scale;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = MAP_GROUND[pkg.visual.theme] ?? '#86b86a';
  ctx.fillRect(px(layout.size.width / 2), pz(layout.size.depth / 2), layout.size.width * scale, layout.size.depth * scale);
  const rect = (cx: number, cz: number, sx: number, sz: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(px(cx + sx / 2), pz(cz + sz / 2), sx * scale, sz * scale);
  };
  for (const b of layout.boxes) rect(b.center.x, b.center.z, b.size.x, b.size.z, '#9a6a3c');
  for (const p of layout.platforms) rect(p.center.x, p.center.z, p.size.x, p.size.z, '#7d8794');
  for (const r of layout.ramps) {
    const p = layout.platforms.find((q) => q.id === r.platform);
    if (!p) continue;
    const along = r.side === '+x' || r.side === '-x';
    const sign = r.side === '+x' || r.side === '+z' ? 1 : -1;
    const cx = along ? p.center.x + sign * (p.size.x / 2 + r.length / 2) : p.center.x + r.offset;
    const cz = along ? p.center.z + r.offset : p.center.z + sign * (p.size.z / 2 + r.length / 2);
    rect(cx, cz, along ? r.length : r.width, along ? r.width : r.length, '#b8c0c9');
  }
  ctx.fillStyle = MAP_NIGHT_TINT[pkg.visual.time] ?? 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#d8443c';
  ctx.lineWidth = Math.max(1, 2 * unit);
  ctx.setLineDash([5 * unit, 4 * unit]);
  for (const g of layout.guards) {
    ctx.beginPath();
    g.route.forEach((p, i) => {
      if (i === 0) ctx.moveTo(px(p.x), pz(p.z));
      else ctx.lineTo(px(p.x), pz(p.z));
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const c of layout.collectibles) {
    ctx.fillStyle = '#ffc845';
    ctx.strokeStyle = '#7a5200';
    ctx.lineWidth = Math.max(0.75, unit);
    ctx.beginPath();
    ctx.arc(px(c.position.x), pz(c.position.z), Math.max(1.6, 4.5 * unit), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#3d8bff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(0.75, 1.5 * unit);
  ctx.beginPath();
  ctx.arc(px(layout.spawn.x), pz(layout.spawn.z), Math.max(2, 5.5 * unit), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}
