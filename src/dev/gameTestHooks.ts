// 游戏的测试钩子：只在开发和测试模式下安装（见 src/main.ts）。
// 只能做两件事：读状态（getState / listLevels），以及选关卡（通过网址参数 ?level=<id>，钩子本身不能切换）。
// 不能改位置、时间、收集数，也不暴露游戏内部对象：getState 每次返回新建并深度冻结的快照。

export interface GameHookSource<S> {
  snapshot(): S;
}

export interface MwGameTestHooks<S = unknown> {
  readonly kind: 'game';
  readonly version: 1;
  /** 当前状态的只读快照。改它不会影响游戏（对象已冻结）。 */
  getState(): S;
  /** 可选的关卡（用 ?level=<id> 打开）。 */
  listLevels(): readonly { readonly id: string; readonly name: string }[];
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 生成钩子对象（不碰 window，便于单元测试）。 */
export function createGameTestHooks<S>(
  source: GameHookSource<S>,
  levels: readonly { id: string; name: string }[],
): MwGameTestHooks<S> {
  const levelList = deepFreeze(levels.map((l) => ({ id: l.id, name: l.name })));
  return Object.freeze({
    kind: 'game' as const,
    version: 1 as const,
    getState: () => deepFreeze(structuredClone(source.snapshot())),
    listLevels: () => levelList,
  });
}

export function installGameTestHooks<S>(hooks: MwGameTestHooks<S>): void {
  Object.defineProperty(window, '__MW_TEST__', { value: hooks, writable: false, configurable: false, enumerable: false });
}
