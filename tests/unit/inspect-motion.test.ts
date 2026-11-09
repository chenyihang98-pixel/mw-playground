// inspect 报告里 translation 通道的水平位移（F1 起）：模型空间，XZ 平面，各关键帧相对首帧的最大水平距离。
// 父链（到场景根为止）用文件里的静态变换；父链在同一个动画里有 rotation 或 scale 通道时坐标系不确定，不填数字。
// GLB 都用 P1 的夹具写入器在内存里生成。

import { describe, expect, it } from 'vitest';
import { GltfBuilder, type AnimationChannelSpec } from '../../src/asset/fixtures';
import { formatInspectReport, inspectGlb, type HorizontalMotionReport, type InspectReport } from '../../src/asset/inspect';

const H = Math.SQRT1_2;
const ROTATE_Y_90: [number, number, number, number] = [0, H, 0, H];
const ROTATE_X_90: [number, number, number, number] = [H, 0, 0, H];

function inspect(bytes: Uint8Array): InspectReport {
  const result = inspectGlb(bytes);
  if (!result.ok) throw new Error(result.error.message);
  return result.report;
}

function motions(report: InspectReport, animation = 0): readonly HorizontalMotionReport[] {
  const a = report.animations.animations[animation];
  if (!a) throw new Error(`没有动画 #${String(animation)}`);
  return a.horizontalMotion;
}

function motionOf(report: InspectReport, node: number, animation = 0): HorizontalMotionReport {
  const m = motions(report, animation).find((x) => x.node === node);
  if (!m) throw new Error(`nodes[${String(node)}] 没有 translation 通道`);
  return m;
}

function distanceOf(m: HorizontalMotionReport): number {
  if (m.displacement.status !== 'computed') throw new Error(`应该已计算：${m.displacement.reason}`);
  return m.displacement.value.maxDistance;
}

/** 旧算法（P1）：本地坐标里首末关键帧的 XZ 距离。只用来对照。 */
function localFirstLast(values: readonly number[]): number {
  const n = values.length / 3;
  return Math.hypot((values[(n - 1) * 3] ?? 0) - (values[0] ?? 0), (values[(n - 1) * 3 + 2] ?? 0) - (values[2] ?? 0));
}

/**
 * Parent（静态变换 parent）→ Child；Child 有一条 translation 通道（childValues），可以再加别的通道。
 * 返回 GLB 和两个节点的序号。
 */
function parentChild(options: {
  parent?: { translation?: [number, number, number]; rotation?: [number, number, number, number]; scale?: [number, number, number] };
  grandparent?: boolean;
  childTimes?: number[];
  childValues: number[];
  interpolation?: AnimationChannelSpec['interpolation'];
  extraChannels?: (nodes: { parent: number; child: number; grandparent: number | null }) => AnimationChannelSpec[];
  otherAnimation?: (nodes: { parent: number; child: number }) => AnimationChannelSpec[];
}): { bytes: Uint8Array; parent: number; child: number; grandparent: number | null } {
  const b = new GltfBuilder();
  const child = b.addNode({ name: 'Child' });
  const parent = b.addNode({ name: 'Parent', children: [child], ...(options.parent ?? {}) });
  const grandparent = options.grandparent ? b.addNode({ name: 'Grandparent', children: [parent] }) : null;
  b.addScene([grandparent ?? parent]);
  const keys = options.childValues.length / (options.interpolation === 'CUBICSPLINE' ? 9 : 3);
  const times = options.childTimes ?? Array.from({ length: keys }, (_, i) => i);
  const channels: AnimationChannelSpec[] = [
    { node: child, path: 'translation', times, values: options.childValues, ...(options.interpolation ? { interpolation: options.interpolation } : {}) },
    ...(options.extraChannels?.({ parent, child, grandparent }) ?? []),
  ];
  b.addAnimation({ name: 'move', channels });
  const other = options.otherAnimation?.({ parent, child });
  if (other) b.addAnimation({ name: 'other', channels: other });
  return { bytes: b.toGlb(), parent, child, grandparent };
}

