// 带位移的片段：能识别 / 不能识别的检测结果；锁定水平位移后的片段副本；原片段不被修改。

import { Matrix4, PropertyBinding, Vector3, type AnimationClip, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { GltfBuilder, type AnimationChannelSpec } from '../../src/asset/fixtures';
import { CLIP_RULES } from '../../src/import/limits';
import { LOCK_UNSUPPORTED_MESSAGE, analyzeRootMotion, lockHorizontalMotion } from '../../src/import/motion';
import { importFixture, importGlb, triangleMesh } from '../helpers/import';

/** 片段里某个节点 position 轨道的每个关键帧在模型空间里的位置。 */
function modelSpacePositions(clip: AnimationClip, root: Object3D, nodeName: string): Vector3[] {
  const track = clip.tracks.find((t) => {
    const parsed = PropertyBinding.parseTrackName(t.name);
    return parsed.nodeName === nodeName && parsed.propertyName === 'position';
  });
  if (!track) throw new Error(`没有 ${nodeName} 的位置轨道`);
  const node = PropertyBinding.findNode(root, nodeName) as Object3D;
  root.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(root.matrixWorld).invert().multiply(node.parent?.matrixWorld ?? new Matrix4());
  const stride = track.values.length / track.times.length;
  return Array.from(track.times, (_, k) => new Vector3().fromArray(track.values, stride === 9 ? k * 9 + 3 : k * 3).applyMatrix4(toModel));
}

function snapshotClip(clip: AnimationClip) {
  return { name: clip.name, duration: clip.duration, tracks: clip.tracks.map((t) => ({ name: t.name, times: [...t.times], values: [...t.values] })) };
}

/** 一个节点在父节点下移动；父节点可选静态变换或旋转动画。 */
function movingChild(options: {
  parent?: { rotation?: [number, number, number, number]; scale?: [number, number, number] };
  parentRotationAnimated?: boolean;
  values: number[];
  times: number[];
  interpolation?: 'LINEAR' | 'CUBICSPLINE';
  sibling?: boolean;
}): Uint8Array {
  const b = new GltfBuilder();
  const mesh = triangleMesh(b);
  const mover = b.addNode({ name: 'Mover', mesh });
  const sibling = options.sibling ? b.addNode({ name: 'Sibling', mesh }) : null;
  const children = sibling === null ? [mover] : [mover, sibling];
  const parent = b.addNode({ name: 'Rig', children, ...(options.parent ?? {}) });
  const root = b.addNode({ name: 'Root', children: [parent] });
  b.addScene([root]);
  const channels: AnimationChannelSpec[] = [
    { node: mover, path: 'translation', times: options.times, values: options.values, interpolation: options.interpolation ?? 'LINEAR' },
    { node: mover, path: 'scale', times: [0, 1], values: [1, 1, 1, 1.1, 1.1, 1.1] },
  ];
  if (sibling !== null) channels.push({ node: sibling, path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 0, 1] });
  if (options.parentRotationAnimated) {
    channels.push({ node: parent, path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, 0, Math.sin(0.4), 0, Math.cos(0.4)] });
  }
  b.addAnimation({ name: 'move', channels });
  return b.toGlb();
}

