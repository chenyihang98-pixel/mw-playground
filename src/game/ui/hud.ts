// HUD（剩余时间、收集进度、暂停提示、扣时反馈）和覆盖层（关卡开始面板、暂停菜单、结算）。只读游戏状态。
// P6 按 docs/design.md 重新排版：HUD 在顶部中间；覆盖层是居中的面板，打开时把焦点放在主按钮上，可以只用键盘操作。
// 别的主面板（关卡选择、名册、导入卡片）或开始界面打开时，覆盖层让位（setSuppressed），不叠在一起。

import './hud.css';
import type { OverlayDock, OverlayKind } from '../appTypes';
import type { GameState } from '../sim';
import { button, el, tag, type TagColor } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { formatTime } from './format';
import { t } from '../../i18n';
import { markRaw } from '../../ui/raw';
import { langSelect } from '../../ui/langSelect';

/** 关卡开始前说明面板里的开场白和出场人物的台词（P5）。 */
export interface LevelIntro {
  readonly opening: string;
  /** 开场白是生成的文字，原样显示（F6；内置关卡的开场白按 id 翻译，不是原样）。 */
  readonly openingRaw: boolean;
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
  ['W A S D', t('help.move')],
  ['Shift', t('help.run')],
  [t('help.space'), t('help.jump')],
  [t('help.mouseArrows'), t('help.look')],
  ['Esc / P', t('help.pause')],
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
  private intro: LevelIntro = { opening: '', openingRaw: false, lines: [], notices: [] };
  private badges: LevelBadges | null = null;
  /** 显示的关卡名（F6）：内置关卡是按 id 翻译的名字；其他关卡是保存的标题（原样显示，raw 为 true）。没设时用布局里的名字。 */
  private title: { readonly text: string; readonly raw: boolean } | null = null;
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
    this.hint.textContent = t('hud.escPause');
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
    this.time.textContent = t('hud.timeLeft', { time: formatTime(state.timeLeft) });
    this.time.classList.toggle('cooldown', state.hitCooldown > 0);
    this.time.classList.toggle('low', state.hitCooldown === 0 && state.timeLeft <= LOW_TIME_WARNING_SECONDS);
    this.collect.textContent = t('hud.collected', { count: String(state.collected.length), target: String(state.level.target) });
    this.progress.style.width = `${String(Math.min(100, (state.collected.length / Math.max(1, state.level.target)) * 100))}%`;
    this.level.textContent = this.title?.text ?? state.level.name;
    markRaw(this.level, this.title?.raw ?? false);
    // 关卡名和暂停提示只在游玩中显示（其余时候顶栏和开始面板上都有）
    this.level.hidden = state.phase !== 'playing';
    this.hint.hidden = state.phase !== 'playing';
    let hit = false;
    if (state.hits.length > this.seenHits) {
      this.restartAnimation(this.flash, 'active');
      this.penalty.textContent = t('hud.penalty', { seconds: String(state.rules.penaltySeconds) });
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

  /** 设置显示的关卡名（F6）。raw 为 true 时是用户数据或生成的文字，原样显示。 */
  setTitle(text: string, raw: boolean): void {
    this.title = { text, raw };
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
      head.append(icon('map', 'mw-icon overlay-icon'), markRaw(el('h1', { text: this.title?.text ?? state.level.name }), this.title?.raw ?? false));
      const meta = el('div', { className: 'overlay-meta' });
      meta.append(
        tag(t('common.seconds', { seconds: String(state.level.timeLimit) }), 'blue', 'clock'),
        tag(t('hud.gems', { count: String(state.level.target) }), 'gold', 'gem'),
        tag(state.level.guards.length > 0 ? t('hud.guards', { count: String(state.level.guards.length) }) : t('hud.noGuards'), state.level.guards.length > 0 ? 'red' : 'default', 'shield'),
      );
      if (this.badges) {
        meta.append(tag(this.badges.source.text, this.badges.source.color, 'layers'));
        if (this.badges.difficulty) meta.append(tag(t('level.difficultyTag', { difficulty: this.badges.difficulty }), 'purple', 'star'));
      }
      panel.append(
        head,
        meta,
        el('p', {
          className: 'overlay-goal',
          text:
            t('hud.goal', { seconds: String(state.level.timeLimit), count: String(state.level.target) }) +
            (state.level.guards.length > 0 ? t('hud.guardWarning', { seconds: String(state.rules.penaltySeconds) }) : ''),
        }),
      );
      // 开场白和台词是生成的文字，人物名是名册里的名字：原样显示（F6 不翻译，F7 处理生成的文字）
      if (this.intro.opening) panel.append(markRaw(el('p', { id: 'intro-opening', className: 'overlay-opening', text: this.intro.opening }), this.intro.openingRaw));
      for (const l of this.intro.lines) {
        const line = markRaw(el('p', { className: 'intro-line' }));
        line.append(el('strong', { text: t('intro.speaker', { name: l.name, role: l.role }) }), document.createTextNode(t('intro.line', { line: l.line })));
        panel.append(line);
      }
      for (const n of this.intro.notices) {
        const p = el('p', { className: 'intro-notice', text: n });
        panel.append(p);
      }
      const help = el('details', { className: 'overlay-help' });
      const summary = el('summary', { text: t('help.title') });
      help.append(summary, controlsHelp());
      panel.append(help);
      const actions = el('div', { className: 'overlay-actions' });
      actions.append(primary(button(t('common.start'), go(() => {
        this.actions.onStart();
      }), { icon: 'play', variant: 'primary', size: 'lg' })));
      panel.append(actions);
    } else if (kind === 'pause') {
      const head = el('div', { className: 'overlay-head' });
      head.append(icon('pause', 'mw-icon overlay-icon'), el('h1', { text: t('hud.paused') }));
      const actions = el('div', { className: 'overlay-actions overlay-actions--column' });
      actions.append(
        primary(button(t('hud.resume'), go(() => {
          this.actions.onResume();
        }), { icon: 'play', variant: 'primary', size: 'lg' })),
        button(t('hud.restart'), go(() => {
          this.actions.onRestart();
        }), { icon: 'refresh', size: 'lg' }),
        button(t('hud.backHome'), go(() => {
          this.actions.onHome();
        }), { icon: 'home', size: 'lg' }),
      );
      // 语言选择（F6）：切换会刷新页面、回到开始界面；只在暂停菜单和开始界面里提供
      const lang = el('div', { className: 'overlay-lang' });
      lang.append(langSelect('pause-lang'), el('p', { className: 'mw-subtle', text: t('lang.reloadHint') }));
      panel.append(head, el('p', { className: 'overlay-goal', text: t('hud.pauseHint') }), actions, lang);
    } else {
      const won = kind === 'won';
      const head = el('div', { className: 'overlay-head' });
      head.append(icon(won ? 'trophy' : 'hourglass', 'mw-icon overlay-icon'), el('h1', { text: won ? t('hud.won') : t('hud.lost') }));
      const stats = el('dl', { className: 'overlay-stats' });
      const stat = (label: string, value: string) => {
        const box = el('div', { className: 'overlay-stat' });
        box.append(el('dt', { text: label }), el('dd', { text: value }));
        stats.append(box);
      };
      stat(t('hud.timeUsed'), t('common.seconds', { seconds: state.simTime.toFixed(1) }));
      stat(t('hud.collectedLabel'), `${String(state.collected.length)} / ${String(state.level.target)}`);
      stat(t('hud.hits'), t('hud.times', { count: String(state.hits.length) }));
      stat(t('hud.timeLeftLabel'), formatTime(state.timeLeft));
      const actions = el('div', { className: 'overlay-actions' });
      actions.append(
        primary(button(t('hud.restart'), go(() => {
          this.actions.onRestart();
        }), { icon: 'refresh', variant: 'primary', size: 'lg' })),
        button(t('hud.back'), go(() => {
          this.actions.onHome();
        }), { icon: 'home', size: 'lg', label: t('hud.backHome') }),
      );
      panel.append(head, el('p', { className: 'overlay-goal', text: won ? t('hud.wonReason') : t('hud.lostReason') }), stats, actions);
    }
    this.overlay.replaceChildren(panel);
    // 只在覆盖层换了一种（新出现）或焦点原来就在覆盖层里时移焦点；名册变化时重画开始面板，不抢走名册里的焦点
    if (kind !== previous || hadFocus) this.focusPrimary();
  }
}
