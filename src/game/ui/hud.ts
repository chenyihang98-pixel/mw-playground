// HUD（剩余时间、收集进度、暂停提示、扣时反馈）和覆盖层（关卡开始面板、暂停菜单、结算）。只读游戏状态。
// P6 按 docs/design.md 重新排版：HUD 在顶部中间；覆盖层是居中的面板，打开时把焦点放在主按钮上，可以只用键盘操作。
// 别的主面板（关卡选择、名册、导入卡片）或开始界面打开时，覆盖层让位（setSuppressed），不叠在一起。

import './hud.css';
import type { OverlayDock, OverlayKind } from '../appTypes';
import type { GameState } from '../sim';
import { button, el, tag, type TagColor } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { formatTime } from './format';

/** 关卡开始前说明面板里的开场白和出场人物的台词（P5）。 */
export interface LevelIntro {
  readonly opening: string;
  readonly lines: readonly { readonly name: string; readonly role: string; readonly line: string }[];
  /** 加载时的提示（例如出场人物已被删除，用默认替身代替）。 */
  readonly notices: readonly string[];
}

/** 开始面板上的关卡信息：来源和难度估计（P6）。 */
export interface LevelBadges {
  readonly source: { readonly text: string; readonly color: TagColor };
  /** 难度估计，例如“普通”；算不出时为 null。 */
  readonly difficulty: string | null;
}

export interface HudActions {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  /** 回到开始界面（P6）。 */
  onHome(): void;
}

/** 剩余时间少于它时 HUD 时间变橙色。只是界面提示，不是玩法参数。 */
const LOW_TIME_WARNING_SECONDS = 15;

const CONTROLS_HELP: readonly [string, string][] = [
  ['W A S D', '按相机方向移动'],
  ['Shift', '跑'],
  ['空格', '跳'],
  ['鼠标 / 方向键', '转视角（点“开始”后锁定指针；锁定不可用时按住左键拖动）'],
  ['Esc / P', '暂停 / 继续'],
];

/** 操作说明（开始面板和开始界面共用）。 */
export function controlsHelp(): HTMLElement {
  const list = el('dl', { className: 'mw-keys' });
  for (const [key, what] of CONTROLS_HELP) {
    const dt = el('dt');
    dt.append(el('kbd', { text: key }));
    list.append(dt, el('dd', { text: what }));
  }
  return list;
}

export class Hud {
  private readonly root = el('div', { id: 'hud' });
  private readonly time = el('div', { id: 'hud-time' });
  private readonly collect = el('div', { id: 'hud-collect' });
  private readonly progress = el('div', { className: 'hud-progress-fill' });
  private readonly penalty = el('div', { id: 'hud-penalty' });
  private readonly hint = el('div', { id: 'hud-hint' });
  private readonly level = el('div', { id: 'hud-level' });
  private readonly flash = el('div', { id: 'hit-flash' });
  private readonly overlay = el('div', { id: 'game-overlay' });
  private overlayKind: OverlayKind | null = null;
  private intro: LevelIntro = { opening: '', lines: [], notices: [] };
  private badges: LevelBadges | null = null;
  private seenHits = 0;
  private suppressed = false;
  private hudVisible = true;

  constructor(
    root: HTMLElement,
    private readonly actions: HudActions,
  ) {
    const timeCard = el('div', { className: 'hud-card hud-card--time' });
    timeCard.append(icon('clock', 'mw-icon hud-icon'), this.time);
    const collectCard = el('div', { className: 'hud-card hud-card--collect' });
    const bar = el('div', { className: 'hud-progress' });
    bar.append(this.progress);
    const collectText = el('div', { className: 'hud-collect-text' });
    collectText.append(this.collect, bar);
    collectCard.append(icon('gem', 'mw-icon hud-icon hud-icon--gem'), collectText);
    const row = el('div', { className: 'hud-row' });
    row.append(timeCard, collectCard);
    this.level.dataset.role = 'level-name';
    this.hint.textContent = 'Esc 暂停';
    this.root.append(row, this.penalty, this.level, this.hint);
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'false');
    this.overlay.hidden = true;
    this.overlay.dataset.dock = 'center';
    // 用 Tab 把焦点移到暂停菜单的按钮上以后，P 和 Esc 仍然是“继续”（焦点在按钮上时游戏的按键处理不接收按键）
    this.overlay.addEventListener('keydown', (e) => {
      if (this.overlayKind !== 'pause' || e.repeat) return;
      if (e.code !== 'KeyP' && e.code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.actions.onResume();
    });
    for (const node of [this.flash, this.penalty]) {
      node.addEventListener('animationend', () => {
        node.classList.remove('active', 'pop');
      });
    }
    root.append(this.root, this.flash, this.overlay);
  }

