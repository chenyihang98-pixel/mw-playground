// 游戏页对外的只读快照类型（测试钩子返回它）。只放类型，不引入渲染或界面代码。

import type { ImportPanelSnapshot, PlayerModelSnapshot } from '../import/ui/types';
import type { RenderStats } from '../scene/createScene';
import type { GameSnapshot } from './sim/snapshot';

export type LookMode = 'pointer-lock' | 'drag';
export type OverlayKind = 'start' | 'pause' | 'won' | 'lost';

export interface GameAppSnapshot {
  readonly game: GameSnapshot;
  readonly camera: { readonly yaw: number; readonly pitch: number; readonly lookMode: LookMode; readonly pointerLocked: boolean };
  /** 当前显示的覆盖层；游玩中为 null。 */
  readonly overlay: OverlayKind | null;
  readonly render: RenderStats;
  /** 导入界面（P3）。 */
  readonly import: ImportPanelSnapshot;
  /** 主角当前用的模型（P3）：默认小人或导入的角色。 */
  readonly player: PlayerModelSnapshot;
  /** 游戏场景里导入实例的数量（上限 IMPORT_LIMITS.instancesMax）。 */
  readonly instances: number;
}
