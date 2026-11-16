// 带位移的片段：识别承担整体位移的节点，计算模型空间里的水平位移，以及生成“锁定水平位移”的片段副本。
// 原片段永远不改；锁定只生成副本，取消锁定就回到原片段。

import { Matrix3, Matrix4, PropertyBinding, Vector3, type AnimationClip, type Interpolant, type KeyframeTrack, type Object3D } from 'three';
import { CLIP_RULES } from './limits';
import { t as tr } from '../i18n';

export const LOCK_UNSUPPORTED_MESSAGE = tr('motion.lockUnsupported');

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
    const names = [...new Set(top.map((t) => t.node.name || t.node.uuid))].join(tr('common.listSep'));
    return { reason: tr('motion.topNotUnique', { names }) };
  }
  const ancestors = new Set(ancestorsBelow(first.node, root));
  for (const t of targets) {
    if (!ancestors.has(t.node)) continue;
    if (t.property === 'quaternion' || t.property === 'rotation') {
      return { reason: tr('motion.parentRotates', { node: t.node.name || t.node.uuid }) };
    }
    if (t.property === 'scale') {
      return { reason: tr('motion.parentScales', { node: t.node.name || t.node.uuid }) };
    }
  }
  const matrix = parentToModel(first.node, root);
  const det = matrix.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { reason: tr('motion.parentNotInvertible') };
  const track = clip.tracks[first.trackIndex];
  if (!track || (valueStride(track) !== 3 && valueStride(track) !== 9)) return { reason: tr('motion.badTrackFormat') };
  return { target: first, matrix };
}

/** CUBICSPLINE 轨道每个关键帧区间里额外取样的点数。 */
const CUBIC_SAMPLES_PER_INTERVAL = 32;

/**
 * 位置轨道在模型空间里相对起点的水平位移（最大值和结束时的值）。
 * 用轨道自己的插值器取值（与播放时一致）：线性和阶跃插值的最大值一定出现在关键帧上；
 * CUBICSPLINE 在关键帧之间可能走得更远，所以每个区间再均匀取样。
 */
function horizontalDisplacement(track: KeyframeTrack, toModel: Matrix4): { maxHorizontal: number; endHorizontal: number } {
  const times = track.times;
  const keys = times.length;
  if (keys === 0) return { maxHorizontal: 0, endHorizontal: 0 };
  // createInterpolant 是 three 在运行时按插值方式设置的（GLTFLoader 给 CUBICSPLINE 换成了自己的插值器），类型声明里没有
  const interpolant = (track as KeyframeTrack & { createInterpolant(): Interpolant }).createInterpolant();
  const cubic = valueStride(track) === 9;
  const p = new Vector3();
  const at = (t: number) => p.fromArray(interpolant.evaluate(t)).applyMatrix4(toModel);
  const start = at(times[0] ?? 0).clone();
  let maxHorizontal = 0;
  const visit = (t: number) => {
    const q = at(t);
    maxHorizontal = Math.max(maxHorizontal, Math.hypot(q.x - start.x, q.z - start.z));
  };
  for (let k = 0; k < keys; k++) {
    const t0 = times[k] ?? 0;
    visit(t0);
    const t1 = times[k + 1];
    if (cubic && t1 !== undefined) {
      for (let s = 1; s < CUBIC_SAMPLES_PER_INTERVAL; s++) visit(t0 + ((t1 - t0) * s) / CUBIC_SAMPLES_PER_INTERVAL);
    }
  }
  const end = at(times[keys - 1] ?? 0);
  return { maxHorizontal, endHorizontal: Math.hypot(end.x - start.x, end.z - start.z) };
}

/** 识别带位移的片段（模型空间里，相对片段起点的水平位移超过阈值）。 */
export function analyzeRootMotion(clip: AnimationClip, root: Object3D, threshold: number = CLIP_RULES.rootMotionThreshold): RootMotion {
  const found = findRootNode(clip, root);
  if (found === null) return { kind: 'none' };
  if ('reason' in found) return { kind: 'unidentified', reason: found.reason };
  const track = clip.tracks[found.target.trackIndex];
  if (!track) return { kind: 'unidentified', reason: tr('motion.noTrack') };
  const { maxHorizontal, endHorizontal } = horizontalDisplacement(track, found.matrix);
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
