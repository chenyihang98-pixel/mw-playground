// 导入界面对外的只读快照类型（测试钩子返回它）。只放类型，不引入界面代码和样式。

import type { AnimatorSnapshot } from '../animator';
import type { LoopRaw, Playback, PlaybackSource, Purpose, Slots } from '../clipRules';
import type { ImportFormat } from '../precheck';

export interface ClipRowSnapshot {
  readonly index: number;
  /** 稳定标识：文件 SHA-256 + 序号。 */
  readonly key: string;
  readonly name: string;
  readonly duration: number;
  readonly recognized: Purpose;
  readonly purpose: Purpose;
  readonly purposeSource: 'manual' | 'auto';
  readonly playback: Playback;
  readonly playbackSource: PlaybackSource;
  readonly loopRaw: LoopRaw;
  readonly slot: string | null;
  readonly short: boolean;
  readonly rootMotion: {
    readonly kind: string;
    /** 承担整体位移的节点（能识别时）。 */
    readonly nodeName: string | null;
    readonly maxHorizontal: number | null;
    readonly flagged: boolean;
    readonly reason: string | null;
  };
  readonly lockAvailable: boolean;
  readonly locked: boolean;
  /** 锁定后游戏用的片段副本里剩下的最大水平位移；没锁定时为 null。 */
  readonly lockedResidual: number | null;
  readonly notes: readonly string[];
}

export interface ImportCardSnapshot {
  readonly assetId: string;
  readonly fileName: string;
  readonly format: ImportFormat;
  readonly sizeBytes: number;
  readonly displayHeight: number;
  readonly quarterTurns: number;
  /** 归一化之后的尺寸（米）。 */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  /** 预览实例归一化之后的包围盒（外层节点所在空间，绑定姿态）。 */
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  readonly triangles: number;
  readonly meshes: number;
  readonly skinned: boolean;
  readonly bones: number;
  /** 加载后材质里能读到尺寸的贴图。 */
  readonly textures: readonly { readonly width: number; readonly height: number }[];
  readonly notices: readonly string[];
  readonly clips: readonly ClipRowSnapshot[];
  readonly slots: Slots;
  readonly plan: { readonly idle: string; readonly walk: string; readonly run: string; readonly jump: string | null; readonly sway: boolean };
  readonly preview: { readonly clipIndex: number | null; readonly playing: boolean; readonly mixerTime: number };
  readonly isPlayer: boolean;
}

export interface ImportPanelSnapshot {
  readonly busy: boolean;
  /** 最近一次导入失败的提示；成功导入后清空。 */
  readonly error: string | null;
  readonly warnings: readonly string[];
  readonly card: ImportCardSnapshot | null;
}

export interface PlayerModelSnapshot {
  readonly model: 'default' | 'imported';
  readonly assetId: string | null;
  readonly fileName: string | null;
  readonly animator: AnimatorSnapshot | null;
}
