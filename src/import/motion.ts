// 带位移的片段：识别承担整体位移的节点，计算模型空间里的水平位移，以及生成“锁定水平位移”的片段副本。
// 原片段永远不改；锁定只生成副本，取消锁定就回到原片段。

import { Matrix3, Matrix4, PropertyBinding, Vector3, type AnimationClip, type KeyframeTrack, type Object3D } from 'three';
import { CLIP_RULES } from './limits';

export const LOCK_UNSUPPORTED_MESSAGE = '该片段暂不支持锁定水平位移，请选择其他原地片段或使用兜底。';

export type RootMotion =
  /** 片段里没有 position 轨道：原地片段。 */
  | { readonly kind: 'none' }
  /** 有 position 轨道，但不能明确识别承担整体位移的节点。 */
  | { readonly kind: 'unidentified'; readonly reason: string }
  | {
      readonly kind: 'identified';
      /** 承担整体位移的节点名（轨道里的名字）。 */
      readonly nodeName: string;
      readonly trackIndex: number;
      /** 片段内相对起点的最大水平位移（模型空间，米）。 */
      readonly maxHorizontal: number;
      /** 片段结束时相对起点的水平位移。 */
      readonly endHorizontal: number;
      /** 超过阈值：带位移。 */
      readonly flagged: boolean;
    };

interface TrackTarget {
  readonly trackIndex: number;
  readonly node: Object3D;
  readonly property: string;
}

function trackTargets(clip: AnimationClip, root: Object3D): { targets: TrackTarget[]; unresolved: string[] } {
  const targets: TrackTarget[] = [];
  const unresolved: string[] = [];
  clip.tracks.forEach((track, trackIndex) => {
    const parsed = PropertyBinding.parseTrackName(track.name);
    const node = PropertyBinding.findNode(root, parsed.nodeName) as Object3D | null | undefined;
    if (!node) unresolved.push(parsed.nodeName);
    else targets.push({ trackIndex, node, property: parsed.propertyName });
  });
  return { targets, unresolved };
}

function depthBelow(node: Object3D, root: Object3D): number {
  let depth = 0;
  let current: Object3D | null = node;
  while (current && current !== root) {
    depth++;
    current = current.parent;
  }
  return depth;
}

function ancestorsBelow(node: Object3D, root: Object3D): Object3D[] {
  const chain: Object3D[] = [];
  let current = node.parent;
  while (current && current !== root) {
    chain.push(current);
    current = current.parent;
  }
  if (current === root) chain.push(root);
  return chain;
}

/** 父节点到模型空间（root 的本地空间）的静态变换。root 和父链都按当前（未播放动画时的）变换计算。 */
function parentToModel(node: Object3D, root: Object3D): Matrix4 {
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const parentWorld = node.parent ? node.parent.matrixWorld : new Matrix4();
  return new Matrix4().multiplyMatrices(rootInverse, parentWorld);
}

/** 每个关键帧值的分量数：线性 / 阶跃是 3；GLTFLoader 的 CUBICSPLINE 是 9（入切线、值、出切线）。 */
function valueStride(track: KeyframeTrack): number {
  return track.values.length / Math.max(1, track.times.length);
}

function keyValueOffset(stride: number, key: number): number {
  return stride === 9 ? key * 9 + 3 : key * 3;
}

type Identified = Extract<RootMotion, { kind: 'identified' }>;

/** 找到承担整体位移的节点；不能明确识别时给出原因。 */
function findRootNode(clip: AnimationClip, root: Object3D): { target: TrackTarget; matrix: Matrix4 } | { reason: string } | null {
  const { targets } = trackTargets(clip, root);
  const positional = targets.filter((t) => t.property === 'position');
  if (positional.length === 0) return null;
  const minDepth = Math.min(...positional.map((t) => depthBelow(t.node, root)));
  const top = positional.filter((t) => depthBelow(t.node, root) === minDepth);
  const first = top[0];
  if (!first) return null;
  if (top.length > 1) {
    const names = [...new Set(top.map((t) => t.node.name || t.node.uuid))].join('、');
    return { reason: `层级最靠上的位置动画不唯一（${names}）` };
  }
  const ancestors = new Set(ancestorsBelow(first.node, root));
  for (const t of targets) {
    if (!ancestors.has(t.node)) continue;
    if (t.property === 'quaternion' || t.property === 'rotation') {
      return { reason: `父节点 ${t.node.name || t.node.uuid} 在片段里有旋转动画` };
    }
    if (t.property === 'scale') {
      return { reason: `父节点 ${t.node.name || t.node.uuid} 在片段里有缩放动画，无法确定坐标系` };
    }
  }
  const matrix = parentToModel(first.node, root);
  const det = matrix.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { reason: '父节点的变换不可逆，无法确定坐标系' };
  const track = clip.tracks[first.trackIndex];
  if (!track || (valueStride(track) !== 3 && valueStride(track) !== 9)) return { reason: '位置轨道的数据格式无法识别' };
  return { target: first, matrix };
}

