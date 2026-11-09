// 关卡选择（P5）：内置关卡（含 P2 的三张）、随机一关（先预览，再确认、重来或放弃）、已保存的关卡（可以删除）。
// 功能能用就行，视觉留给 P6。游玩时隐藏。

import './levelSelect.css';
import type { BuiltinEntry } from '../levels/catalog';
import type { LevelPackage } from '../levels/package';
import type { RandomJobState, RandomLevelJob } from '../levels/randomJob';
import type { SavedLevels } from '../levels/saved';
import type { LevelSelectSnapshot } from '../appTypes';

export interface LevelSelectHost {
  isPlaying(): boolean;
  current(): LevelPackage;
  builtins(): readonly BuiltinEntry[];
  loadBuiltin(id: string): void;
  loadPackage(pkg: LevelPackage): void;
  /** 开始一次随机生成（状态变化时回调 onUpdate）。 */
  startRandom(onUpdate: (state: RandomJobState) => void): RandomLevelJob;
  /** 随机生成全部失败时加载回退关卡，返回它。 */
  loadFallback(): LevelPackage;
  readonly saved: SavedLevels;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: { id?: string; className?: string; text?: string } = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.id) node.id = attrs.id;
  if (attrs.className) node.className = attrs.className;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  return node;
}

function button(text: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = el('button', { text });
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

const TIER_LABEL: Readonly<Record<string, string>> = { small: '小', medium: '中', large: '大' };
/** 收集点分布在界面上的叫法（elevated 叫“只放在高台上”）。 */
const DISTRIBUTION_LABEL: Readonly<Record<string, string>> = { scattered: '分散', edge: '靠边', elevated: '只放在高台上', clustered: '集中' };
const PATROL_LABEL: Readonly<Record<string, string>> = { loop: '绕圈', 'back-and-forth': '来回' };

/** 俯视的小地图：地面、盒子、高台、坡道、收集点、出生点、巡逻路线。 */
function drawMap(canvas: HTMLCanvasElement, pkg: LevelPackage): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const layout = pkg.layout;
  const size = Math.max(layout.size.width, layout.size.depth);
  const scale = canvas.width / size;
  const px = (x: number) => (x + layout.size.width / 2) * scale;
  const pz = (z: number) => (z + layout.size.depth / 2) * scale;
  ctx.fillStyle = pkg.visual.theme === 'sand' ? '#d9c08a' : pkg.visual.theme === 'snow' ? '#eef2f7' : '#8fb276';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rect = (cx: number, cz: number, sx: number, sz: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(px(cx - sx / 2), pz(cz - sz / 2), sx * scale, sz * scale);
  };
  for (const b of layout.boxes) rect(b.center.x, b.center.z, b.size.x, b.size.z, '#8a5a30');
  for (const p of layout.platforms) rect(p.center.x, p.center.z, p.size.x, p.size.z, '#7d8794');
  for (const r of layout.ramps) {
    const p = layout.platforms.find((q) => q.id === r.platform);
    if (!p) continue;
    const along = r.side === '+x' || r.side === '-x';
    const sign = r.side === '+x' || r.side === '+z' ? 1 : -1;
    const cx = along ? p.center.x + sign * (p.size.x / 2 + r.length / 2) : p.center.x + r.offset;
    const cz = along ? p.center.z + r.offset : p.center.z + sign * (p.size.z / 2 + r.length / 2);
    rect(cx, cz, along ? r.length : r.width, along ? r.width : r.length, '#b5bcc4');
  }
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 2;
  for (const g of layout.guards) {
    ctx.beginPath();
    g.route.forEach((p, i) => {
      if (i === 0) ctx.moveTo(px(p.x), pz(p.z));
      else ctx.lineTo(px(p.x), pz(p.z));
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = '#ffd23f';
  for (const c of layout.collectibles) {
    ctx.beginPath();
    ctx.arc(px(c.position.x), pz(c.position.z), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#3f7fd9';
  ctx.beginPath();
  ctx.arc(px(layout.spawn.x), pz(layout.spawn.z), 5, 0, Math.PI * 2);
  ctx.fill();
}

export class LevelSelectPanel {
  private readonly bar = el('div', { id: 'level-bar' });
  private readonly toggle = el('button', { id: 'level-toggle' });
  private readonly panel = el('section', { id: 'level-panel' });
  private readonly builtinList = el('div', { className: 'list' });
  private readonly randomArea = el('div', { id: 'level-random' });
  private readonly savedList = el('div', { className: 'list', id: 'level-saved' });
  private readonly storage = el('div', { id: 'level-storage' });
  private job: RandomLevelJob | null = null;
  private jobState: RandomJobState | null = null;
  private fallbackKey: string | null = null;
  private open = false;
  private visible = true;

  constructor(
    root: HTMLElement,
    private readonly host: LevelSelectHost,
  ) {
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => {
      this.setOpen(!this.open);
    });
    this.bar.append(this.toggle);
    this.panel.setAttribute('aria-label', '选择关卡');
    this.panel.hidden = true;
    this.storage.setAttribute('role', 'alert');
    const header = el('div', { className: 'row' });
    header.append(
      el('h2', { text: '选择关卡' }),
      button('关闭', () => {
        this.setOpen(false);
      }, '关闭关卡选择'),
    );
    this.panel.append(
      header,
      this.storage,
      el('h3', { text: '内置关卡' }),
      this.builtinList,
      el('h3', { text: '随机一关' }),
      this.randomArea,
      el('h3', { text: '已保存的关卡' }),
      this.savedList,
    );
    root.append(this.bar, this.panel);
    host.saved.onChange(() => {
      this.refresh();
    });
    this.refresh();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open || this.host.isPlaying();
    this.refresh();
  }

  /** 关卡变了（换关、名册变化）后刷新。 */
  refresh(): void {
    const current = this.host.current();
    this.toggle.textContent = `关卡：${current.title}`;
    this.toggle.setAttribute('aria-label', '选择关卡');
    this.builtinList.replaceChildren(
      ...this.host.builtins().map((b) => {
        const row = el('div', { className: 'row' });
        const load = button(b.title, () => {
          this.host.loadBuiltin(b.id);
          this.setOpen(false);
        }, `加载内置关卡 ${b.title}`);
        if (current.key === `builtin:${b.id}`) load.classList.add('current');
        row.append(load, el('span', { className: 'muted', text: b.kind === 'generated' ? '（生成器做的）' : '' }));
        return row;
      }),
    );
    this.renderRandom();
    this.renderSaved(current);
  }

  private renderRandom(): void {
    const state = this.jobState;
    const parts: HTMLElement[] = [];
    if (!state || state.kind === 'cancelled' || state.kind === 'failed') {
      parts.push(
        button('随机一关', () => {
          this.startRandom();
        }),
      );
      if (state?.kind === 'cancelled') parts.push(el('div', { className: 'muted', text: '已取消这次生成。' }));
      if (state?.kind === 'failed') {
        parts.push(el('div', { className: 'warn', text: `随机生成试了 ${String(state.tried)} 份说明书都没有成功，已加载内置的回退关卡。` }));
        const reasons = el('ul');
        for (const r of state.reasons) reasons.append(el('li', { text: r }));
        parts.push(reasons);
      }
    } else if (state.kind === 'running') {
      parts.push(
        el('div', { text: `正在生成…（已试 ${String(state.tried)} / ${String(state.total)} 份说明书）` }),
        button('取消生成', () => {
          this.job?.cancel();
        }),
      );
    } else {
      const pkg = state.pkg;
      const brief = pkg.brief;
      const canvas = el('canvas', { id: 'level-preview-map' });
      canvas.width = 260;
      canvas.height = 260;
      drawMap(canvas, pkg);
      const info = el('div', { id: 'level-preview-info' });
      if (brief) {
        info.append(
          el('div', { text: `${pkg.title}（${TIER_LABEL[brief.tier] ?? brief.tier}地图，障碍 ${brief.density}，高台 ${String(brief.platforms)}，收集点 ${String(brief.collectibles)}（${DISTRIBUTION_LABEL[brief.distribution] ?? brief.distribution}），守卫 ${String(brief.guards)}（${PATROL_LABEL[brief.patrol] ?? brief.patrol}），难度 ${brief.intent}）` }),
          el('div', { text: `视觉：${brief.visual.theme} / ${brief.visual.time} / ${brief.visual.weather}；时间限制 ${String(pkg.rules.timeLimit)} 秒（估计值）` }),
        );
        if (brief.opening) info.append(el('div', { className: 'muted', text: brief.opening }));
      }
      for (const note of state.notes) info.append(el('div', { className: 'warn', text: note }));
      parts.push(
        canvas,
        info,
        el('div', { className: 'muted', text: '空间与规则检查通过，难度为估计。' }),
        button('确认', () => {
          this.confirm(pkg);
        }, '确认这一关'),
        button('重来', () => {
          this.startRandom();
        }, '重新随机一关'),
        button('放弃', () => {
          this.job?.cancel();
        }, '放弃这一关'),
      );
    }
    this.randomArea.replaceChildren(...parts);
  }

  private renderSaved(current: LevelPackage): void {
    const saved = this.host.saved;
    this.storage.textContent = saved.storageProblem ?? '';
    const entries = saved.list();
    if (entries.length === 0) {
      this.savedList.replaceChildren(el('div', { className: 'muted', text: saved.loading ? '正在读取…' : '还没有保存的关卡。' }));
      return;
    }
    this.savedList.replaceChildren(
      ...entries.map((e) => {
        const row = el('div', { className: 'row' });
        row.dataset.id = e.id;
        if (e.status === 'ready') {
          const pkg = saved.get(e.id);
          const load = button(e.title, () => {
            if (pkg) this.host.loadPackage(pkg);
            this.setOpen(false);
          }, `加载已保存的关卡 ${e.title}`);
          if (current.key === `saved:${e.id}`) load.classList.add('current');
          row.append(load, el('span', { className: 'muted', text: `${e.source === 'adjusted' ? '程序调整' : e.source === 'model' ? '模型' : '随机'}，${String(e.timeLimit ?? '')} 秒` }));
        } else {
          row.append(el('span', { className: 'warn', text: `无法读取：${e.error ?? ''}` }));
        }
        row.append(
          button('删除', () => {
            void saved.remove(e.id);
          }, `删除已保存的关卡 ${e.title}`),
        );
        return row;
      }),
    );
  }

  private startRandom(): void {
    this.job?.cancel();
    this.fallbackKey = null;
    this.job = this.host.startRandom((state) => {
      this.jobState = state;
      if (state.kind === 'failed') this.fallbackKey = this.host.loadFallback().key;
      this.refresh();
    });
  }

  private confirm(pkg: LevelPackage): void {
    const result = this.host.saved.save(pkg);
    const saved = result.ok ? this.host.saved.get(result.id) : null;
    this.host.loadPackage(saved ?? pkg);
    this.job = null;
    this.jobState = null;
    this.setOpen(false);
  }

  update(): void {
    const playing = this.host.isPlaying();
    if (playing === this.visible) {
      this.visible = !playing;
      this.bar.hidden = playing;
      this.panel.hidden = playing || !this.open;
    }
  }

  snapshot(): LevelSelectSnapshot {
    const state = this.jobState;
    const preview = state?.kind === 'preview' ? state.pkg : null;
    return {
      open: this.open,
      random: {
        kind: state?.kind ?? 'idle',
        tried: state?.tried ?? 0,
        previewHash: preview?.layoutHash ?? null,
        previewTitle: preview?.title ?? null,
        previewSource: preview?.source ?? null,
        previewTimeLimit: preview?.rules.timeLimit ?? null,
        previewCast: (preview?.brief?.cast ?? []).map((c) => ({ personId: c.personId, role: c.role })),
        notes: state?.kind === 'preview' ? [...state.notes] : [],
        reasons: state?.kind === 'failed' ? [...state.reasons] : [],
        fallbackKey: this.fallbackKey,
      },
    };
  }
}
