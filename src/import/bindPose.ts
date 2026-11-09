// 绑定姿态：由逆绑定矩阵（IBM）决定每根骨骼在绑定时的变换。只看文件的静态结构，不看动作。
//
// three 显示蒙皮网格的方式与 glTF 规范一致（GLTFLoader 以单位矩阵绑定，attached 模式抵消网格节点自己的变换）：
// 显示的顶点 = Σ w_j · K_j · v，K_j = 关节的全局变换 · IBM_j。
//   - 场景空间（glTF 规范，默认）：绑定姿态下 K_j = 单位矩阵，网格按原始顶点显示。
//   - 网格节点空间（兼容的特殊导出约定）：整个模型（蒙皮网格和骨架）被一起放进带变换的节点里，IBM 却没有跟着更新，
//     绑定姿态下 K_j = 蒙皮网格节点的全局变换 M。真实资产 armored-soldier 就是这样：导出工具在原模型外面套了
//     −90° 旋转和 1.75 倍缩放两层节点，蒙皮网格和根骨骼都在里面，78 个关节的静止姿态都正好满足 K_j = M。
// 只有同时满足下面几条才按网格节点空间理解，否则一律按 glTF 规范的场景空间：
//   1. 所有蒙皮网格节点的全局变换相同（M），M 不是单位矩阵、可逆，网格节点的父链里没有骨骼；
//   2. 每条骨骼链所在的普通父节点的全局变换也等于 M（网格和骨架在同一个空间里）；
//   3. 文件里每个关节的静止姿态都正好是这种理解下的绑定姿态（K_j = M，在数值误差内）。
// 判断与片段无关：增加、删除或修改动作都不会改变对同一套 IBM 的理解。
// 然后按选定的理解算出每根骨骼的绑定本地变换（普通父节点的变换正确补偿）。

import { AnimationClip, Matrix4, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack, type Object3D, type SkinnedMesh } from 'three';

export type BindConvention = 'scene' | 'mesh';

export interface BoneBind {
  /** 轨道里指定这根骨骼用的名字：与 GLTFLoader 相同，有名字用名字，没有名字用（模板里的）UUID。 */
  readonly target: string;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: Vector3;
}

export interface BindPose {
  readonly convention: BindConvention;
  /** 骨骼（按模板里的 UUID）在绑定姿态下的本地变换。 */
  readonly locals: ReadonlyMap<string, BoneBind>;
}

/** 判断“静止姿态正好是绑定姿态”的容差（线性部分无单位，平移部分除以模型的特征长度）。 */
const EXACT_TOLERANCE = 1e-3;

function isBone(obj: Object3D): boolean {
  return (obj as { isBone?: boolean }).isBone === true;
}

function isSkinnedMesh(obj: Object3D): obj is SkinnedMesh {
  const mesh = obj as Partial<SkinnedMesh>;
  return mesh.isSkinnedMesh === true && mesh.skeleton !== undefined;
}

/** root 下所有蒙皮引用的骨骼和各自的 IBM（同一根骨骼被多个蒙皮引用时取第一个）。 */
function collectBones(root: Object3D): Map<Object3D, Matrix4> {
  const bones = new Map<Object3D, Matrix4>();
  root.traverse((obj) => {
    if (!isSkinnedMesh(obj)) return;
    obj.skeleton.bones.forEach((bone, i) => {
      const inverse = obj.skeleton.boneInverses[i];
      if (inverse && !bones.has(bone)) bones.set(bone, inverse);
    });
  });
  return bones;
}

/** 骨骼链所在的普通父节点：蒙皮骨骼（以及夹在链中间的非蒙皮骨骼）→ 链顶骨骼的父节点。 */
function chainOwners(root: Object3D, bones: ReadonlyMap<Object3D, Matrix4>): Map<Object3D, Object3D> {
  const owners = new Map<Object3D, Object3D>();
  root.traverse((node) => {
    const parent = node.parent;
    if (node === root || !parent) return;
    const inherited = isBone(parent) ? owners.get(parent) : undefined;
    if (bones.has(node)) owners.set(node, inherited ?? parent);
    else if (isBone(node) && inherited) owners.set(node, inherited);
  });
  return owners;
}

/** 每个节点在模型空间（root 的本地空间）里的变换，按节点自己的位置、旋转、缩放计算（不改节点）。 */
function modelWorlds(root: Object3D): Map<Object3D, Matrix4> {
  const worlds = new Map<Object3D, Matrix4>([[root, new Matrix4()]]);
  const visit = (node: Object3D, parentWorld: Matrix4) => {
    const world = new Matrix4().compose(node.position, node.quaternion, node.scale).premultiply(parentWorld);
    worlds.set(node, world);
    for (const child of node.children) visit(child, world);
  };
  for (const child of root.children) visit(child, new Matrix4());
  return worlds;
}

/** 两个仿射矩阵的差：线性部分直接比，平移部分除以模型的特征长度（与模型的单位无关）。 */
function distance(a: Matrix4, b: Matrix4, length: number): number {
  let sum = 0;
  for (let k = 0; k < 16; k++) {
    const d = (a.elements[k] ?? 0) - (b.elements[k] ?? 0);
    sum += k >= 12 && k <= 14 ? (d / length) ** 2 : d ** 2;
  }
  return Math.sqrt(sum);
}

