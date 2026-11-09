// 键位表（纯函数，可单独测试）。用 KeyboardEvent.code，不受键盘布局和输入法影响。

export type KeyAction = 'forward' | 'back' | 'left' | 'right' | 'run' | 'jump' | 'pause' | 'lookLeft' | 'lookRight' | 'lookUp' | 'lookDown';

const KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  Space: 'jump',
  Escape: 'pause',
  KeyP: 'pause',
  ArrowLeft: 'lookLeft',
  ArrowRight: 'lookRight',
  ArrowUp: 'lookUp',
  ArrowDown: 'lookDown',
};

export function keyAction(code: string): KeyAction | null {
  return Object.hasOwn(KEY_ACTIONS, code) ? (KEY_ACTIONS[code] ?? null) : null;
}

/** 按住的动作 → 移动输入（W/S 前后，A/D 左右）。 */
export function movementAxes(held: ReadonlySet<KeyAction>): { forward: number; right: number; run: boolean } {
  return {
    forward: (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0),
    right: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
    run: held.has('run'),
  };
}
