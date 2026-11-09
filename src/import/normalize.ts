// 归一化：都作用在外层节点上，不改模型内部的节点和动画。
// - 显示身高（默认 1.75 m，1.2–2.4 m 可调），只影响显示；玩法胶囊不变。
// - 最低点贴地，水平方向居中到胶囊中心（外层节点原点）。
// - 默认把 +Z 当作正前方；可以每次转 90°。
// - 包围盒按加载后的场景计算；带骨骼的模型按绑定姿态算（忽略骨骼当前的姿态）。

import { Box3, Matrix4, Vector3, type Mesh, type Object3D } from 'three';
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

/**
 * 模型空间（root 的本地空间）里的包围盒。逐个顶点按网格的静态世界变换计算；
 * 蒙皮网格不应用骨骼变换，得到的就是绑定姿态下的位置（绑定姿态时骨骼矩阵 × 逆绑定矩阵 = 单位矩阵）。
 */
export function bindPoseBounds(root: Object3D): Box3 | null {
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const box = new Box3();
  const toModel = new Matrix4();
  const v = new Vector3();
  root.traverse((obj) => {
    if (!isMesh(obj) || !obj.visible) return;
    if (!obj.geometry.hasAttribute('position')) return;
    const position = obj.geometry.getAttribute('position');
    toModel.multiplyMatrices(rootInverse, obj.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toModel);
      if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
        box.expandByPoint(v);
      }
    }
  });
  return box.isEmpty() ? null : box;
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