describe('模型空间的水平位移', () => {
  it('父节点绕 Y 轴静态转 90°、子节点只在本地 Z 方向移动 1 m：报告 1 m（本地坐标的算法也是 1 m）', () => {
    const values = [0, 0, 0, 0, 0, 1];
    const { bytes, child } = parentChild({ parent: { translation: [5, 0, 0], rotation: ROTATE_Y_90 }, childValues: values });
    const m = motionOf(inspect(bytes), child);
    expect(distanceOf(m)).toBeCloseTo(1, 6);
    expect(localFirstLast(values)).toBeCloseTo(1, 6);
    // 首帧在模型空间里：父节点的平移 (5, 0, 0)
    if (m.displacement.status === 'computed') {
      expect(m.displacement.value.first[0]).toBeCloseTo(5, 6);
      expect(m.displacement.value.first[1]).toBeCloseTo(0, 6);
    }
  });

  it('父节点绕 X 轴静态转 90°、子节点只在本地 Y 方向移动 1 m：在模型空间里是水平移动，报告 1 m（旧算法是 0）', () => {
    const values = [0, 0, 0, 0, 1, 0];
    const { bytes, child } = parentChild({ parent: { rotation: ROTATE_X_90 }, childValues: values });
    expect(distanceOf(motionOf(inspect(bytes), child))).toBeCloseTo(1, 6);
    expect(localFirstLast(values)).toBe(0);
  });

  it('父节点带静态缩放 2：位移按缩放后的值报告', () => {
    const { bytes, child } = parentChild({ parent: { scale: [2, 2, 2] }, childValues: [0, 0, 0, 1, 0, 0] });
    expect(distanceOf(motionOf(inspect(bytes), child))).toBeCloseTo(2, 6);
  });

  it('父链（到场景根为止）的静态变换都算进去：祖父节点也在链上', () => {
    const { bytes, child } = parentChild({ parent: { scale: [3, 3, 3] }, grandparent: true, childValues: [0, 0, 0, 0, 0, 1] });
    expect(distanceOf(motionOf(inspect(bytes), child))).toBeCloseTo(3, 6);
  });

  it('取各关键帧相对首帧的最大距离，不只看首末：走出去又回来报告 1 m', () => {
    const values = [0, 0, 0, 1, 0, 0, 0, 0, 0];
    const { bytes, child } = parentChild({ childValues: values });
    const m = motionOf(inspect(bytes), child);
    expect(distanceOf(m)).toBeCloseTo(1, 6);
    expect(m.displacement).toMatchObject({ status: 'computed', value: { atKeyframe: 1, keyframes: 3 } });
    expect(localFirstLast(values)).toBe(0);
  });

  it('只有一个关键帧：位移为 0（已计算）', () => {
    const { bytes, child } = parentChild({ childValues: [3, 0, 4] });
    const m = motionOf(inspect(bytes), child);
    expect(m.displacement).toEqual({ status: 'computed', value: { maxDistance: 0, atKeyframe: 0, keyframes: 1, first: [3, 4] } });
  });

  it('父链上其他节点的 translation 动画不计入：只算这个通道自身带来的位移', () => {
    const { bytes, child, parent } = parentChild({
      childValues: [0, 0, 0, 0, 0, 1],
      extraChannels: ({ parent }) => [{ node: parent, path: 'translation', times: [0, 1], values: [0, 0, 0, 5, 0, 0] }],
    });
    const r = inspect(bytes);
    expect(distanceOf(motionOf(r, child))).toBeCloseTo(1, 6);
    expect(distanceOf(motionOf(r, parent))).toBeCloseTo(5, 6);
  });

  it('CUBICSPLINE 只看关键帧的值（不含切线和关键帧之间的插值），报告里注明', () => {
    // 每个关键帧：入切线、值、出切线；切线很大，但只看值
    const tangent = [100, 0, 100];
    const values = [...tangent, 0, 0, 0, ...tangent, ...tangent, 0, 0, 2, ...tangent];
    const { bytes, child } = parentChild({ childValues: values, interpolation: 'CUBICSPLINE' });
    const r = inspect(bytes);
    const m = motionOf(r, child);
    expect(m.interpolation).toBe('CUBICSPLINE');
    expect(distanceOf(m)).toBeCloseTo(2, 6);
    expect(formatInspectReport(r)).toContain('CUBICSPLINE 只看关键帧的值');
  });
});

