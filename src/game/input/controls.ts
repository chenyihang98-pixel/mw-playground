// 键盘和鼠标输入。键盘按住的状态 → 每步的移动输入；空格是边沿（按下后只给一次跳跃）。
// 鼠标改视角：优先用指针锁定；指针锁定用不了（浏览器不支持、被拒绝、出错）时，按住左键拖动也能转视角。
// 方向键也能转视角，作为第二种替代方式。

import type { LookMode } from '../appTypes';
import { keyAction, movementAxes, type KeyAction } from './keys';

export interface ControlsHandlers {
  /** 按了 Esc 或 P。 */
  onPauseKey(): void;
  /** 鼠标视角位移（像素）。 */
  onLook(dx: number, dy: number): void;
  /** 游玩中指针锁定被浏览器解除（通常是用户按了 Esc）。 */
  onPointerLockLost(): void;
}

/** 浏览器用 Esc 解除指针锁定后，可能还会把这次 Esc 的 keydown 发给页面；这段时间内忽略它，避免“暂停”马上又被“继续”。 */
const ESC_AFTER_UNLOCK_MS = 400;

export class Controls {
  private readonly held = new Set<KeyAction>();
  private jumpQueued = false;
  private dragging = false;
  private readonly lockSupported: boolean;
  private mode: LookMode;
  private locked = false;
  /** 游玩中：希望保持指针锁定。 */
  private engaged = false;
  /** 游戏自己调用了 exitPointerLock，等待解除完成。 */
  private releasing = false;
  private unlockedAt = -Infinity;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: ControlsHandlers,
  ) {
    this.lockSupported = typeof canvas.requestPointerLock === 'function';
    this.mode = this.lockSupported ? 'pointer-lock' : 'drag';
    this.listen(window, 'keydown', (e) => {
      this.onKeyDown(e as KeyboardEvent);
    });
    this.listen(window, 'keyup', (e) => {
      const action = keyAction((e as KeyboardEvent).code);
      if (action) this.held.delete(action);
    });
    this.listen(window, 'blur', () => {
      this.held.clear();
      this.dragging = false;
    });
    this.listen(document, 'pointerlockchange', () => {
      this.onLockChange();
    });
    this.listen(document, 'pointerlockerror', () => {
      this.mode = 'drag';
    });
    this.listen(canvas, 'mousedown', (e) => {
      if ((e as MouseEvent).button !== 0 || this.locked) return;
      this.dragging = true;
      // 游玩中没有锁定时，点一下画面重新锁定（点击是用户手势，浏览器允许）
      if (this.engaged) this.requestLock();
    });
    this.listen(window, 'mouseup', () => {
      this.dragging = false;
    });
    this.listen(window, 'mousemove', (e) => {
      const m = e as MouseEvent;
      if (this.locked || this.dragging) this.handlers.onLook(m.movementX, m.movementY);
    });
  }

  private listen(target: EventTarget, type: string, handler: (e: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => {
      target.removeEventListener(type, handler);
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = keyAction(e.code);
    if (!action) return;
    if (action === 'jump' || action.startsWith('look')) e.preventDefault();
    if (action === 'pause') {
      if (e.repeat) return;
      if (e.code === 'Escape' && performance.now() - this.unlockedAt < ESC_AFTER_UNLOCK_MS) return;
      this.handlers.onPauseKey();
      return;
    }
    if (action === 'jump' && !e.repeat) this.jumpQueued = true;
    this.held.add(action);
  }

  private onLockChange(): void {
    const nowLocked = document.pointerLockElement === this.canvas;
    const wasLocked = this.locked;
    this.locked = nowLocked;
    if (nowLocked) {
      this.mode = 'pointer-lock';
      this.dragging = false;
      // 锁定请求完成之前游戏已经暂停或结束：立刻释放
      if (!this.engaged) this.exitLock();
      return;
    }
    if (!wasLocked) return;
    if (this.releasing) {
      // 游戏自己释放的（暂停、结束）
      this.releasing = false;
      return;
    }
    if (this.engaged) {
      // 浏览器解除的（通常是 Esc）
      this.unlockedAt = performance.now();
      this.handlers.onPointerLockLost();
    }
  }

  private requestLock(): void {
    if (!this.lockSupported || this.locked) return;
    try {
      const result: unknown = this.canvas.requestPointerLock();
      if (result instanceof Promise) {
        result.catch(() => {
          this.mode = 'drag';
        });
      }
    } catch {
      this.mode = 'drag';
    }
  }

  private exitLock(): void {
    if (document.pointerLockElement === this.canvas) {
      this.releasing = true;
      document.exitPointerLock();
    }
  }

  /** 当前的移动输入（不含相机朝向）。 */
  axes(): { forward: number; right: number; run: boolean; jump: boolean } {
    return { ...movementAxes(this.held), jump: this.jumpQueued };
  }

  /** 方向键的视角输入。 */
  lookKeys(): { turn: number; tilt: number } {
    return {
      turn: (this.held.has('lookRight') ? 1 : 0) - (this.held.has('lookLeft') ? 1 : 0),
      tilt: (this.held.has('lookDown') ? 1 : 0) - (this.held.has('lookUp') ? 1 : 0),
    };
  }

  /** 跳跃已经交给模拟（或当前不在游玩，丢弃）。 */
  consumeJump(): void {
    this.jumpQueued = false;
  }

  /** 进入游玩时调用：尝试指针锁定；失败时用拖动转视角，不影响游玩。 */
  engage(): void {
    this.engaged = true;
    this.requestLock();
  }

  /** 暂停或结束时调用：释放指针锁定。 */
  release(): void {
    this.engaged = false;
    this.dragging = false;
    this.exitLock();
  }

  lookMode(): LookMode {
    return this.mode;
  }

  pointerLocked(): boolean {
    return this.locked;
  }

  dispose(): void {
    this.release();
    for (const off of this.cleanup) off();
  }
}
