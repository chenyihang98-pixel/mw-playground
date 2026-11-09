// 归一化：都作用在外层节点上，不改模型内部的节点和动画。
// - 显示身高（默认 1.75 m，1.2–2.4 m 可调），只影响显示；玩法胶囊不变。
// - 最低点贴地，水平方向居中到胶囊中心（外层节点原点）。
// - 默认把 +Z 当作正前方；可以每次转 90°。
// - 包围盒按加载后的场景计算，计入已经生效的 morph 权重；带骨骼的模型按绑定姿态算（用 three 的 Skeleton.pose()
//   由逆绑定矩阵恢复，不是文件里骨骼的初始姿态）；实例化网格把每个 instanceMatrix 都算进去。

import { Box3, Matrix4, Mesh, Vector3, type InstancedMesh, type Object3D, type Skeleton, type SkinnedMesh } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { DISPLAY } from './limits';

export interface NormalizeSettings {
  /** 显示身高（米），限制在 DISPLAY.minHeight–maxHeight。 */
  readonly displayHeight: number;
  /** 绕 Y 轴转了几个 90°（0–3）。 */
  readonly quarterTurns: number;
}

export const DEFAULT_NORMALIZE: NormalizeSettings = { displayHeight: DISPLAY.defaultHeight, quarterTurns: 0 };

export function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return DISPLAY.defaultHeight;
  return Math.min(DISPLAY.maxHeight, Math.max(DISPLAY.minHeight, height));
}

function isMesh(obj: Object3D): obj is Mesh {
  return (obj as Partial<Mesh>).isMesh === true;
}

function isSkinned(mesh: Mesh): mesh is SkinnedMesh {
  return (
    (mesh as Partial<SkinnedMesh>).isSkinnedMesh === true &&
    mesh.geometry.hasAttribute('skinIndex') &&
    mesh.geometry.hasAttribute('skinWeight')
  );
}

function isInstanced(mesh: Mesh): mesh is InstancedMesh {
  return (mesh as Partial<InstancedMesh>).isInstancedMesh === true;
}

/** 顶点位置，计入已经生效的 morph 权重，不做蒙皮（Mesh 本身的 getVertexPosition）。 */
function morphedPosition(mesh: Mesh, index: number, target: Vector3): Vector3 {
  return Mesh.prototype.getVertexPosition.call(mesh, index, target);
}

/** 收集 root 下所有网格顶点在 root 本地空间里的位置（每个点交给 visit）。 */
function eachVertex(root: Object3D, skinned: (mesh: SkinnedMesh, toRoot: Matrix4, i: number, v: Vector3) => Vector3, visit: (p: Vector3) => void): void {
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const toRoot = new Matrix4();
  const instanceMatrix = new Matrix4();
  const perInstance = new Matrix4();
  const v = new Vector3();
  root.traverse((obj) => {
    if (!isMesh(obj) || !obj.visible || !obj.geometry.hasAttribute('position')) return;
    const count = obj.geometry.getAttribute('position').count;
    toRoot.multiplyMatrices(rootInverse, obj.matrixWorld);
    if (isSkinned(obj)) {
      for (let i = 0; i < count; i++) visit(skinned(obj, toRoot, i, v));
    } else if (isInstanced(obj)) {
      for (let j = 0; j < obj.count; j++) {
        obj.getMatrixAt(j, instanceMatrix);
        perInstance.multiplyMatrices(toRoot, instanceMatrix);
        for (let i = 0; i < count; i++) visit(morphedPosition(obj, i, v).applyMatrix4(perInstance));
      }
    } else {
      for (let i = 0; i < count; i++) visit(morphedPosition(obj, i, v).applyMatrix4(toRoot));
    }
  });
}

function boxOf(fill: (visit: (p: Vector3) => void) => void): Box3 | null {
  const box = new Box3();
  fill((p) => {
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) box.expandByPoint(p);
  });
  return box.isEmpty() ? null : box;
}

