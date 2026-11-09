// 主面板的管理（P6，M7）：关卡选择、名册、导入卡片同时只显示一个。
// 打开一个面板时，原来显示的面板让出位置（导入卡片只是隐藏，不释放，关掉后面的面板时再回来）；
// 游玩中全部隐藏。Esc 关掉最上面的面板，关掉后焦点回到打开前的位置。

import type { PanelId } from '../game/appTypes';

export type { PanelId };

export interface ManagedPanel {
  /** 显示或隐藏（不释放内容）。 */
  setShown(shown: boolean): void;
  /** 面板显示后把焦点放到第一个控件上。 */
  focusFirst(): void;
  /** 用 Esc 或关闭按钮关掉（导入卡片在这里释放资产）。默认只是从栈里移除。 */
  dismiss?(): void;
}

export class PanelManager {
  private readonly panels = new Map<PanelId, ManagedPanel>();
  private order: PanelId[] = [];
  private suspended = false;
  private returnFocus: HTMLElement | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    // 捕获阶段：比游戏的按键处理先拿到 Esc，面板打开时 Esc 只关面板
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || this.suspended) return;
        const top = this.top;
        if (top === null) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const panel = this.panels.get(top);
        if (panel?.dismiss) panel.dismiss();
        else this.close(top);
      },
      { capture: true },
    );
  }

  register(id: PanelId, panel: ManagedPanel): void {
    this.panels.set(id, panel);
    panel.setShown(false);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** 栈顶的面板（显示中的那个；游玩中也返回它，只是暂时隐藏）。 */
  get top(): PanelId | null {
    return this.order.at(-1) ?? null;
  }

  /** 屏幕上正显示着的面板。 */
  get shown(): PanelId | null {
    return this.suspended ? null : this.top;
  }

  /** 面板的栈（最后一个在最上面）。 */
  get stack(): readonly PanelId[] {
    return [...this.order];
  }

  isOpen(id: PanelId): boolean {
    return this.order.includes(id);
  }

  open(id: PanelId): void {
    if (this.order.length === 0 && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      this.returnFocus = document.activeElement;
    }
    const already = this.top === id;
    this.order = [...this.order.filter((p) => p !== id), id];
    this.apply();
    if (!already && !this.suspended) this.panels.get(id)?.focusFirst();
  }

  close(id: PanelId): void {
    if (!this.order.includes(id)) return;
    const wasTop = this.top === id;
    this.order = this.order.filter((p) => p !== id);
    this.apply();
    if (!wasTop || this.suspended) return;
    const next = this.order.at(-1);
    if (next !== undefined) {
      this.panels.get(next)?.focusFirst();
      return;
    }
    const target = this.returnFocus;
    this.returnFocus = null;
    // 关掉后别的界面（例如重新出现的开始面板）已经接过焦点时，不再抢回来
    const active = document.activeElement;
    const lost = !(active instanceof HTMLElement) || active === document.body || active.offsetParent === null;
    if (lost && target?.isConnected && target.offsetParent !== null) target.focus({ preventScroll: true });
  }

  toggle(id: PanelId): void {
    if (this.top === id) {
      const panel = this.panels.get(id);
      if (panel?.dismiss) panel.dismiss();
      else this.close(id);
    } else {
      this.open(id);
    }
  }

  /** 游玩中：全部隐藏（栈保留，暂停或结算后恢复）。 */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return;
    this.suspended = suspended;
    this.apply();
  }

  private apply(): void {
    const shown = this.shown;
    for (const [id, panel] of this.panels) panel.setShown(id === shown);
    for (const listener of this.listeners) listener();
  }
}
