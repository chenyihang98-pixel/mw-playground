// 用基本几何体拼的低模小人。身高与物理胶囊高度一致（SPEC.capsule.height），脚底在原点，面向 +Z。
// 结构：外层节点（物理位置、朝向）→ 模型槽 → 小人。P3 导入的模型挂在同一个模型槽里。

import { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SPEC } from '../spec';
import type { Pose } from './pose';

export interface HumanoidPalette {
  readonly skin: number;
  readonly shirt: number;
  readonly pants: number;
  readonly shoes: number;
  readonly accent: number;
}

// P6 整理过的配色：主角蓝衣金帽，守卫红衣深色头盔，和界面的主色、强调色、语义色一致。
export const PLAYER_PALETTE: HumanoidPalette = { skin: 0xf2c9a3, shirt: 0x3d8bff, pants: 0x2c3a58, shoes: 0x2a2a30, accent: 0xffc845 };
export const GUARD_PALETTE: HumanoidPalette = { skin: 0xd8a27c, shirt: 0xd8443c, pants: 0x23262e, shoes: 0x141418, accent: 0x2b2f38 };
/** 默认替身（P5：关卡列出的同伴已不在名册里时用）。 */
export const STAND_IN_PALETTE: HumanoidPalette = { skin: 0xe0b896, shirt: 0x7a8a99, pants: 0x3c4450, shoes: 0x2a2a2a, accent: 0xb0bec5 };

/** 设计身高：下面的尺寸按 1.75 m 设计，最后整体缩放到胶囊高度。 */
const DESIGN_HEIGHT = 1.75;

export interface HumanoidRig {
  readonly root: Group;
  readonly body: Object3D;
  readonly torso: Object3D;
  readonly hipL: Object3D;
  readonly hipR: Object3D;
  readonly kneeL: Object3D;
  readonly kneeR: Object3D;
  readonly shoulderL: Object3D;
  readonly shoulderR: Object3D;
  readonly elbowL: Object3D;
  readonly elbowR: Object3D;
}

/** 圆角方块（尺寸和以前的方块完全相同，只把棱角磨圆），投下阴影。 */
function box(w: number, h: number, d: number, color: number, y: number, z = 0, x = 0): Mesh {
  const radius = Math.min(w, h, d) * 0.28;
  const mesh = new Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), new MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02 }));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function pivot(name: string, x: number, y: number, z = 0): Group {
  const g = new Group();
  g.name = name;
  g.position.set(x, y, z);
  return g;
}

function leg(side: 1 | -1, p: HumanoidPalette): { hip: Group; knee: Group } {
  const hip = pivot(side > 0 ? 'hip-l' : 'hip-r', 0.1 * side, 0.9);
  hip.add(box(0.15, 0.45, 0.16, p.pants, -0.225));
  const knee = pivot(side > 0 ? 'knee-l' : 'knee-r', 0, -0.45);
  knee.add(box(0.13, 0.4, 0.14, p.pants, -0.2));
  knee.add(box(0.14, 0.05, 0.24, p.shoes, -0.425, 0.04));
  hip.add(knee);
  return { hip, knee };
}

function arm(side: 1 | -1, p: HumanoidPalette): { shoulder: Group; elbow: Group } {
  const shoulder = pivot(side > 0 ? 'shoulder-l' : 'shoulder-r', 0.27 * side, 0.47);
  shoulder.add(box(0.1, 0.3, 0.11, p.shirt, -0.15));
  const elbow = pivot(side > 0 ? 'elbow-l' : 'elbow-r', 0, -0.3);
  elbow.add(box(0.09, 0.26, 0.1, p.skin, -0.13));
  shoulder.add(elbow);
  return { shoulder, elbow };
}

/** 拼一个小人。返回的 root 脚底在原点、面向 +Z，高度等于 SPEC.capsule.height。 */
export function buildHumanoid(palette: HumanoidPalette): HumanoidRig {
  const root = new Group();
  root.name = 'humanoid';
  const body = pivot('body', 0, 0);
  root.add(body);

  const left = leg(1, palette);
  const right = leg(-1, palette);
  body.add(left.hip, right.hip);
  body.add(box(0.36, 0.14, 0.2, palette.pants, 0.93));

  // 躯干绕腰部（y = 0.95）转动
  const torso = pivot('torso', 0, 0.95);
  torso.add(box(0.42, 0.52, 0.23, palette.shirt, 0.26));
  torso.add(box(0.44, 0.06, 0.24, palette.accent, 0.03)); // 腰带
  const neck = pivot('neck', 0, 0.52);
  neck.add(box(0.1, 0.05, 0.1, palette.skin, 0.015));
  neck.add(box(0.24, 0.24, 0.24, palette.skin, 0.155)); // 头：0.95 + 0.52 + 0.035 … 0.275
  neck.add(box(0.045, 0.05, 0.04, palette.skin, 0.13, 0.13)); // 鼻子：标出 +Z 朝向
  for (const side of [-1, 1]) neck.add(box(0.04, 0.045, 0.02, 0x1b1f27, 0.175, 0.118, 0.055 * side)); // 眼睛
  neck.add(box(0.26, 0.04, 0.26, palette.accent, 0.26)); // 帽子，顶面在 0.95 + 0.52 + 0.28 = 1.75
  neck.add(box(0.2, 0.025, 0.08, palette.accent, 0.245, 0.15)); // 帽檐，朝 +Z
  torso.add(neck);
  const leftArm = arm(1, palette);
  const rightArm = arm(-1, palette);
  torso.add(leftArm.shoulder, rightArm.shoulder);
  body.add(torso);

  root.scale.setScalar(SPEC.capsule.height / DESIGN_HEIGHT);
  return {
    root,
    body,
    torso,
    hipL: left.hip,
    hipR: right.hip,
    kneeL: left.knee,
    kneeR: right.knee,
    shoulderL: leftArm.shoulder,
    shoulderR: rightArm.shoulder,
    elbowL: leftArm.elbow,
    elbowR: rightArm.elbow,
  };
}

export function applyPose(rig: HumanoidRig, pose: Pose): void {
  rig.hipL.rotation.x = pose.hipL;
  rig.hipR.rotation.x = pose.hipR;
  rig.kneeL.rotation.x = pose.kneeL;
  rig.kneeR.rotation.x = pose.kneeR;
  rig.shoulderL.rotation.set(pose.shoulderL, 0, pose.armSpread);
  rig.shoulderR.rotation.set(pose.shoulderR, 0, -pose.armSpread);
  rig.elbowL.rotation.x = pose.elbowL;
  rig.elbowR.rotation.x = pose.elbowR;
  rig.torso.rotation.x = pose.lean;
  rig.body.position.y = pose.bob;
}