/** 识别带位移的片段（模型空间里，相对片段起点的水平位移超过阈值）。 */
export function analyzeRootMotion(clip: AnimationClip, root: Object3D, threshold: number = CLIP_RULES.rootMotionThreshold): RootMotion {
  const found = findRootNode(clip, root);
  if (found === null) return { kind: 'none' };
  if ('reason' in found) return { kind: 'unidentified', reason: found.reason };
  const track = clip.tracks[found.target.trackIndex];
  if (!track) return { kind: 'unidentified', reason: '位置轨道不存在' };
  const stride = valueStride(track);
  const keys = track.times.length;
  const p = new Vector3();
  const start = new Vector3();
  let maxHorizontal = 0;
  let endHorizontal = 0;
  for (let k = 0; k < keys; k++) {
    p.fromArray(track.values, keyValueOffset(stride, k)).applyMatrix4(found.matrix);
    if (k === 0) start.copy(p);
    const horizontal = Math.hypot(p.x - start.x, p.z - start.z);
    maxHorizontal = Math.max(maxHorizontal, horizontal);
    if (k === keys - 1) endHorizontal = horizontal;
  }
  return {
    kind: 'identified',
    nodeName: PropertyBinding.parseTrackName(track.name).nodeName,
    trackIndex: found.target.trackIndex,
    maxHorizontal,
    endHorizontal,
    flagged: maxHorizontal > threshold,
  };
}

/**
 * 生成锁定水平位移的片段副本：在模型空间里去掉这个节点相对片段起点的水平运动
 * （每个关键帧的 X、Z 换成起点的 X、Z），起点位置、垂直运动和其他所有轨道都保留。
 * 不是把 X/Z 设成 0。原片段不改。
 */
export function lockHorizontalMotion(clip: AnimationClip, root: Object3D, motion: Identified): AnimationClip {
  const found = findRootNode(clip, root);
  if (found === null || 'reason' in found || found.target.trackIndex !== motion.trackIndex) {
    throw new Error(LOCK_UNSUPPORTED_MESSAGE);
  }
  const copy = clip.clone();
  copy.userData = structuredClone(clip.userData);
  const track = copy.tracks[motion.trackIndex];
  if (!track) throw new Error(LOCK_UNSUPPORTED_MESSAGE);
  const toModel = found.matrix;
  const toLocal = new Matrix4().copy(toModel).invert();
  const linear = new Matrix3().setFromMatrix4(toModel);
  const linearInverse = new Matrix3().copy(linear).invert();
  const stride = valueStride(track);
  const values = track.values; // clone() 已经复制了数组
  const start = new Vector3().fromArray(values, keyValueOffset(stride, 0)).applyMatrix4(toModel);
  const p = new Vector3();
  for (let k = 0; k < track.times.length; k++) {
    const offset = keyValueOffset(stride, k);
    p.fromArray(values, offset).applyMatrix4(toModel);
    p.x = start.x;
    p.z = start.z;
    p.applyMatrix4(toLocal).toArray(values, offset);
    if (stride === 9) {
      // 切线是速度：去掉模型空间里的水平分量
      for (const tangentOffset of [k * 9, k * 9 + 6]) {
        p.fromArray(values, tangentOffset).applyMatrix3(linear);
        p.x = 0;
        p.z = 0;
        p.applyMatrix3(linearInverse).toArray(values, tangentOffset);
      }
    }
  }
  return copy;
}
