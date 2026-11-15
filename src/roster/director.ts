// 把分工的分配结果（cast.ts）落到场景里：主角、关卡里的守卫、同伴各自换成导入人物的实例或默认小人。
// 只换模型槽里的模型：守卫的数量和路线、主角和同伴的物理胶囊都不变。
// 每个位置一个独立的实例（ModelInstance：自己的骨骼和 AnimationMixer），主角兼守卫在两个位置上各有一个。
// 换下来的实例立即释放（计入同屏实例上限的名额也随之释放）。先释放再创建，避免中途超过上限。

import type { Bone, Object3D } from 'three';
import { CharacterView, HumanoidModel } from '../game/render/characterView';
import { GUARD_PALETTE, PLAYER_PALETTE, STAND_IN_PALETTE } from '../game/render/humanoid';
import type { CompanionState } from '../game/sim';
import { ImportedCharacterModel } from '../import/animator';
import { InstanceLimitError, type ImportedAsset, type InstanceRegistry } from '../import/asset';
import type { PlayerModelSnapshot } from '../import/ui/types';
import type { Cast } from './cast';
import type { CastSnapshot, ImportedInstanceSnapshot } from './types';

interface Slot {
  readonly id: string;
  readonly asset: ImportedAsset;
  readonly model: ImportedCharacterModel;
}

/** 同伴的位置：导入人物的实例，或者默认替身（asset 为 null）。 */
interface CompanionSlot {
  readonly id: string;
  readonly asset: ImportedAsset | null;
}

export interface CastViews {
  readonly player: CharacterView;
  /** 关卡里按顺序排列的守卫的视图。 */
  readonly guards: readonly CharacterView[];
  readonly guardIds: readonly string[];
  /** 同伴的外层节点加到这里。 */
  readonly parent: Object3D;
}

export class CastDirector {
  private playerSlot: Slot | null = null;
  private readonly guardSlots: (Slot | null)[];
  private readonly companions = new Map<string, { slot: CompanionSlot; view: CharacterView }>();
  private companionOrder: readonly string[] = [];
  private noticeList: readonly string[] = [];

  constructor(
    private readonly views: CastViews,
    private readonly registry: InstanceRegistry,
  ) {
    this.guardSlots = views.guards.map(() => null);
  }

  private keeps(slot: Slot | null, id: string | null, assetOf: (id: string) => ImportedAsset | null): boolean {
    return slot !== null && id !== null && slot.id === id && assetOf(id) === slot.asset && !slot.asset.isDisposed;
  }

  private create(asset: ImportedAsset, notices: string[]): ImportedCharacterModel | null {
    try {
      return new ImportedCharacterModel(asset.createInstance(this.registry));
    } catch (error) {
      if (error instanceof InstanceLimitError) {
        notices.push(error.message);
        return null;
      }
      throw error;
    }
  }

  /** 应用一次分配。返回实际出场的同伴（按顺序），交给模拟。 */
  apply(cast: Cast, assetOf: (id: string) => ImportedAsset | null): readonly string[] {
    const notices = [...cast.notices];

    // 1. 先释放要换掉的实例
    if (this.playerSlot && !this.keeps(this.playerSlot, cast.player, assetOf)) {
      this.views.player.setModel(new HumanoidModel(PLAYER_PALETTE));
      this.playerSlot = null;
    }
    this.guardSlots.forEach((slot, i) => {
      if (slot && !this.keeps(slot, cast.guards[i] ?? null, assetOf)) {
        this.views.guards[i]?.setModel(new HumanoidModel(GUARD_PALETTE));
        this.guardSlots[i] = null;
      }
    });
    const standIns = new Set(cast.standIns ?? []);
    for (const [id, companion] of [...this.companions]) {
      const slot = companion.slot;
      const stays = slot.asset === null ? standIns.has(id) : slot.id === id && assetOf(id) === slot.asset && !slot.asset.isDisposed;
      if (!cast.companions.includes(id) || !stays) {
        companion.view.root.removeFromParent();
        companion.view.currentModel.dispose();
        this.companions.delete(id);
      }
    }

    // 2. 再给新的位置创建实例
    const fill = (id: string | null, place: (model: ImportedCharacterModel) => void): Slot | null => {
      if (id === null) return null;
      const asset = assetOf(id);
      if (!asset) return null;
      const model = this.create(asset, notices);
      if (!model) return null;
      place(model);
      return { id, asset, model };
    };
    this.playerSlot ??= fill(cast.player, (model) => {
      this.views.player.setModel(model);
    });
    this.views.guards.forEach((view, i) => {
      this.guardSlots[i] ??= fill(cast.guards[i] ?? null, (model) => {
        view.setModel(model);
      });
    });
    for (const id of cast.companions) {
      if (this.companions.has(id)) continue;
      if (standIns.has(id)) {
        // 默认替身：程序化的低模小人，不占导入实例的名额
        const standIn = new CharacterView(`companion-${id}`, STAND_IN_PALETTE);
        this.views.parent.add(standIn.root);
        this.companions.set(id, { slot: { id, asset: null }, view: standIn });
        continue;
      }
      const view = new CharacterView(`companion-${id.slice(0, 8)}`, PLAYER_PALETTE);
      const slot = fill(id, (model) => {
        view.setModel(model);
      });
      if (!slot) {
        view.currentModel.dispose();
        continue;
      }
      this.views.parent.add(view.root);
      this.companions.set(id, { slot, view });
    }
    this.companionOrder = cast.companions.filter((id) => this.companions.has(id));
    this.noticeList = notices;
    return this.companionOrder;
  }

