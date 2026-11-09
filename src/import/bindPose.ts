// 绑定姿态：由逆绑定矩阵（IBM）决定每根骨骼在绑定时的变换。
//
// glTF 的蒙皮矩阵是 K_j = 关节的全局变换 · IBM_j。导出工具对 IBM 的参照系有两种做法：
//   - 场景（模型根）空间：绑定姿态下 K_j = 单位矩阵（glTF 规范的本意）；
//   - 骨架父节点空间：绑定姿态下 K_j = 骨骼链所在的普通父节点的变换 P（three 的 Skeleton.pose() 默认这样理解；
//     真实资产 armored-soldier 的 78 个关节都满足这一点，父节点带 −90° 旋转和 1.75 倍缩放）。
// 两种理解只在“骨骼链挂在带变换的普通父节点下”时不同。只用一种会把另一种文件算错（缩放或朝向不对）。
//
// 判断依据是文件自己的动作：游戏里显示的是片段播放出来的姿态，绑定姿态（卡片尺寸、“绑定姿态”兜底）要和它们一致。
// 在每个动到蒙皮骨骼（或其父节点）的片段的起点和中点取样，算出各关节的蒙皮矩阵，看它们整体更接近哪一种绑定姿态
// （动作是在绑定姿态附近的变化）。没有这样的片段时，才用文件里的初始姿态判断；偏差相同时按 glTF 规范取场景空间。
// 只看初始姿态不可靠：初始姿态可能既不是绑定姿态，又恰好像另一种参照系。
// 然后按这种理解算出每根骨骼的绑定变换，普通（非骨骼）父节点的变换都正确补偿。

import {
  AnimationClip,
  Matrix4,
  PropertyBinding,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type Interpolant,
  type KeyframeTrack,
  type Object3D,
  type SkinnedMesh,
} from 'three';

export type BindConvention = 'scene' | 'parent';

export interface BoneBind {
  /** 轨道里指定这根骨骼用的名字：与 GLTFLoader 相同，有名字用名字，没有名字用（模板里的）UUID。 */
  readonly target: string;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: Vector3;
}

