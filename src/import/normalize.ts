// 归一化：都作用在外层节点上，不改模型内部的节点和动画。
// - 显示身高（默认 1.75 m，1.2–2.4 m 可调），只影响显示；玩法胶囊不变。
// - 最低点贴地，水平方向居中到胶囊中心（外层节点原点）。
// - 默认把 +Z 当作正前方；可以每次转 90°。
// - 包围盒按加载后的场景计算；带骨骼的模型按绑定姿态算：导入时（播放任何动画之前）骨骼处于文件里的静止变换，
//   用 three 自己的蒙皮计算（SkinnedMesh.applyBoneTransform，含 bindMatrix / bindMatrixInverse 语义）得到实际的顶点位置；
//   实例化网格（InstancedMesh）把每个实例的 instanceMatrix 都算进去。

import { Box3, Matrix4, Vector3, type InstancedMesh, type Mesh, type Object3D, type SkinnedMesh } from 'three';
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

/**
 * root 的本地空间里，模型当前姿态下实际显示的顶点的包围盒（逐个顶点计算）。
 * 导入时调用：骨骼处于文件里的静止变换（绑定姿态），所以得到的是绑定姿态的包围盒。
 */
export function renderedBounds(root: Object3D): Box3 | null {
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const box = new Box3();
  const toRoot = new Matrix4();
  const instanceMatrix = new Matrix4();
  const perInstance = new Matrix4();
  const v = new Vector3();
  const add = (point: Vector3) => {
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) box.expandByPoint(point);
  };
  root.traverse((obj) => {
    if (!isMesh(obj) || !obj.visible || !obj.geometry.hasAttribute('position')) return;
    const position = obj.geometry.getAttribute('position');
    toRoot.multiplyMatrices(rootInverse, obj.matrixWorld);
    if (isSkinned(obj)) {
      // 蒙皮：applyBoneTransform 返回网格本地坐标（已按 bindMatrix / bindMatrixInverse 处理），再乘网格的世界矩阵
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i);
        obj.applyBoneTransform(i, v);
        add(v.applyMatrix4(toRoot));
      }
    } else if (isInstanced(obj)) {
      for (let j = 0; j < obj.count; j++) {
        obj.getMatrixAt(j, instanceMatrix);
        perInstance.multiplyMatrices(toRoot, instanceMatrix);
        for (let i = 0; i < position.count; i++) add(v.fromBufferAttribute(position, i).applyMatrix4(perInstance));
      }
    } else {
      for (let i = 0; i < position.count; i++) add(v.fromBufferAttribute(position, i).applyMatrix4(toRoot));
    }
  });
  return box.isEmpty() ? null : box;
}

/** 导入时的绑定姿态包围盒（模型空间）。模板场景从不播放动画，所以这就是绑定姿态。 */
export const bindPoseBounds = renderedBounds;

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