/** 当前姿态下实际显示的顶点（three 的 getVertexPosition：morph + 当前骨骼的蒙皮）在 root 本地空间里的包围盒。 */
export function renderedBounds(root: Object3D): Box3 | null {
  return boxOf((visit) => {
    eachVertex(root, (mesh, toRoot, i, v) => mesh.getVertexPosition(i, v).applyMatrix4(toRoot), visit);
  });
}

function skeletonsIn(root: Object3D): Set<Skeleton> {
  const skeletons = new Set<Skeleton>();
  root.traverse((obj) => {
    const mesh = obj as Partial<SkinnedMesh>;
    if (mesh.isSkinnedMesh === true && mesh.skeleton) skeletons.add(mesh.skeleton);
  });
  return skeletons;
}

/**
 * 把 root 下所有蒙皮的骨骼摆成绑定姿态。用 three 自己的约定（Skeleton.pose()）：
 * 由逆绑定矩阵恢复骨骼的绑定变换，根骨骼相对它的父节点。只改骨骼的本地变换，不改其他节点。
 */
export function poseBindPose(root: Object3D): void {
  root.updateMatrixWorld(true);
  for (const skeleton of skeletonsIn(root)) skeleton.pose();
  root.updateMatrixWorld(true);
}

/**
 * 绑定姿态下、模型空间（root 的本地空间）里的包围盒。
 * 带骨骼的模型：在临时克隆上用 Skeleton.pose() 恢复绑定姿态（由逆绑定矩阵决定，不是文件里骨骼的初始姿态），
 * 再按 three 实际的显示（morph + 蒙皮，含 bindMatrix / bindMatrixInverse 语义）逐个顶点计算；原模型的节点和动画不动。
 * 不带骨骼的模型直接按当前（加载后的）场景计算，计入 morph 权重和实例化网格的每个实例。
 */
export function bindPoseBounds(root: Object3D): Box3 | null {
  if (skeletonsIn(root).size === 0) return renderedBounds(root);
  const temporary = cloneSkinned(root);
  try {
    poseBindPose(temporary);
    return renderedBounds(temporary);
  } finally {
    for (const skeleton of skeletonsIn(temporary)) skeleton.dispose();
  }
}

export interface NormalizedSize {
  readonly scale: number;
  /** 归一化之后（外层节点空间）的尺寸，米。width 沿 X，depth 沿 Z。 */
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

/** 把归一化写到外层节点上（缩放、绕 Y 旋转、平移），返回归一化之后的尺寸。 */
export function applyNormalization(outer: Object3D, bounds: Box3, settings: NormalizeSettings): NormalizedSize {
  const turns = ((Math.round(settings.quarterTurns) % 4) + 4) % 4;
  const yaw = (turns * Math.PI) / 2;
  const modelHeight = bounds.max.y - bounds.min.y;
  const scale = modelHeight > 1e-9 ? clampHeight(settings.displayHeight) / modelHeight : 1;
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  // 旋转后的水平中心：R_y(yaw)·(x, z)
  const rx = cx * Math.cos(yaw) + cz * Math.sin(yaw);
  const rz = -cx * Math.sin(yaw) + cz * Math.cos(yaw);
  outer.scale.setScalar(scale);
  outer.rotation.set(0, yaw, 0);
  outer.position.set(-scale * rx, -scale * bounds.min.y, -scale * rz);
  outer.updateMatrix();
  const sizeX = (bounds.max.x - bounds.min.x) * scale;
  const sizeZ = (bounds.max.z - bounds.min.z) * scale;
  return {
    scale,
    width: turns % 2 === 0 ? sizeX : sizeZ,
    height: modelHeight * scale,
    depth: turns % 2 === 0 ? sizeZ : sizeX,
  };
}

/** 模型空间的包围盒经过外层节点变换后的包围盒（转 90° 的倍数时是精确的）。 */
export function normalizedBox(bounds: Box3, outer: Object3D): Box3 {
  outer.updateMatrix();
  return bounds.clone().applyMatrix4(outer.matrix);
}
