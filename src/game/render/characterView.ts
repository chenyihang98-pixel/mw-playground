// 角色的视觉表现：外层节点跟随物理胶囊（脚底位置和朝向），视觉模型挂在外层节点下的模型槽里。
// 视觉模型和物理胶囊完全分开：这里只读模拟状态，不影响模拟。P3 导入的模型会替换模型槽里的内容。

import { Group } from 'three';
import { applyPose, buildHumanoid, type HumanoidPalette, type HumanoidRig } from './humanoid';
import { computePose, gaitPhaseRate, type Pose } from './pose';

export interface CharacterMotion {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly facing: number;
  readonly horizontalSpeed: number;
  readonly grounded: boolean;
  readonly vy: number;
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

export class CharacterView {
  /** 外层节点：位置 = 物理胶囊的脚底中心，rotation.y = 朝向。 */
  readonly root: Group;
  /** 模型槽：视觉模型挂在这里。 */
  readonly modelSlot: Group;
  private readonly rig: HumanoidRig;
  private gaitPhase = 0;
  private pose: Pose | null = null;

  constructor(name: string, palette: HumanoidPalette) {
    this.root = new Group();
    this.root.name = `${name}-root`;
    this.modelSlot = new Group();
    this.modelSlot.name = 'model-slot';
    this.root.add(this.modelSlot);
    this.rig = buildHumanoid(palette);
    this.modelSlot.add(this.rig.root);
  }

  update(motion: CharacterMotion, dt: number, time: number): void {
    this.root.position.set(motion.position.x, motion.position.y, motion.position.z);
    this.root.rotation.y = motion.facing;
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
}
