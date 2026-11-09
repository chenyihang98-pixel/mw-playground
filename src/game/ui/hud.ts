// HUD（剩余时间、已收集数 / 目标数、扣时反馈）和覆盖层（开始、暂停、结算）。只读游戏状态。

import './hud.css';
import type { OverlayKind } from '../appTypes';
import type { GameState } from '../sim';
import { SPEC } from '../spec';
import { formatTime } from './format';

export interface HudActions {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
}

/** 剩余时间少于它时 HUD 时间变橙色。只是界面提示，不是玩法参数。 */
const LOW_TIME_WARNING_SECONDS = 15;

const CONTROLS_HELP = [
  'W A S D：按相机方向移动；Shift：跑；空格：跳',
  '鼠标：转视角（点“开始”后锁定指针；锁定不可用时按住左键拖动）；方向键也能转视角',
  'Esc 或 P：暂停 / 继续',
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, id?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (text !== undefined) el.textContent = text;
  return el;
}

export class Hud {
  private readonly time = element('div', 'hud-time');
  private readonly collect = element('div', 'hud-collect');
  private readonly penalty = element('div', 'hud-penalty');
  private readonly flash = element('div', 'hit-flash');
  private readonly overlay = element('div', 'game-overlay');
  private overlayKind: OverlayKind | null = null;
  private seenHits = 0;

  constructor(
    root: HTMLElement,
    private readonly actions: HudActions,
  ) {
    const hud = element('div', 'hud');
    const level = element('div', 'hud-level');
    level.dataset.role = 'level-name';
    const timeRow = element('div', 'hud-time-row');
    timeRow.append(this.penalty, this.time);
    hud.append(timeRow, this.collect, level);
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.hidden = true;
    for (const el of [this.flash, this.penalty]) {
      el.addEventListener('animationend', () => {
        el.classList.remove('active', 'show');
      });
    }
    root.append(hud, this.flash, this.overlay);
  }

  /** 每帧调用：刷新数字，发现新的扣时就闪一下。 */
  update(state: GameState): void {
    this.time.textContent = `剩余 ${formatTime(state.timeLeft)}`;
    this.time.classList.toggle('cooldown', state.hitCooldown > 0);
    this.time.classList.toggle('low', state.hitCooldown === 0 && state.timeLeft <= LOW_TIME_WARNING_SECONDS);
    this.collect.textContent = `收集 ${String(state.collected.length)} / ${String(state.level.target)}`;
    const levelName = this.time.closest('#hud')?.querySelector<HTMLElement>('[data-role="level-name"]');
    if (levelName) levelName.textContent = state.level.name;
    if (state.hits.length > this.seenHits) {
      this.restartAnimation(this.flash, 'active');
      this.penalty.textContent = `−${String(SPEC.guard.penaltySeconds)} 秒`;
      this.restartAnimation(this.penalty, 'show');
    }
    this.seenHits = state.hits.length;
  }

  private restartAnimation(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    el.getBoundingClientRect(); // 强制重排，让同一个动画能再次播放
    el.classList.add(cls);
  }

  currentOverlay(): OverlayKind | null {
    return this.overlayKind;
  }

  showOverlay(kind: OverlayKind | null, state: GameState): void {
    this.overlayKind = kind;
    if (kind === null) {
      this.overlay.hidden = true;
      this.overlay.replaceChildren();
      return;
    }
    this.overlay.hidden = false;
    this.overlay.dataset.kind = kind;
    const panel = element('div');
    panel.className = 'panel';
    const button = (label: string, action: () => void) => {
      const b = element('button', undefined, label);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        action();
      });
      return b;
    };
    if (kind === 'start') {
      panel.append(
        element('h1', undefined, state.level.name),
        element(
          'p',
          undefined,
          `在 ${String(state.level.timeLimit)} 秒内收集 ${String(state.level.target)} 个宝石。` +
            (state.level.guards.length > 0 ? `小心巡逻的守卫：碰到会扣 ${String(SPEC.guard.penaltySeconds)} 秒。` : ''),
        ),
        ...CONTROLS_HELP.map((line) => {
          const p = element('p', undefined, line);
          p.className = 'controls';
          return p;
        }),
        button('开始', () => {
          this.actions.onStart();
        }),
      );
    } else if (kind === 'pause') {
      panel.append(
        element('h1', undefined, '已暂停'),
        element('p', undefined, '按 Esc 或 P 继续'),
        button('继续', () => {
          this.actions.onResume();
        }),
      );
    } else {
      const won = kind === 'won';
      panel.append(
        element('h1', undefined, won ? '胜利' : '失败'),
        element('p', undefined, won ? '收集完成！' : '时间到了。'),
        element(
          'p',
          undefined,
          `收集 ${String(state.collected.length)} / ${String(state.level.target)}，用时 ${state.simTime.toFixed(1)} 秒，被守卫碰到 ${String(state.hits.length)} 次`,
        ),
        button('重开', () => {
          this.actions.onRestart();
        }),
      );
    }
    this.overlay.replaceChildren(panel);
  }
}
