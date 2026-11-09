// 关卡选择（P5）：内置关卡（含 P2 的三张）、随机一关（先预览，再确认、重来或放弃）、已保存的关卡（可以删除）。
// P6：居中的主面板（由 PanelManager 管显示，打开时关卡开始面板让位，M7）；每一关标出来源和难度估计，带俯视小地图。

import './levelSelect.css';
import type { BuiltinEntry } from '../levels/catalog';
import type { LevelPackage } from '../levels/package';
import type { RandomJobState, RandomLevelJob } from '../levels/randomJob';
import type { SavedLevels } from '../levels/saved';
import type { LevelSelectSnapshot } from '../appTypes';
import { button, el, notice, tag } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { DIFFICULTY_COLORS, THEME_LABELS, TIME_LABELS, WEATHER_LABELS, drawLevelMap, estimateDifficulty, sourceBadge, visualLabel } from './levelInfo';

export interface LevelSelectHost {
  current(): LevelPackage;
  builtins(): readonly BuiltinEntry[];
  /** 内置关卡的内容（用来画小地图、估计难度）。 */
  builtinPackage(id: string): LevelPackage | null;
  loadBuiltin(id: string): void;
  loadPackage(pkg: LevelPackage): void;
  /** 开始一次随机生成（状态变化时回调 onUpdate）。 */
  startRandom(onUpdate: (state: RandomJobState) => void): RandomLevelJob;
  /** 随机生成全部失败时加载回退关卡，返回它。 */
  loadFallback(): LevelPackage;
  /** 关掉关卡选择面板。 */
  close(): void;
  readonly saved: SavedLevels;
}

const TIER_LABEL: Readonly<Record<string, string>> = { small: '小', medium: '中', large: '大' };
/** 收集点分布在界面上的叫法（elevated 叫“只放在高台上”）。 */
const DISTRIBUTION_LABEL: Readonly<Record<string, string>> = { scattered: '分散', edge: '靠边', elevated: '只放在高台上', clustered: '集中' };
const PATROL_LABEL: Readonly<Record<string, string>> = { loop: '绕圈', 'back-and-forth': '来回' };
const DENSITY_LABEL: Readonly<Record<string, string>> = { low: '少', mid: '中', high: '多' };
const INTENT_LABEL: Readonly<Record<string, string>> = { relaxed: '轻松', normal: '普通', tense: '紧张' };

/** 列表里每一关的小地图边长（像素）。 */
const THUMB_MAP = 64;

function levelTags(pkg: LevelPackage, kind?: 'handmade' | 'generated'): HTMLElement[] {
  const source = sourceBadge(pkg, kind);
  const difficulty = estimateDifficulty(pkg);
  const tags = [tag(source.text, source.color, 'layers')];
  const diff = difficulty.label ? tag(`难度估计：${difficulty.label}`, DIFFICULTY_COLORS[difficulty.label], 'star') : tag('难度：无法估计', 'default', 'star');
  if (difficulty.routeSeconds !== null) diff.title = `按跑速收集完约 ${difficulty.routeSeconds.toFixed(0)} 秒（不算守卫和绕路）`;
  tags.push(diff);
  return tags;
}

function levelFacts(pkg: LevelPackage): string {
  const guards = pkg.layout.guards.length;
  return `${String(pkg.rules.timeLimit)} 秒 · ${String(pkg.rules.target)} 个宝石 · ${guards > 0 ? `${String(guards)} 个守卫` : '没有守卫'} · ${visualLabel(pkg)}`;
}

function mapCanvas(pkg: LevelPackage, size: number, id?: string): HTMLCanvasElement {
  const canvas = el('canvas', { className: 'level-map', id });
  canvas.width = size;
  canvas.height = size;
  canvas.setAttribute('aria-hidden', 'true');
  drawLevelMap(canvas, pkg);
  return canvas;
}

export class LevelSelectPanel {
  private readonly panel = el('section', { id: 'level-panel', className: 'mw-panel mw-main-panel' });
  private readonly currentTag = el('span', { className: 'level-current' });
  private readonly closeButton: HTMLButtonElement;
  private readonly builtinList = el('div', { className: 'level-list' });
  private readonly randomArea = el('div', { id: 'level-random' });
  private readonly savedList = el('div', { className: 'level-list', id: 'level-saved' });
  private readonly savedCount = el('span', { className: 'mw-subtle' });
  private readonly storage = el('div', { id: 'level-storage' });
  private readonly builtinCache = new Map<string, LevelPackage | null>();
  private job: RandomLevelJob | null = null;
  private jobState: RandomJobState | null = null;
  private fallbackKey: string | null = null;
  private shown = false;