describe('检测', () => {
  it('能明确识别：root-motion 夹具的 Hips 在 2 秒内水平移动 2 m，标为带位移', async () => {
    const asset = await importFixture('root-motion');
    const motion = asset.rootMotion[0];
    expect(motion?.kind).toBe('identified');
    if (motion?.kind !== 'identified') return;
    expect(motion.nodeName).toBe('Hips');
    expect(motion.maxHorizontal).toBeCloseTo(2, 5);
    expect(motion.endHorizontal).toBeCloseTo(2, 5);
    expect(motion.flagged).toBe(true);
    expect(asset.canLockMotion(0)).toBe(true);
    // 带位移的片段默认不作为“走”的建议
    expect(asset.decisions().slots.walk).toBeNull();
  });

  it('没有位置轨道的片段：原地片段', async () => {
    const asset = await importFixture('skinned-humanoid');
    expect(asset.rootMotion.map((m) => m.kind)).toEqual(['none', 'none', 'none']);
  });

  it('水平位移不超过阈值：能识别，但不标为带位移', async () => {
    const asset = await importGlb(movingChild({ times: [0, 1], values: [0, 0, 0, 0.1, 0.5, 0.1] }));
    const motion = asset.rootMotion[0];
    expect(motion?.kind).toBe('identified');
    if (motion?.kind === 'identified') {
      expect(motion.maxHorizontal).toBeCloseTo(Math.hypot(0.1, 0.1), 6);
      expect(motion.maxHorizontal).toBeLessThan(CLIP_RULES.rootMotionThreshold);
      expect(motion.flagged).toBe(false);
    }
  });

  it('不能识别：层级最靠上的位置动画不唯一', async () => {
    const asset = await importGlb(movingChild({ sibling: true, times: [0, 1], values: [0, 0, 0, 0, 0, 3] }));
    const motion = asset.rootMotion[0];
    expect(motion?.kind).toBe('unidentified');
    if (motion?.kind === 'unidentified') expect(motion.reason).toContain('不唯一');
    expect(asset.canLockMotion(0)).toBe(false);
    expect(() => {
      asset.setMotionLocked(0, true);
    }).toThrow();
    expect(LOCK_UNSUPPORTED_MESSAGE).toBe('该片段暂不支持锁定水平位移，请选择其他原地片段或使用兜底。');
  });

  it('不能识别：父链在片段里有旋转动画', async () => {
    const asset = await importGlb(movingChild({ parentRotationAnimated: true, times: [0, 1], values: [0, 0, 0, 0, 0, 3] }));
    const motion = asset.rootMotion[0];
    expect(motion?.kind).toBe('unidentified');
    if (motion?.kind === 'unidentified') expect(motion.reason).toContain('旋转动画');
  });

  it('父节点有静态的旋转和缩放：在模型空间里计算位移', async () => {
    // 父节点绕 Y 转 90°、放大 2 倍：本地 +X 移动 1 → 模型空间 −Z 移动 2
    const q = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as [number, number, number, number];
    const asset = await importGlb(movingChild({ parent: { rotation: q, scale: [2, 2, 2] }, times: [0, 1], values: [0, 0, 0, 1, 0, 0] }));
    const motion = asset.rootMotion[0];
    expect(motion?.kind).toBe('identified');
    if (motion?.kind === 'identified') expect(motion.maxHorizontal).toBeCloseTo(2, 5);
  });
});