/** 模型的特征长度：静止姿态下所有蒙皮骨骼原点的包围盒对角线（只有一个点时取 1）。 */
function characteristicLength(bones: ReadonlyMap<Object3D, Matrix4>, worlds: ReadonlyMap<Object3D, Matrix4>): number {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const p = new Vector3();
  for (const bone of bones.keys()) {
    const world = worlds.get(bone);
    if (!world) continue;
    p.setFromMatrixPosition(world);
    min.min(p);
    max.max(p);
  }
  const diagonal = max.distanceTo(min);
  return Number.isFinite(diagonal) && diagonal > 1e-6 ? diagonal : 1;
}

/** 所有蒙皮网格节点共同的全局变换；节点之间不同，或父链里有骨骼（变换会随动作变化）时返回 null。 */
function sharedMeshWorld(root: Object3D, worlds: ReadonlyMap<Object3D, Matrix4>, length: number): Matrix4 | null {
  const meshes: SkinnedMesh[] = [];
  root.traverse((obj) => {
    if (isSkinnedMesh(obj)) meshes.push(obj);
  });
  let shared: Matrix4 | null = null;
  for (const mesh of meshes) {
    for (let node = mesh.parent; node && node !== root; node = node.parent) {
      if (isBone(node)) return null;
    }
    const world = worlds.get(mesh);
    if (!world) return null;
    if (!shared) shared = world;
    else if (distance(world, shared, length) > EXACT_TOLERANCE) return null;
  }
  return shared;
}

/** 按文件的静态结构判断 IBM 的参照系（规则见文件开头）。 */
function decideConvention(root: Object3D, bones: ReadonlyMap<Object3D, Matrix4>, owners: ReadonlyMap<Object3D, Object3D>): { convention: BindConvention; frame: Matrix4 } {
  const scene = { convention: 'scene' as const, frame: new Matrix4() };
  const rest = modelWorlds(root);
  const length = characteristicLength(bones, rest);
  const meshWorld = sharedMeshWorld(root, rest, length);
  if (!meshWorld) return scene;
  const det = meshWorld.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return scene;
  if (distance(meshWorld, new Matrix4(), length) <= EXACT_TOLERANCE) return scene;
  const k = new Matrix4();
  for (const [bone, inverse] of bones) {
    const owner = owners.get(bone);
    const ownerWorld = owner ? rest.get(owner) : undefined;
    if (!ownerWorld || distance(ownerWorld, meshWorld, length) > EXACT_TOLERANCE) return scene;
    const world = rest.get(bone);
    if (!world) return scene;
    k.multiplyMatrices(world, inverse);
    if (distance(k, meshWorld, length) > EXACT_TOLERANCE) return scene;
  }
  return { convention: 'mesh', frame: meshWorld };
}

/** 轨道里指定这个节点用的名字：与 GLTFLoader 相同（有名字用名字，没有用 UUID）；名字不能唯一找到这个节点时用 UUID。 */
function trackTarget(root: Object3D, node: Object3D): string {
  const name = node.name;
  if (name !== '' && PropertyBinding.sanitizeNodeName(name) === name && PropertyBinding.findNode(root, name) === node) return name;
  return node.uuid;
}

/** 由模板计算绑定姿态（参照系的判断见文件开头）。没有蒙皮时返回 null。模板不会被修改。 */
export function computeBindPose(root: Object3D): BindPose | null {
  const bones = collectBones(root);
  if (bones.size === 0) return null;
  const owners = chainOwners(root, bones);
  const { convention, frame } = decideConvention(root, bones, owners);

  // 按先父后子算每个节点在绑定姿态下的模型空间变换：骨骼取 frame · IBM⁻¹，其他节点跟随父节点
  const locals = new Map<string, BoneBind>();
  const visit = (node: Object3D, parentWorld: Matrix4) => {
    const inverse = bones.get(node);
    let world: Matrix4;
    if (inverse) {
      world = new Matrix4().copy(inverse).invert().premultiply(frame);
      const local = new Matrix4().copy(parentWorld).invert().multiply(world);
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      local.decompose(position, quaternion, scale);
      locals.set(node.uuid, { target: trackTarget(root, node), position, quaternion, scale });
    } else {
      world = new Matrix4().compose(node.position, node.quaternion, node.scale).premultiply(parentWorld);
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
 * 轨道路径和文件里的片段一致（有名字的骨骼用名字，无名骨骼用模板 UUID，实例上由 clipFor 换成克隆骨骼的 UUID）：
 * three 按轨道路径给每个属性建一份混合状态，路径相同，“绑定姿态”和其他动作才能在同一份状态里淡入淡出。
 */
export function bindPoseClip(pose: BindPose): AnimationClip {
  const tracks = [...pose.locals.values()].flatMap((bind) => [
    new VectorKeyframeTrack(`${bind.target}.position`, [0, 1], [...bind.position.toArray(), ...bind.position.toArray()]),
    new QuaternionKeyframeTrack(`${bind.target}.quaternion`, [0, 1], [...bind.quaternion.toArray(), ...bind.quaternion.toArray()]),
    new VectorKeyframeTrack(`${bind.target}.scale`, [0, 1], [...bind.scale.toArray(), ...bind.scale.toArray()]),
  ]);
  return new AnimationClip('绑定姿态', 1, tracks);
}