  constructor(
    root: HTMLElement,
    private readonly host: LevelSelectHost,
  ) {
    this.panel.setAttribute('aria-label', '选择关卡');
    this.panel.hidden = true;
    this.storage.setAttribute('role', 'alert');
    const header = el('div', { className: 'mw-panel-header' });
    const title = el('h2');
    title.append(icon('map', 'mw-icon level-title-icon'), document.createTextNode('选择关卡'));
    this.closeButton = button('关闭', () => {
      this.host.close();
    }, { icon: 'close', iconOnly: true, variant: 'ghost', label: '关闭关卡选择' });
    header.append(title, this.currentTag, this.closeButton);

    const left = el('div', { className: 'level-col mw-scroll' });
    const savedTitle = el('h3', { className: 'mw-section-title', text: '已保存的关卡 ' });
    savedTitle.append(this.savedCount);
    left.append(el('h3', { className: 'mw-section-title', text: '内置关卡' }), this.builtinList, savedTitle, this.savedList);
    const right = el('div', { className: 'level-col level-col--random mw-scroll' });
    right.append(el('h3', { className: 'mw-section-title', text: '随机一关' }), this.randomArea);
    const body = el('div', { className: 'mw-panel-body level-body' });
    body.append(this.storage, left, right);
    this.panel.append(header, body);
    root.append(this.panel);
    host.saved.onChange(() => {
      this.refresh();
    });
    this.refresh();
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    this.panel.hidden = !shown;
    if (shown) this.refresh();
  }

  focusFirst(): void {
    const current = this.panel.querySelector<HTMLButtonElement>('.level-item.is-current .level-load');
    (current ?? this.closeButton).focus({ preventScroll: true });
  }

  private builtin(id: string): LevelPackage | null {
    if (!this.builtinCache.has(id)) this.builtinCache.set(id, this.host.builtinPackage(id));
    return this.builtinCache.get(id) ?? null;
  }

  /** 一关的条目：小地图、名字、来源和难度估计、规则摘要；整行是加载按钮。 */
  private item(pkg: LevelPackage | null, title: string, label: string, isCurrent: boolean, onLoad: () => void, kind?: 'handmade' | 'generated'): HTMLElement {
    const item = el('div', { className: 'level-item' });
    item.classList.toggle('is-current', isCurrent);
    const load = el('button', { className: 'level-load' });
    load.type = 'button';
    load.setAttribute('aria-label', label);
    load.addEventListener('click', onLoad);
    const text = el('span', { className: 'level-text' });
    const name = el('span', { className: 'level-name', text: title });
    if (isCurrent) name.append(tag('当前', 'gold'));
    text.append(name);
    if (pkg) {
      const tags = el('span', { className: 'level-tags' });
      tags.append(...levelTags(pkg, kind));
      text.append(tags, el('span', { className: 'level-facts', text: levelFacts(pkg) }));
      load.append(mapCanvas(pkg, THUMB_MAP), text);
    } else {
      load.append(text);
    }
    item.append(load);
    return item;
  }

  /** 关卡变了（换关、名册变化）后刷新。 */
  refresh(): void {
    if (!this.shown) return; // 显示时再画（setShown 会刷新）
    const current = this.host.current();
    this.currentTag.replaceChildren(tag(`当前：${current.title}`, 'gold', 'map'));
    this.builtinList.replaceChildren(
      ...this.host.builtins().map((b) =>
        this.item(this.builtin(b.id), b.title, `加载内置关卡 ${b.title}`, current.key === `builtin:${b.id}`, () => {
          this.host.loadBuiltin(b.id);
          this.host.close();
        }, b.kind),
      ),
    );
    this.renderRandom();
    this.renderSaved(current);
  }

