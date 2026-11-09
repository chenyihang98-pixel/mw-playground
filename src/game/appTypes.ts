// 游戏页对外的只读快照类型（测试钩子返回它）。只放类型，不引入渲染或界面代码。

import type { ImportPanelSnapshot, PlayerModelSnapshot } from '../import/ui/types';
import type { CastSnapshot, RosterSnapshot } from '../roster/types';
import type { Brief, VisualPreset } from './level/gen/brief';
import type { LevelRules, LevelSource } from './levels/package';
import type { SavedLevelEntry } from './levels/saved';
import type { RandomJobState } from './levels/randomJob';
import type { EnvironmentSnapshot } from './render/environment';
import type { RenderStats } from '../scene/createScene';
import type { GameSnapshot } from './sim/snapshot';

export type LookMode = 'pointer-lock' | 'drag';

/** 关卡选择界面的只读快照（P5）。 */
export interface LevelSelectSnapshot {
  readonly open: boolean;
  readonly random: {
    readonly kind: RandomJobState['kind'] | 'idle';
    readonly tried: number;
    readonly previewHash: string | null;
    readonly previewTitle: string | null;
    readonly previewSource: string | null;
    readonly previewTimeLimit: number | null;
    /** 预览的关卡说明书里列出的出场人物。 */
    readonly previewCast: readonly { readonly personId: string; readonly role: string }[];
    readonly notes: readonly string[];
    readonly reasons: readonly string[];
    readonly fallbackKey: string | null;
  };
}
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
  /** 名册（P4）。 */
  readonly roster: RosterSnapshot;
  /** 分工的分配结果（P4）：主角、关卡里每个守卫、同伴各用哪个人物。 */
  readonly cast: CastSnapshot;
  /** 当前关卡（P5）：来源、说明书、布局哈希、视觉预设和生效的规则。 */
  readonly level: {
    readonly key: string;
    readonly source: LevelSource;
    readonly title: string;
    readonly layoutHash: string;
    readonly seed: string | null;
    readonly brief: Brief | null;
    readonly visual: VisualPreset;
    readonly rules: LevelRules;
    readonly schemaVersion: number | null;
    readonly generatorVersion: number | null;
    readonly adjustment: { readonly reason: string; readonly change: string } | null;
  };
  /** 关卡选择（P5）：随机生成的状态和预览、已保存的关卡。 */
  readonly levels: {
    readonly select: LevelSelectSnapshot;
    readonly saved: readonly SavedLevelEntry[];
    readonly loading: boolean;
    readonly storage: { readonly ok: boolean; readonly problem: string | null };
    readonly notices: readonly string[];
  };
  /** 视觉预设在场景里的效果（P5）。 */
  readonly environment: EnvironmentSnapshot;
}