  /** 每帧调用：刷新数字，发现新的扣时就闪一下。返回这一帧有没有新的扣时（给音效用）。 */
  update(state: GameState): boolean {
    this.time.textContent = `剩余 ${formatTime(state.timeLeft)}`;
    this.time.classList.toggle('cooldown', state.hitCooldown > 0);
    this.time.classList.toggle('low', state.hitCooldown === 0 && state.timeLeft <= LOW_TIME_WARNING_SECONDS);
    this.collect.textContent = `收集 ${String(state.collected.length)} / ${String(state.level.target)}`;
    this.progress.style.width = `${String(Math.min(100, (state.collected.length / Math.max(1, state.level.target)) * 100))}%`;
    this.level.textContent = state.level.name;
    // 关卡名和暂停提示只在游玩中显示（其余时候顶栏和开始面板上都有）
    this.level.hidden = state.phase !== 'playing';
    this.hint.hidden = state.phase !== 'playing';
    let hit = false;
    if (state.hits.length > this.seenHits) {
      this.restartAnimation(this.flash, 'active');
      this.penalty.textContent = `−${String(state.rules.penaltySeconds)} 秒`;
      this.restartAnimation(this.penalty, 'pop');
      hit = true;
    }
    // 扣时的提示在冷却期间一直显示（和变红的时间一起），冷却结束后淡出
    this.penalty.classList.toggle('show', state.hitCooldown > 0);
    this.seenHits = state.hits.length;
    return hit;
  }

  get hudShown(): boolean {
    return this.hudVisible;
  }

  /** 显示或隐藏 HUD（开始界面上隐藏）。 */
  setHudVisible(visible: boolean): void {
    if (visible === this.hudVisible) return;
    this.hudVisible = visible;
    this.root.hidden = !visible;
  }

  /** 开始界面或关卡选择打开时，覆盖层隐藏；关掉后恢复。 */
  setSuppressed(suppressed: boolean): void {
    if (suppressed === this.suppressed) return;
    this.suppressed = suppressed;
    this.overlay.hidden = suppressed || this.overlayKind === null;
    if (!suppressed) this.focusPrimary();
  }

  /** 侧边的主面板（名册在左、导入卡片在右）打开时，覆盖层让到另一侧，不叠在一起。 */
  setDock(dock: OverlayDock): void {
    this.overlay.dataset.dock = dock;
  }

  get dock(): OverlayDock {
    return (this.overlay.dataset.dock as OverlayDock | undefined) ?? 'center';
  }

  get isSuppressed(): boolean {
    return this.suppressed;
  }

  /** 覆盖层现在是否显示在屏幕上。 */
  get overlayShown(): boolean {
    return !this.overlay.hidden;
  }

  private restartAnimation(node: HTMLElement, cls: string): void {
    node.classList.remove(cls);
    node.getBoundingClientRect(); // 强制重排，让同一个动画能再次播放
    node.classList.add(cls);
  }

  currentOverlay(): OverlayKind | null {
    return this.overlayKind;
  }

  /** 设置这一关的开场白和台词（换关卡时调用，下次显示开始面板时生效）。 */
  setIntro(intro: LevelIntro): void {
    this.intro = intro;
  }

  /** 设置开始面板上的来源和难度估计（P6）。 */
  setBadges(badges: LevelBadges | null): void {
    this.badges = badges;
  }

  /**
   * 把焦点放到覆盖层的主按钮上（键盘可以直接按 Enter）。暂停菜单例外：暂停常常来自浏览器退出指针锁定的 Esc，
   * 焦点留在原处，P / Esc 照常由游戏处理（继续）；要用按钮时按 Tab 进入菜单。
   */
  private focusPrimary(): void {
    if (this.overlay.hidden || this.overlayKind === 'pause') return;
    this.overlay.querySelector<HTMLButtonElement>('button[data-primary]')?.focus({ preventScroll: true });
  }