describe('锁定水平位移', () => {
  it('副本里水平方向相对起点的位移为 0；起点偏移和垂直分量与原片段相同；其他轨道不变；原片段没被修改', async () => {
    // 起点 (3, 0.9, -1)，水平走 2 m，同时上下起伏
    const values = [3, 0.9, -1, 3.5, 1.0, -0.2, 4, 0.9, 0.5, 4.2, 1.05, 0.9];
    const asset = await importGlb(movingChild({ times: [0, 0.5, 1, 1.5], values }));
    const original = asset.clips[0];
    if (!original) throw new Error('没有片段');
    const before = snapshotClip(original);
    const motion = asset.rootMotion[0];
    if (motion?.kind !== 'identified') throw new Error('应能识别');
    expect(motion.flagged).toBe(true);

    const locked = lockHorizontalMotion(original, asset.template, motion);
    expect(locked).not.toBe(original);
    expect(snapshotClip(original)).toEqual(before); // 原片段没被修改
    expect(locked.tracks).toHaveLength(original.tracks.length); // 没有删除任何轨道
    const lockedPositions = modelSpacePositions(locked, asset.template, 'Mover');
    const originalPositions = modelSpacePositions(original, asset.template, 'Mover');
    const start = originalPositions[0] ?? new Vector3();
    lockedPositions.forEach((p, k) => {
      expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeCloseTo(0, 9); // 水平相对位移为 0
      expect(p.y).toBeCloseTo(originalPositions[k]?.y ?? NaN, 9); // 垂直分量不变
    });
    expect(lockedPositions[0]?.toArray()).toEqual(originalPositions[0]?.toArray()); // 起点偏移不变，不是归零
    expect(Math.abs(start.x) + Math.abs(start.z)).toBeGreaterThan(1);
    // 其他轨道不变
    locked.tracks.forEach((track, i) => {
      if (i === motion.trackIndex) return;
      expect([...track.values]).toEqual(before.tracks[i]?.values);
      expect([...track.times]).toEqual(before.tracks[i]?.times);
    });
    expect([...(locked.tracks[motion.trackIndex]?.times ?? [])]).toEqual(before.tracks[motion.trackIndex]?.times);
    expect(locked.userData).toEqual(original.userData);
    expect(locked.duration).toBe(original.duration);
  });

  it('父节点有静态旋转和缩放时，也在模型空间里去掉水平运动', async () => {
    const q = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as [number, number, number, number];
    const asset = await importGlb(
      movingChild({ parent: { rotation: q, scale: [2, 2, 2] }, times: [0, 1], values: [0.5, 0.2, 0.3, 1.5, 0.6, 0.3] }),
    );
    const original = asset.clips[0];
    const motion = asset.rootMotion[0];
    if (!original || motion?.kind !== 'identified') throw new Error('应能识别');
    const locked = lockHorizontalMotion(original, asset.template, motion);
    const [p0, p1] = modelSpacePositions(locked, asset.template, 'Mover');
    const [o0, o1] = modelSpacePositions(original, asset.template, 'Mover');
    expect(p1?.x).toBeCloseTo(o0?.x ?? NaN, 9);
    expect(p1?.z).toBeCloseTo(o0?.z ?? NaN, 9);
    expect(p1?.y).toBeCloseTo(o1?.y ?? NaN, 9);
    expect(p0?.toArray()).toEqual(o0?.toArray());
  });

  it('CUBICSPLINE 轨道：值和切线的水平分量都去掉，垂直保留', async () => {
    // 每个关键帧：入切线、值、出切线
    const values = [0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 1, 2, 1, 0.5, 1, 0, 1, 2];
    const asset = await importGlb(movingChild({ times: [0, 1], values, interpolation: 'CUBICSPLINE' }));
    const original = asset.clips[0];
    const motion = asset.rootMotion[0];
    if (!original || motion?.kind !== 'identified') throw new Error('应能识别');
    expect(motion.maxHorizontal).toBeCloseTo(Math.hypot(1, 1), 6);
    const locked = lockHorizontalMotion(original, asset.template, motion);
    const track = locked.tracks[motion.trackIndex];
    if (!track) throw new Error('没有轨道');
    // 关键帧 1：入切线 (0,1,2) → (0,1,0)，值 (1,0.5,1) → (0,0.5,0)，出切线 (0,1,2) → (0,1,0)
    expect([...track.values.slice(9, 18)].map((v) => Number(v.toFixed(6)))).toEqual([0, 1, 0, 0, 0.5, 0, 0, 1, 0]);
    expect([...(original.tracks[motion.trackIndex]?.values.slice(9, 18) ?? [])]).toEqual([0, 1, 2, 1, 0.5, 1, 0, 1, 2]);
  });

  it('勾选用副本，取消勾选恢复原片段；锁定后可以作为“走”的建议', async () => {
    const asset = await importFixture('root-motion');
    const original = asset.clips[0];
    asset.setMotionLocked(0, true);
    const locked = asset.gameClip(0);
    expect(locked).not.toBe(original);
    expect(asset.decisions().slots.walk).toBe(0);
    const motion = asset.rootMotion[0];
    if (motion?.kind !== 'identified' || !locked) throw new Error('应能识别');
    const hips = modelSpacePositions(locked, asset.template, 'Hips');
    for (const p of hips) expect(Math.hypot(p.x - (hips[0]?.x ?? 0), p.z - (hips[0]?.z ?? 0))).toBeCloseTo(0, 9);
    asset.setMotionLocked(0, false);
    expect(asset.gameClip(0)).toBe(original);
    expect(asset.decisions().slots.walk).toBeNull();
  });

  it('检测本身不修改片段', async () => {
    const asset = await importFixture('root-motion');
    const clip = asset.clips[0];
    if (!clip) throw new Error('没有片段');
    const before = snapshotClip(clip);
    analyzeRootMotion(clip, asset.template);
    expect(snapshotClip(clip)).toEqual(before);
  });
});
