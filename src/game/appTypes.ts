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
import type { SoundSnapshot } from './audio/sound';

/** 主面板（P6）：关卡选择、名册、导入卡片。 */
export type PanelId = 'levels' | 'roster' | 'import';
/** 覆盖层的位置（P6）：居中，或让到左侧、右侧。 */
export type OverlayDock = 'center' | 'left' | 'right';
/** 难度估计的三档（P6）。 */
export type DifficultyLabel = '轻松' | '普通' | '紧张';

export type LookMode = 'pointer-lock' | 'drag';

/** 关卡选择界面的只读快照（P5）。 */
export interface LevelSelectSnapshot {
  /** 关卡选择面板显示在屏幕上。 */
  readonly open: boolean;
  /** 列表里每一关的来源和难度估计（P6）。 */
  readonly entries: readonly { readonly key: string; readonly title: string; readonly source: string; readonly difficulty: DifficultyLabel | null }[];
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

/** 关卡工坊的界面状态（P8）。 */
export interface WorkshopSnapshot {
  readonly health: { readonly kind: 'checking' | 'ok' | 'unreachable'; readonly provider: string | null; readonly model: string | null; readonly available: boolean; readonly reason: string | null };
  readonly view: 'idle' | 'running' | 'preview' | 'fallback' | 'cancelled' | 'saved' | 'message';
  readonly generationId: string | null;
  readonly previewHash: string | null;
  readonly outcome: string | null;
  readonly repairs: number | null;
  readonly fallbackId: string | null;
  readonly message: string | null;
  /** 工坊写进“已保存”的次数（按生成标识只写一次）。 */
  readonly saves: number;
}


/** 屏幕上的矩形（CSS 像素，左上角为原点）。 */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 界面的状态（P6）：开始界面、主面板、覆盖层的位置。 */
export interface UiSnapshot {
  /** 开始界面显示在屏幕上。 */
  readonly home: boolean;
  /** 处在开始界面这一层（开始界面本身，或从开始界面打开的面板）。 */
  readonly homeMode: boolean;
  /** 屏幕上显示的主面板。 */
  readonly panel: PanelId | null;
  /** 主面板的栈（最后一个在最上面；游玩中隐藏但保留）。 */
  readonly panelStack: readonly PanelId[];
  /** 覆盖层显示在屏幕上（overlay 是它的种类，被让位隐藏时仍是原来的种类）。 */
  readonly overlayVisible: boolean;
  readonly overlayDock: OverlayDock;
  readonly topBar: boolean;
  readonly hud: boolean;
  /** 名册卡片的缩略图：已画好的个数、排队的个数、是否在等名册恢复完。 */
  readonly thumbnails: { readonly rendered: number; readonly queued: number; readonly paused: boolean; readonly available: boolean };
}

/** 主角和同伴在屏幕上的包围框（P6：检查同伴有没有挡住主角）。 */
export interface ScreenSnapshot {
  readonly width: number;
  readonly height: number;
  readonly player: ScreenRect | null;
  readonly companions: readonly (ScreenRect | null)[];
  /** 相机到主角、各同伴包围盒中心的距离（米）。 */
  readonly depth: { readonly player: number | null; readonly companions: readonly (number | null)[] };
}

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
    /** 界面上的来源和难度估计（P6）。 */
    readonly sourceLabel: string;
    readonly difficulty: DifficultyLabel | null;
  };
  /** 关卡选择（P5）：随机生成的状态和预览、已保存的关卡。 */
  readonly levels: {
    readonly select: LevelSelectSnapshot;
    readonly saved: readonly SavedLevelEntry[];
    readonly loading: boolean;
    readonly storage: { readonly ok: boolean; readonly problem: string | null };
    readonly notices: readonly string[];
    /** 关卡工坊（P8）。 */
    readonly workshop: WorkshopSnapshot;
  };
  /** 视觉预设在场景里的效果（P5）。 */
  readonly environment: EnvironmentSnapshot;
  /** 界面（P6）。 */
  readonly ui: UiSnapshot;
  /** 音效和静音（P6）。 */
  readonly audio: SoundSnapshot;
  /** 主角和同伴在屏幕上的位置（P6）。 */
  readonly screen: ScreenSnapshot;
}