  showOverlay(kind: OverlayKind | null, state: GameState): void {
    const previous = this.overlayKind;
    const hadFocus = document.activeElement instanceof Node && this.overlay.contains(document.activeElement);
    this.overlayKind = kind;
    if (kind === null) {
      this.overlay.hidden = true;
      this.overlay.replaceChildren();
      return;
    }
    this.overlay.hidden = this.suppressed;
    this.overlay.dataset.kind = kind;
    const panel = el('div', { className: 'panel mw-panel' });
    const primary = (b: HTMLButtonElement) => {
      b.dataset.primary = 'true';
      return b;
    };
    const go = (action: () => void) => (e?: Event) => {
      e?.stopPropagation();
      action();
    };
    if (kind === 'start') {
      const head = el('div', { className: 'overlay-head' });
      head.append(icon('map', 'mw-icon overlay-icon'), el('h1', { text: state.level.name }));
      const meta = el('div', { className: 'overlay-meta' });
      meta.append(
        tag(`${String(state.level.timeLimit)} 秒`, 'blue', 'clock'),
        tag(`${String(state.level.target)} 个宝石`, 'gold', 'gem'),
        tag(state.level.guards.length > 0 ? `${String(state.level.guards.length)} 个守卫` : '没有守卫', state.level.guards.length > 0 ? 'red' : 'default', 'shield'),
      );
      if (this.badges) {
        meta.append(tag(this.badges.source.text, this.badges.source.color, 'layers'));
        if (this.badges.difficulty) meta.append(tag(`难度估计：${this.badges.difficulty}`, 'purple', 'star'));
      }
      panel.append(
        head,
        meta,
        el('p', {
          className: 'overlay-goal',
          text:
            `在 ${String(state.level.timeLimit)} 秒内收集 ${String(state.level.target)} 个宝石。` +
            (state.level.guards.length > 0 ? `小心巡逻的守卫：碰到会扣 ${String(state.rules.penaltySeconds)} 秒。` : ''),
        }),
      );
      if (this.intro.opening) panel.append(el('p', { id: 'intro-opening', className: 'overlay-opening', text: this.intro.opening }));
      for (const l of this.intro.lines) {
        const line = el('p', { className: 'intro-line' });
        line.append(el('strong', { text: `${l.name}（${l.role}）` }), document.createTextNode(`：${l.line}`));
        panel.append(line);
      }
      for (const n of this.intro.notices) {
        const p = el('p', { className: 'intro-notice', text: n });
        panel.append(p);
      }
      const help = el('details', { className: 'overlay-help' });
      const summary = el('summary', { text: '操作说明' });
      help.append(summary, controlsHelp());
      panel.append(help);
      const actions = el('div', { className: 'overlay-actions' });
      actions.append(primary(button('开始', go(() => {
        this.actions.onStart();
      }), { icon: 'play', variant: 'primary', size: 'lg' })));
      panel.append(actions);
    } else if (kind === 'pause') {
      const head = el('div', { className: 'overlay-head' });
      head.append(icon('pause', 'mw-icon overlay-icon'), el('h1', { text: '已暂停' }));
      const actions = el('div', { className: 'overlay-actions overlay-actions--column' });
      actions.append(
        primary(button('继续', go(() => {
          this.actions.onResume();
        }), { icon: 'play', variant: 'primary', size: 'lg' })),
        button('重开', go(() => {
          this.actions.onRestart();
        }), { icon: 'refresh', size: 'lg' }),
        button('返回开始界面', go(() => {
          this.actions.onHome();
        }), { icon: 'home', size: 'lg' }),
      );
      panel.append(head, el('p', { className: 'overlay-goal', text: '按 Esc 或 P 继续' }), actions);
    } else {
      const won = kind === 'won';
      const head = el('div', { className: 'overlay-head' });
      head.append(icon(won ? 'trophy' : 'hourglass', 'mw-icon overlay-icon'), el('h1', { text: won ? '胜利' : '失败' }));
      const stats = el('dl', { className: 'overlay-stats' });
      const stat = (label: string, value: string) => {
        const box = el('div', { className: 'overlay-stat' });
        box.append(el('dt', { text: label }), el('dd', { text: value }));
        stats.append(box);
      };
      stat('用时', `${state.simTime.toFixed(1)} 秒`);
      stat('收集', `${String(state.collected.length)} / ${String(state.level.target)}`);
      stat('被守卫碰到', `${String(state.hits.length)} 次`);
      stat('剩余时间', formatTime(state.timeLeft));
      const actions = el('div', { className: 'overlay-actions' });
      actions.append(
        primary(button('重开', go(() => {
          this.actions.onRestart();
        }), { icon: 'refresh', variant: 'primary', size: 'lg' })),
        button('返回', go(() => {
          this.actions.onHome();
        }), { icon: 'home', size: 'lg', label: '返回开始界面' }),
      );
      panel.append(head, el('p', { className: 'overlay-goal', text: won ? '收集完成！' : '时间到了。' }), stats, actions);
    }
    this.overlay.replaceChildren(panel);
    // 只在覆盖层换了一种（新出现）或焦点原来就在覆盖层里时移焦点；名册变化时重画开始面板，不抢走名册里的焦点
    if (kind !== previous || hadFocus) this.focusPrimary();
  }
}
