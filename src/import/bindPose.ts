// 绑定姿态：由逆绑定矩阵（IBM）决定每根骨骼在绑定时的变换。
//
// glTF 的蒙皮矩阵是 K_j = 关节的全局变换 · IBM_j。导出工具对 IBM 的参照系有两种做法：
//   - 场景（模型根）空间：绑定姿态下 K_j = 单位矩阵（glTF 规范的本意；审查给出的合成文件就是这样）；
//   - 骨架父节点空间：绑定姿态下 K_j = 根骨骼父节点的变换 P（three 的 Skeleton.pose() 默认这样理解；
//     真实资产 armored-soldier 的 78 个关节在静止姿态下都满足 K_j = P，父节点带 −90° 旋转和 1.75 倍缩放）。
// 只用一种理解会把另一种文件算错（缩放或朝向不对），所以先看文件的静止姿态更符合哪一种：
// 静止姿态恰好是绑定姿态时，两者之一的偏差为 0；都不是时取偏差小的那种，相同时按 glTF 规范取场景空间。
// 然后按这种理解算出每根骨骼的绑定变换，普通（非骨骼）父节点的变换都正确补偿。

import { AnimationClip, Matrix4, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack, type Object3D, type SkinnedMesh } from 'three';

export type BindConvention = 'scene' | 'parent';

export interface BoneBind {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: Vector3;
}

export interface BindPose {
  readonly convention: BindConvention;
  /** 骨骼（按模板里的 UUID）在绑定姿态下的本地变换。 */
  readonly locals: ReadonlyMap<string, BoneBind>;
}

function isBone(obj: Object3D): boolean {
  return (obj as { isBone?: boolean }).isBone === true;
}

/** root 下所有蒙皮引用的骨骼和各自的 IBM（同一根骨骼被多个蒙皮引用时取第一个）。 */
function collectBones(root: Object3D): Map<Object3D, Matrix4> {
  const bones = new Map<Object3D, Matrix4>();
  root.traverse((obj) => {
    const mesh = obj as Partial<SkinnedMesh>;
    if (mesh.isSkinnedMesh !== true || !mesh.skeleton) return;
    mesh.skeleton.bones.forEach((bone, i) => {
      const inverse = mesh.skeleton?.boneInverses[i];
      if (inverse && !bones.has(bone)) bones.set(bone, inverse);
    });
  });
  return bones;
}

function frobenius(a: Matrix4, b: Matrix4): number {
  let sum = 0;
  for (let k = 0; k < 16; k++) sum += ((a.elements[k] ?? 0) - (b.elements[k] ?? 0)) ** 2;
  return Math.sqrt(sum);
}

/** 骨骼链最上面那根骨骼（父节点不是骨骼）。 */
function chainTop(bone: Object3D): Object3D {
  let top = bone;
  while (top.parent && isBone(top.parent)) top = top.parent;
  return top;
}

/** 由模板（静止姿态）计算绑定姿态。没有蒙皮时返回 null。 */
export function computeBindPose(root: Object3D): BindPose | null {
  const bones = collectBones(root);
  if (bones.size === 0) return null;
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const toModel = (obj: Object3D | null) => (obj ? new Matrix4().multiplyMatrices(rootInverse, obj.matrixWorld) : new Matrix4());

  // 判断 IBM 的参照系：静止姿态的蒙皮矩阵 K_j（模型空间）更接近单位矩阵，还是更接近根骨骼父节点的变换
  let sceneError = 0;
  let parentError = 0;
  const identity = new Matrix4();
  for (const [bone, inverse] of bones) {
    const k = toModel(bone).multiply(inverse);
    sceneError += frobenius(k, identity);
    parentError += frobenius(k, toModel(chainTop(bone).parent));
  }
  const convention: BindConvention = parentError < sceneError - 1e-9 ? 'parent' : 'scene';

  // 按先父后子算每个节点在绑定姿态下的模型空间变换：骨骼取 IBM 决定的变换，其他节点跟随父节点
  const chainFrame = new Map<Object3D, Matrix4>();
  const locals = new Map<string, BoneBind>();
  const visit = (node: Object3D, parentWorld: Matrix4) => {
    const inverse = bones.get(node);
    let world: Matrix4;
    if (inverse) {
      const parentIsBone = node.parent !== null && isBone(node.parent) && chainFrame.has(node.parent);
      // 骨骼链的参照系：场景空间时是单位矩阵；骨架父节点空间时是链顶骨骼的父节点在绑定姿态下的变换
      const frame = convention === 'scene' ? new Matrix4() : parentIsBone && node.parent ? (chainFrame.get(node.parent) ?? parentWorld) : parentWorld;
      chainFrame.set(node, frame);
      world = new Matrix4().copy(inverse).invert().premultiply(frame);
      const local = new Matrix4().copy(parentWorld).invert().multiply(world);
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      local.decompose(position, quaternion, scale);
      locals.set(node.uuid, { position, quaternion, scale });
    } else {
      node.updateMatrix();
      world = new Matrix4().multiplyMatrices(parentWorld, node.matrix);
      if (isBone(node) && node.parent && chainFrame.has(node.parent)) chainFrame.set(node, chainFrame.get(node.parent) ?? parentWorld);
    }
    for (const child of node.children) visit(child, world);
  };
  for (const child of root.children) visit(child, new Matrix4());
  return { convention, locals };
}

/** 同时遍历两棵结构相同的树（与 SkeletonUtils.clone 的对应方式一致）。 */
export function parallelTraverse(a: Object3D, b: Object3D, visit: (a: Object3D, b: Object3D) => void): void {
  visit(a, b);
  a.children.forEach((child, i) => {
    const other = b.children[i];
    if (other) parallelTraverse(child, other, visit);
  });
}

/** 把绑定姿态写到一棵与模板结构相同的树上（targetOf 把模板 UUID 映射到这棵树里的节点）。 */
export function applyBindPose(pose: BindPose, targetOf: (templateUuid: string) => Object3D | undefined): void {
  for (const [uuid, bind] of pose.locals) {
    const node = targetOf(uuid);
    if (!node) continue;
    node.position.copy(bind.position);
    node.quaternion.copy(bind.quaternion);
    node.scale.copy(bind.scale);
  }
}

/**
 * 绑定姿态的片段：每根骨骼的位置、旋转、缩放各一条轨道，保持绑定姿态的值（两个相同的关键帧，时长 1 秒，循环播放）。
 * 轨道按模板骨骼的 UUID 指定目标，实例用 clipFor 重定向；这样“绑定姿态”也能和其他片段一样淡入淡出。
 */
export function bindPoseClip(pose: BindPose): AnimationClip {
  const tracks = [...pose.locals].flatMap(([uuid, bind]) => [
    new VectorKeyframeTrack(`${uuid}.position`, [0, 1], [...bind.position.toArray(), ...bind.position.toArray()]),
    new QuaternionKeyframeTrack(`${uuid}.quaternion`, [0, 1], [...bind.quaternion.toArray(), ...bind.quaternion.toArray()]),
    new VectorKeyframeTrack(`${uuid}.scale`, [0, 1], [...bind.scale.toArray(), ...bind.scale.toArray()]),
  ]);
  return new AnimationClip('绑定姿态', 1, tracks);
}
