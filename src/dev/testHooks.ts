// 测试钩子：只在开发和测试模式下安装（见 src/main.ts）。
// 只能做两件事：观察状态、选择夹具。不能替代实际游玩，也不暴露 three 对象本身。

import { FIXTURES, isFixtureId } from '../asset/fixtures';
import type { RenderStats, SceneApp } from '../scene/createScene';
import type { GameAppSnapshot } from '../game/appTypes';
import type { FixturePreview, PreviewState } from './fixturePreview';
import type { MwGameTestHooks } from './gameTestHooks';

export interface FixtureInfo {
  readonly id: string;
  readonly title: string;
  readonly previewable: boolean;
}

export interface MwTestState {
  readonly mode: string;
  readonly render: RenderStats;
  readonly preview: PreviewState;
}

export interface MwTestHooks {
  /** 夹具预览页（?view=fixtures）的钩子；游戏页的钩子见 gameTestHooks.ts。 */
  readonly kind: 'fixtures';
  readonly version: 1;
  /** 观察：当前状态的快照（纯数据）。 */
  getState(): MwTestState;
  /** 观察：可选的夹具。 */
  listFixtures(): readonly FixtureInfo[];
  /** 选择夹具：加载完成后返回新状态。 */
  selectFixture(id: string): Promise<MwTestState>;
}

declare global {
  interface Window {
    __MW_TEST__?: MwTestHooks | MwGameTestHooks<GameAppSnapshot>;
  }
}

export function installTestHooks(app: SceneApp, preview: FixturePreview, mode: string): MwTestHooks {
  const getState = (): MwTestState => ({
    mode,
    render: app.stats(),
    preview: preview.state(),
  });
  const hooks: MwTestHooks = Object.freeze({
    kind: 'fixtures' as const,
    version: 1 as const,
    getState,
    listFixtures: () => FIXTURES.map((f) => ({ id: f.id, title: f.title, previewable: f.previewable })),
    selectFixture: async (id: string) => {
      if (!isFixtureId(id)) throw new Error(`未知夹具：${id}`);
      await preview.load(id);
      return getState();
    },
  });
  Object.defineProperty(window, '__MW_TEST__', { value: hooks, writable: false, configurable: false, enumerable: false });
  return hooks;
}