describe('坐标系不确定', () => {
  it('父节点在同一个动画里有 rotation 通道：写“坐标系不确定”，不填数字', () => {
    const { bytes, child, parent } = parentChild({
      childValues: [0, 0, 0, 0, 0, 1],
      extraChannels: ({ parent }) => [{ node: parent, path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...ROTATE_Y_90] }],
    });
    const r = inspect(bytes);
    const m = motionOf(r, child);
    expect(m.displacement.status).toBe('not-computed');
    if (m.displacement.status === 'not-computed') {
      expect(m.displacement.reason).toBe(`坐标系不确定：父链上的 nodes[${String(parent)}] "Parent" 在这个动画里有 rotation 通道`);
    }
    expect(m.displacement).not.toHaveProperty('value');
    const text = formatInspectReport(r);
    const line = text.split('\n').find((l) => l.includes('水平位移') && l.includes('"Child"')) ?? '';
    expect(line).toContain('未计算（坐标系不确定');
    expect(line).not.toMatch(/\d m（第/);
  });

  it('父链上更高的节点在同一个动画里有 scale 通道：同样坐标系不确定', () => {
    const { bytes, child } = parentChild({
      grandparent: true,
      childValues: [0, 0, 0, 0, 0, 1],
      extraChannels: ({ grandparent }) => [{ node: grandparent ?? 0, path: 'scale', times: [0, 1], values: [1, 1, 1, 2, 2, 2] }],
    });
    expect(motionOf(inspect(bytes), child).displacement).toMatchObject({ status: 'not-computed', reason: expect.stringContaining('坐标系不确定') as string });
  });

  it('父节点的 rotation 通道在另一个动画里：不影响这个动画，照常计算', () => {
    const { bytes, child } = parentChild({
      parent: { rotation: ROTATE_X_90 },
      childValues: [0, 0, 0, 0, 1, 0],
      otherAnimation: ({ parent }) => [{ node: parent, path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...ROTATE_Y_90] }],
    });
    expect(distanceOf(motionOf(inspect(bytes), child))).toBeCloseTo(1, 6);
  });

  it('节点自己的 rotation 通道不影响它的 translation（平移在父节点的坐标系里）', () => {
    const { bytes, child } = parentChild({
      childValues: [0, 0, 0, 0, 0, 1],
      extraChannels: ({ child }) => [{ node: child, path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...ROTATE_Y_90] }],
    });
    expect(distanceOf(motionOf(inspect(bytes), child))).toBeCloseTo(1, 6);
  });

  it('节点有多个父节点：父链不确定，写“坐标系不确定”', () => {
    const b = new GltfBuilder();
    const child = b.addNode({ name: 'Shared' });
    const a = b.addNode({ name: 'A', children: [child] });
    const c = b.addNode({ name: 'B', children: [child], rotation: ROTATE_Y_90 });
    b.addScene([a, c]);
    b.addAnimation({ name: 'move', channels: [{ node: child, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] });
    expect(motionOf(inspect(b.toGlb()), child).displacement).toMatchObject({
      status: 'not-computed',
      reason: expect.stringContaining('坐标系不确定') as string,
    });
  });
});

describe('报告的说明文字', () => {
  it('写明口径：模型空间，XZ 平面，各关键帧相对首帧的最大水平距离；父链的静态变换和不插值', () => {
    const { bytes } = parentChild({ childValues: [0, 0, 0, 0, 0, 1] });
    const text = formatInspectReport(inspect(bytes));
    expect(text).toContain('水平位移（translation；模型空间，XZ 平面，各关键帧相对首帧的最大水平距离）');
    expect(text).toContain('父链按文件里的静态变换换到模型空间，父链上其他节点的 translation 动画不计入；关键帧之间不插值');
    expect(text).not.toContain('首末关键帧');
  });
});