export interface BindPose {
  readonly convention: BindConvention;
  /** 判断参照系的依据：片段播放出来的姿态（clips），或没有可用片段时文件里的初始姿态（rest）。 */
  readonly basis: 'clips' | 'rest';
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

/**
 * 骨骼链所在的普通父节点：蒙皮骨骼（以及夹在链中间的非蒙皮骨骼）→ 链顶骨骼的父节点。
 * 骨架父节点空间的理解下，绑定姿态的蒙皮矩阵就是这个节点的变换。
 */
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

interface PoseOverride {
  position?: Vector3;
  quaternion?: Quaternion;
  scale?: Vector3;
}

/** 每个节点在模型空间（root 的本地空间）里的变换；overrides 里给出的分量代替节点自己的值（不改节点）。 */
function modelWorlds(root: Object3D, overrides?: ReadonlyMap<Object3D, PoseOverride>): Map<Object3D, Matrix4> {
  const worlds = new Map<Object3D, Matrix4>([[root, new Matrix4()]]);
  const visit = (node: Object3D, parentWorld: Matrix4) => {
    const o = overrides?.get(node);
    const world = new Matrix4().compose(o?.position ?? node.position, o?.quaternion ?? node.quaternion, o?.scale ?? node.scale).premultiply(parentWorld);
    worlds.set(node, world);
    for (const child of node.children) visit(child, world);
  };
  for (const child of root.children) visit(child, new Matrix4());
  return worlds;
}

type TransformProperty = 'position' | 'quaternion' | 'scale';

interface Channel {
  readonly node: Object3D;
  readonly property: TransformProperty;
  readonly interpolant: Interpolant;
}

/** 片段里作用在 affects 中节点的位置 / 旋转 / 缩放轨道（按与播放时相同的规则找目标节点，用轨道自己的插值器取值）。 */
function channelsOf(clip: AnimationClip, root: Object3D, affects: ReadonlySet<Object3D>): Channel[] {
  const channels: Channel[] = [];
  for (const track of clip.tracks) {
    let parsed: ReturnType<typeof PropertyBinding.parseTrackName>;
    try {
      parsed = PropertyBinding.parseTrackName(track.name);
    } catch {
      continue;
    }
    const property = parsed.propertyName;
    if (property !== 'position' && property !== 'quaternion' && property !== 'scale') continue;
    if (parsed.objectName || parsed.propertyIndex) continue; // 不是整个属性（例如 bones[...] 或分量）
    const node = PropertyBinding.findNode(root, parsed.nodeName) as Object3D | null | undefined;
    if (!node || !affects.has(node)) continue;
    // createInterpolant 是 three 在运行时按插值方式设置的（GLTFLoader 给 CUBICSPLINE 换成了自己的插值器），类型声明里没有
    const interpolant = (track as KeyframeTrack & { createInterpolant(): Interpolant }).createInterpolant();
    channels.push({ node, property, interpolant });
  }
  return channels;
}

/** 片段在时刻 t 的姿态（只含片段里有的分量）。 */
function sampleAt(channels: readonly Channel[], t: number): Map<Object3D, PoseOverride> {
  const pose = new Map<Object3D, PoseOverride>();
  for (const channel of channels) {
    const values = channel.interpolant.evaluate(t);
    const entry = pose.get(channel.node) ?? {};
    if (channel.property === 'quaternion') entry.quaternion = new Quaternion().fromArray(values).normalize();
    else entry[channel.property] = new Vector3().fromArray(values);
    pose.set(channel.node, entry);
  }
  return pose;
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

/**
 * 判断 IBM 的参照系。片段里有动到蒙皮的轨道时，用各片段起点和中点的姿态；否则用初始姿态。
 * 每个姿态下算出各关节的蒙皮矩阵 K_j，与两种理解下的绑定值（单位矩阵 / 骨骼链父节点的变换）比较，取总偏差小的。
 */
function decideConvention(
  root: Object3D,
  bones: ReadonlyMap<Object3D, Matrix4>,
  owners: ReadonlyMap<Object3D, Object3D>,
  clips: readonly AnimationClip[],
): { convention: BindConvention; basis: 'clips' | 'rest' } {
  const rest = modelWorlds(root);
  const length = characteristicLength(bones, rest);
  // 会影响蒙皮的节点：蒙皮骨骼和它们的所有父节点
  const affects = new Set<Object3D>();
  for (const bone of bones.keys()) {
    for (let node: Object3D | null = bone; node && node !== root; node = node.parent) affects.add(node);
  }
  const poses: Map<Object3D, Matrix4>[] = [];
  for (const clip of clips) {
    const channels = channelsOf(clip, root, affects);
    if (channels.length === 0) continue;
    const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 0;
    for (const t of duration > 0 ? [0, duration / 2] : [0]) poses.push(modelWorlds(root, sampleAt(channels, t)));
  }
  const basis = poses.length > 0 ? 'clips' : 'rest';
  if (poses.length === 0) poses.push(rest);

  const identity = new Matrix4();
  const k = new Matrix4();
  let sceneError = 0;
  let parentError = 0;
  for (const worlds of poses) {
    for (const [bone, inverse] of bones) {
      const world = worlds.get(bone);
      if (!world) continue;
      k.multiplyMatrices(world, inverse);
      const owner = owners.get(bone);
      sceneError += distance(k, identity, length);
      parentError += distance(k, (owner && worlds.get(owner)) ?? identity, length);
    }
  }
  return { convention: parentError < sceneError - 1e-9 ? 'parent' : 'scene', basis };
}

/** 轨道里指定这个节点用的名字：与 GLTFLoader 相同（有名字用名字，没有用 UUID）；名字不能唯一找到这个节点时用 UUID。 */
function trackTarget(root: Object3D, node: Object3D): string {
  const name = node.name;
  if (name !== '' && PropertyBinding.sanitizeNodeName(name) === name && PropertyBinding.findNode(root, name) === node) return name;
  return node.uuid;
}

/** 由模板计算绑定姿态（参照系按 clips 判断，见文件开头）。没有蒙皮时返回 null。模板不会被修改。 */
export function computeBindPose(root: Object3D, clips: readonly AnimationClip[] = []): BindPose | null {
  const bones = collectBones(root);
  if (bones.size === 0) return null;
  const owners = chainOwners(root, bones);
  const { convention, basis } = decideConvention(root, bones, owners, clips);

  // 按先父后子算每个节点在绑定姿态下的模型空间变换：骨骼取 IBM 决定的变换，其他节点跟随父节点
  const bindWorlds = new Map<Object3D, Matrix4>([[root, new Matrix4()]]);
  const locals = new Map<string, BoneBind>();
  const visit = (node: Object3D, parentWorld: Matrix4) => {
    const inverse = bones.get(node);
    let world: Matrix4;
    if (inverse) {
      // 骨骼链的参照系：场景空间时是单位矩阵；骨架父节点空间时是骨骼链父节点在绑定姿态下的变换
      const owner = owners.get(node);
      const frame = convention === 'scene' ? new Matrix4() : ((owner && bindWorlds.get(owner)) ?? new Matrix4());
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
    bindWorlds.set(node, world);
    for (const child of node.children) visit(child, world);
  };
  for (const child of root.children) visit(child, new Matrix4());
  return { convention, basis, locals };
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