  private renderRandom(): void {
    const state = this.jobState;
    const parts: HTMLElement[] = [];
    if (!state || state.kind === 'cancelled' || state.kind === 'failed' || state.kind === 'defect') {
      const intro = el('div', { className: 'random-intro' });
      intro.append(
        icon('dice', 'mw-icon random-icon'),
        el('p', { text: '按一份随机的关卡说明书现场生成一关。先看预览，满意再确认；确认后会保存到“已保存的关卡”。' }),
      );
      parts.push(
        intro,
        button('随机一关', () => {
          this.startRandom();
        }, { icon: 'dice', variant: 'accent', size: 'lg', className: 'random-go' }),
      );
      if (state?.kind === 'cancelled') parts.push(el('p', { className: 'mw-muted random-note', text: '已取消这次生成。' }));
      if (state?.kind === 'defect') {
        const list = el('ul', { className: 'mw-notices' });
        list.append(notice('error', '随机生成发现程序缺陷（检查器拒绝了生成器做出的布局），已停止生成，并加载了内置的回退关卡。'));
        for (const p of state.problems) list.append(notice('error', p));
        parts.push(list);
      }
      if (state?.kind === 'failed') {
        const list = el('ul', { className: 'mw-notices' });
        list.append(notice('warning', `随机生成试了 ${String(state.tried)} 份说明书都没有成功，已加载内置的回退关卡。`));
        for (const r of state.reasons) list.append(notice('info', r));
        parts.push(list);
      }
    } else if (state.kind === 'running') {
      const progress = el('div', { className: 'random-progress' });
      const bar = el('div', { className: 'random-bar' });
      const fill = el('div', { className: 'random-bar-fill' });
      fill.style.width = `${String(Math.round(((state.tried + 0.5) / Math.max(1, state.total)) * 100))}%`;
      bar.append(fill);
      progress.append(el('p', { text: `正在生成…（已试 ${String(state.tried)} / ${String(state.total)} 份说明书）` }), bar);
      parts.push(
        progress,
        button('取消生成', () => {
          this.job?.cancel();
        }, { icon: 'close' }),
      );
    } else {
      const pkg = state.pkg;
      const brief = pkg.brief;
      const preview = el('div', { className: 'random-preview' });
      const head = el('div', { className: 'random-head' });
      head.append(el('strong', { className: 'random-title', text: pkg.title }));
      const tags = el('div', { className: 'level-tags' });
      tags.append(...levelTags(pkg));
      head.append(tags);
      const facts = el('dl', { className: 'random-facts' });
      const fact = (k: string, v: string) => {
        const box = el('div');
        box.append(el('dt', { text: k }), el('dd', { text: v }));
        facts.append(box);
      };
      fact('时间限制', `${String(pkg.rules.timeLimit)} 秒（估计值）`);
      fact('宝石', `${String(pkg.rules.target)} 个`);
      if (brief) {
        fact('地图', `${TIER_LABEL[brief.tier] ?? brief.tier}地图，障碍${DENSITY_LABEL[brief.density] ?? brief.density}，高台 ${String(brief.platforms)} 个`);
        fact('收集点', `${String(brief.collectibles)} 个，${DISTRIBUTION_LABEL[brief.distribution] ?? brief.distribution}`);
        fact('守卫', brief.guards > 0 ? `${String(brief.guards)} 个，${PATROL_LABEL[brief.patrol] ?? brief.patrol}` : '没有');
        fact('说明书难度', INTENT_LABEL[brief.intent] ?? brief.intent);
        fact('视觉', `${THEME_LABELS[brief.visual.theme] ?? brief.visual.theme} · ${TIME_LABELS[brief.visual.time] ?? brief.visual.time} · ${WEATHER_LABELS[brief.visual.weather] ?? brief.visual.weather}`);
      }
      const mapBox = el('div', { className: 'random-map' });
      mapBox.append(mapCanvas(pkg, 260, 'level-preview-map'));
      preview.append(mapBox, facts);
      parts.push(head, preview);
      if (brief?.opening) parts.push(el('p', { className: 'random-opening', text: brief.opening }));
      if (state.notes.length > 0) {
        const notes = el('ul', { className: 'mw-notices' });
        for (const note of state.notes) notes.append(notice('warning', note));
        parts.push(notes);
      }
      const checked = el('p', { className: 'random-checked' });
      checked.append(icon('check', 'mw-icon'), document.createTextNode('空间与规则检查通过，难度为估计。'));
      const actions = el('div', { className: 'random-actions' });
      actions.append(
        button('确认', () => {
          this.confirm(pkg);
        }, { icon: 'check', variant: 'primary', label: '确认这一关' }),
        button('重来', () => {
          this.startRandom();
        }, { icon: 'refresh', label: '重新随机一关' }),
        button('放弃', () => {
          this.job?.cancel();
        }, { icon: 'close', variant: 'ghost', label: '放弃这一关' }),
      );
      parts.push(checked, actions);
    }
    // 重建前记住焦点在哪个按钮上（键盘操作时不丢焦点）
    const focused = document.activeElement instanceof HTMLButtonElement && this.randomArea.contains(document.activeElement);
    this.randomArea.replaceChildren(...parts);
    if (focused) this.randomArea.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  private renderSaved(current: LevelPackage): void {
    const saved = this.host.saved;
    this.storage.replaceChildren();
    if (saved.storageProblem) this.storage.append(notice('error', saved.storageProblem));
    this.storage.hidden = saved.storageProblem === null;
    const entries = saved.list();
    this.savedCount.textContent = entries.length > 0 ? `${String(entries.length)} 个` : '';
    if (entries.length === 0) {
      this.savedList.replaceChildren(el('p', { className: 'level-empty', text: saved.loading ? '正在读取…' : '还没有保存的关卡。随机一关并确认后会出现在这里。' }));
      return;
    }
    this.savedList.replaceChildren(
      ...entries.map((e) => {
        let item: HTMLElement;
        if (e.status === 'ready') {
          const pkg = saved.get(e.id);
          item = this.item(pkg, e.title, `加载已保存的关卡 ${e.title}`, current.key === `saved:${e.id}`, () => {
            if (pkg) this.host.loadPackage(pkg);
            this.host.close();
          });
        } else {
          item = el('div', { className: 'level-item is-broken' });
          const text = el('div', { className: 'level-text' });
          text.append(el('span', { className: 'level-name', text: e.title }), el('span', { className: 'level-facts', text: `无法读取：${e.error ?? ''}` }));
          item.append(text);
        }
        item.dataset.id = e.id;
        item.append(
          button('删除', () => {
            void saved.remove(e.id);
          }, { icon: 'trash', iconOnly: true, variant: 'ghost', size: 'sm', label: `删除已保存的关卡 ${e.title}`, className: 'level-delete' }),
        );
        return item;
      }),
    );
  }

  private startRandom(): void {
    this.job?.cancel();
    this.fallbackKey = null;
    this.job = this.host.startRandom((state) => {
      this.jobState = state;
      if (state.kind === 'failed' || state.kind === 'defect') this.fallbackKey = this.host.loadFallback().key;
      this.refresh();
    });
  }

  private confirm(pkg: LevelPackage): void {
    const result = this.host.saved.save(pkg);
    const saved = result.ok ? this.host.saved.get(result.id) : null;
    this.host.loadPackage(saved ?? pkg);
    this.job = null;
    this.jobState = null;
    this.host.close();
  }

  /** 每一关的来源和难度估计（快照用）。 */
  private entries(): LevelSelectSnapshot['entries'] {
    const out: LevelSelectSnapshot['entries'][number][] = [];
    for (const b of this.host.builtins()) {
      const pkg = this.builtin(b.id);
      if (pkg) out.push({ key: pkg.key, title: b.title, source: sourceBadge(pkg, b.kind).text, difficulty: estimateDifficulty(pkg).label });
    }
    for (const e of this.host.saved.list()) {
      const pkg = e.status === 'ready' ? this.host.saved.get(e.id) : null;
      if (pkg) out.push({ key: pkg.key, title: e.title, source: sourceBadge(pkg).text, difficulty: estimateDifficulty(pkg).label });
    }
    return out;
  }

  snapshot(): LevelSelectSnapshot {
    const state = this.jobState;
    const preview = state?.kind === 'preview' ? state.pkg : null;
    return {
      open: this.shown,
      entries: this.entries(),
      random: {
        kind: state?.kind ?? 'idle',
        tried: state?.tried ?? 0,
        previewHash: preview?.layoutHash ?? null,
        previewTitle: preview?.title ?? null,
        previewSource: preview?.source ?? null,
        previewTimeLimit: preview?.rules.timeLimit ?? null,
        previewCast: (preview?.brief?.cast ?? []).map((c) => ({ personId: c.personId, role: c.role })),
        notes: state?.kind === 'preview' ? [...state.notes] : [],
        reasons: state?.kind === 'failed' ? [...state.reasons] : state?.kind === 'defect' ? [...state.problems] : [],
        fallbackKey: this.fallbackKey,
      },
    };
  }
}
