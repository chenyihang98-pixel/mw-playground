// 名册和分工对外的只读快照类型（测试钩子返回它）。只放类型。

import type { AnimatorSnapshot } from '../import/animator';
import type { Slots } from '../import/clipRules';
import type { Role } from './config';

export interface RosterEntrySnapshot {
  /** 存储里的键：文件内容的 SHA-256（损坏的记录是它在存储里的键）。 */
  readonly key: string;
  readonly displayName: string;
  readonly fileName: string | null;
  /** 分工；认不出的版本或损坏的记录为 null。 */
  readonly role: Role | null;
  readonly roleLabel: string | null;
  /** loading：正在恢复；ready：已恢复；failed：恢复失败或记录认不出（只能删除）。 */
  readonly status: 'loading' | 'ready' | 'failed';
  readonly error: string | null;
  readonly order: number | null;
  readonly displayHeight: number | null;
  readonly quarterTurns: number | null;
  /** 归一化之后的尺寸（米）；没恢复时为 null。 */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number } | null;
  /** 片段建议（待机、走、跑、跳各用哪个片段）；没恢复时为 null。 */
  readonly slots: Slots | null;
  /** 保存的手动设置（键是“SHA-256#片段序号”）。 */
  readonly manual: {
    readonly purposes: Readonly<Record<string, string>>;
    readonly playbacks: Readonly<Record<string, string>>;
    readonly lockedMotion: readonly string[];
  } | null;
  /** 刚才重复加入时标出的那一项。 */
  readonly highlighted: boolean;
}

export interface RosterSnapshot {
  readonly restoring: boolean;
  /** 还有没写完的恢复或保存（刷新页面前等它变成 false）。 */
  readonly saving: boolean;
  readonly max: number;
  /** 存储是否正常；不正常时 problem 是提示文字（名册仍在内存里可用）。 */
  readonly storage: { readonly ok: boolean; readonly problem: string | null };
  readonly notices: readonly string[];
  readonly highlight: string | null;
  readonly entries: readonly RosterEntrySnapshot[];
}

export interface CastSlotSnapshot {
  /** 人物在名册里的键；默认小人为 null。 */
  readonly personId: string | null;
  readonly model: 'default' | 'imported';
}

/** 场景里的一个导入实例（F2：测试快照用，只读）。 */
export interface ImportedInstanceSnapshot {
  readonly slot: 'player' | 'guard' | 'companion';
  /** 守卫是关卡里的守卫 id，同伴是人物 id，主角是 null。 */
  readonly slotId: string | null;
  readonly personId: string;
  /** 实例克隆出来的模型根节点的 uuid。 */
  readonly rootUuid: string;
  /** 实例里所有骨骼节点的 uuid，按遍历顺序；没有骨骼时为空数组。 */
  readonly boneUuids: readonly string[];
  readonly animator: AnimatorSnapshot | null;
}

export interface CastSnapshot {
  readonly player: CastSlotSnapshot;
  /** 关卡里按顺序排列的守卫。 */
  readonly guards: readonly (CastSlotSnapshot & { readonly guardId: string })[];
  readonly companions: readonly CastSlotSnapshot[];
  readonly notices: readonly string[];
}