  /**
   * 释放所有位置上的导入实例（换关卡之前调用）：主角和守卫换回默认小人，同伴移除。
   * 守卫的视图随后由关卡视图一起释放；导入资产的几何和材质不在这里释放（由名册负责）。
   */
  releaseAll(): void {
    if (this.playerSlot) {
      this.views.player.setModel(new HumanoidModel(PLAYER_PALETTE));
      this.playerSlot = null;
    }
    this.guardSlots.forEach((slot, i) => {
      if (slot) this.views.guards[i]?.setModel(new HumanoidModel(GUARD_PALETTE));
      this.guardSlots[i] = null;
    });
    for (const companion of this.companions.values()) {
      companion.view.root.removeFromParent();
      companion.view.currentModel.dispose();
    }
    this.companions.clear();
    this.companionOrder = [];
  }

  /** 同伴的外层节点，按出场顺序（P6：测试快照里算屏幕上的包围框用，只读）。 */
  companionRoots(): Object3D[] {
    const out: Object3D[] = [];
    for (const id of this.companionOrder) {
      const view = this.companions.get(id)?.view;
      if (view) out.push(view.root);
    }
    return out;
  }

  /** 每帧：同伴的视图跟随模拟里的同伴（只读状态）。 */
  updateCompanions(companions: readonly CompanionState[], playing: boolean, dt: number, time: number): void {
    for (const c of companions) {
      this.companions.get(c.id)?.view.update(
        {
          position: c.body.position,
          facing: c.body.facing,
          horizontalSpeed: playing ? c.body.horizontalSpeed : 0,
          grounded: c.body.grounded,
          vy: c.body.vy,
        },
        dt,
        time,
      );
    }
  }

  get notices(): readonly string[] {
    return this.noticeList;
  }

  /** 当前主角用的人物（默认小人时为 null）。 */
  get playerId(): string | null {
    return this.playerSlot?.id ?? null;
  }

  playerSnapshot(): PlayerModelSnapshot {
    const slot = this.playerSlot;
    return {
      model: slot ? 'imported' : 'default',
      personId: slot?.id ?? null,
      assetId: slot?.asset.id ?? null,
      fileName: slot?.asset.fileName ?? null,
      animator: slot?.model.snapshot() ?? null,
    };
  }

  /**
   * 场景里每个导入实例（F2，测试快照用）：按主角 → 守卫 → 同伴的顺序。只读，不改实例。
   * 骨骼按 three 的遍历顺序（先序）列出。
   */
  importedInstances(): ImportedInstanceSnapshot[] {
    const describe = (slot: ImportedInstanceSnapshot['slot'], slotId: string | null, personId: string, model: ImportedCharacterModel): ImportedInstanceSnapshot => {
      const root = model.instance.object;
      const boneUuids: string[] = [];
      root.traverse((obj) => {
        if ((obj as Partial<Bone>).isBone === true) boneUuids.push(obj.uuid);
      });
      return { slot, slotId, personId, rootUuid: root.uuid, boneUuids, animator: model.snapshot() };
    };
    const out: ImportedInstanceSnapshot[] = [];
    if (this.playerSlot) out.push(describe('player', null, this.playerSlot.id, this.playerSlot.model));
    this.guardSlots.forEach((slot, i) => {
      if (slot) out.push(describe('guard', this.views.guardIds[i] ?? null, slot.id, slot.model));
    });
    for (const id of this.companionOrder) {
      const companion = this.companions.get(id);
      const model = companion?.view.currentModel;
      if (companion?.slot.asset && model instanceof ImportedCharacterModel) out.push(describe('companion', id, id, model));
    }
    return out;
  }

  snapshot(): CastSnapshot {
    const slotOf = (slot: Slot | null) => ({ personId: slot?.id ?? null, model: slot ? ('imported' as const) : ('default' as const) });
    const companionOf = (slot: CompanionSlot | null) =>
      slot?.asset ? { personId: slot.id, model: 'imported' as const } : { personId: null, model: 'default' as const };
    return {
      player: slotOf(this.playerSlot),
      guards: this.views.guardIds.map((guardId, i) => ({ guardId, ...slotOf(this.guardSlots[i] ?? null) })),
      companions: this.companionOrder.map((id) => companionOf(this.companions.get(id)?.slot ?? null)),
      notices: [...this.noticeList],
    };
  }
}
