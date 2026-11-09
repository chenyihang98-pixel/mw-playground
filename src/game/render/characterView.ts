// 角色的视觉表现：外层节点跟随物理胶囊（脚底位置和朝向），视觉模型挂在外层节点下的模型槽里。
// 视觉模型和物理胶囊完全分开：这里只读模拟状态，不影响模拟。
// 模型槽里的模型可以替换：默认是程序化动画的低模小人（HumanoidModel），P3 导入的模型（ImportedCharacterModel）挂同一个位置。

import { Group, type Object3D } from 'three';
import { applyPose, buildHumanoid, type HumanoidPalette, type HumanoidRig } from './humanoid';
import { computePose, gaitPhaseRate, type Pose } from './pose';

export interface CharacterMotion {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly facing: number;
  readonly horizontalSpeed: number;
  readonly grounded: boolean;
  readonly vy: number;
}

/** 挂在模型槽里的视觉模型。脚底在原点、面向 +Z。 */
export interface CharacterModel {
  readonly object: Object3D;
  update(motion: CharacterMotion, dt: number, time: number): void;
  dispose(): void;
}

const POSE_KEYS = [
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
  'shoulderL',
  'shoulderR',
  'elbowL',
  'elbowR',
  'lean',
  'bob',
  'armSpread',
] as const satisfies readonly (keyof Pose)[];

/** 默认的低模小人：程序化的待机、走、跑、跳姿态。 */
export class HumanoidModel implements CharacterModel {
  readonly object: Object3D;
  private readonly rig: HumanoidRig;
  private gaitPhase = 0;
  private pose: Pose | null = null;

  constructor(palette: HumanoidPalette) {
    this.rig = buildHumanoid(palette);
    this.object = this.rig.root;
  }

  update(motion: CharacterMotion, dt: number, time: number): void {
    this.gaitPhase = (this.gaitPhase + motion.horizontalSpeed * dt * gaitPhaseRate(motion.horizontalSpeed)) % (Math.PI * 2);
    const target = computePose({
      speed: motion.horizontalSpeed,
      grounded: motion.grounded,
      vy: motion.vy,
      gaitPhase: this.gaitPhase,
      time,
    });
    // 平滑过渡到目标姿态，避免切换步态时跳变
    const blend = this.pose === null ? 1 : 1 - Math.exp(-dt * 14);
    const previous = this.pose ?? target;
    const next = { ...target };
    for (const key of POSE_KEYS) next[key] = previous[key] + (target[key] - previous[key]) * blend;
    this.pose = next;
    applyPose(this.rig, next);
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}

export class CharacterView {
  /** 外层节点：位置 = 物理胶囊的脚底中心，rotation.y = 朝向。 */
  readonly root: Group;
  /** 模型槽：视觉模型挂在这里。 */
  readonly modelSlot: Group;
  private model: CharacterModel;

  constructor(name: string, palette: HumanoidPalette) {
    this.root = new Group();
    this.root.name = `${name}-root`;
    this.modelSlot = new Group();
    this.modelSlot.name = 'model-slot';
    this.root.add(this.modelSlot);
    this.model = new HumanoidModel(palette);
    this.modelSlot.add(this.model.object);
  }

  get currentModel(): CharacterModel {
    return this.model;
  }

  /** 换模型：旧模型从模型槽移除并释放，新模型挂到模型槽里。外层节点和物理胶囊不变。 */
  setModel(model: CharacterModel): void {
    if (model === this.model) return;
    this.model.object.removeFromParent();
    this.model.dispose();
    this.model = model;
    this.modelSlot.add(model.object);
  }

  update(motion: CharacterMotion, dt: number, time: number): void {
    this.root.position.set(motion.position.x, motion.position.y, motion.position.z);
    this.root.rotation.y = motion.facing;
    this.model.update(motion, dt, time);
  }
}
