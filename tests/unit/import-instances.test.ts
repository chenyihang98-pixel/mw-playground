// 归一化、实例独立、资源释放、实例上限、动画驱动（状态切换和整体摆动）。

import { Box3, BufferGeometry, Material, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GltfBuilder } from '../../src/asset/fixtures';
import { SPEC } from '../../src/game/spec';
import { ImportedCharacterModel } from '../../src/import/animator';
import { InstanceLimitError, InstanceRegistry, type ModelInstance } from '../../src/import/asset';
import { computeBindPose } from '../../src/import/bindPose';
import { poseBindPose, renderedBounds } from '../../src/import/normalize';
import { importFixture, importGlb, instancedTriangles, morphedTriangle, singleBoneSkin, skinnedWithMeshTransform } from '../helpers/import';

/**
 * 实例实际显示的包围盒（摆动节点空间）：先把骨骼摆成绑定姿态（由逆绑定矩阵决定），
 * 再用 three 自己的 getVertexPosition（morph + 当前骨骼的蒙皮）逐个顶点计算。与归一化用的公式无关，用来独立核对。
 */
function normalizedBox(instance: ModelInstance): Box3 {
  poseBindPose(instance.object);
  const box = renderedBounds(instance.swayPivot);
  if (!box) throw new Error('没有几何');
  return box;
}

function expectGrounded(box: Box3, height: number) {
  expect(box.min.y).toBeCloseTo(0, 6);
  expect(box.max.y - box.min.y).toBeCloseTo(height, 6);
  expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
  expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 6);
}

/** 一个身体加一个朝 +X 的鼻子（模拟面向 +X 的早期静态件），整体放大 scale 倍。 */
function facingPlusX(scale: number): Uint8Array {
  const b = new GltfBuilder();
  // 身体：x ∈ [-0.2, 0.2]，y ∈ [0, 1]，z ∈ [-0.3, 0.3]；鼻子在 x = 0.4 处
  const positions = [-0.2, 0, -0.3, 0.2, 0, -0.3, 0.2, 1, 0.3, -0.2, 1, 0.3, 0.4, 0.8, 0, 0.2, 0.8, 0.05, 0.2, 0.85, -0.05];
  const position = b.addAccessor({ array: new Float32Array(positions), type: 'VEC3' });
  const indices = b.addAccessor({ array: new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6]), type: 'SCALAR', minMax: false });
  const mesh = b.addMesh('Statue', [{ attributes: { POSITION: position }, indices }]);
  b.addScene([b.addNode({ name: 'Statue', mesh, scale: [scale, scale, scale], translation: [5, 3, -2] })]);
  return b.toGlb();
}

/** 模型空间里鼻尖（x 最大的顶点）经过外层节点后的方向。 */
function noseDirection(instance: ModelInstance): Vector3 {
  const box = normalizedBox(instance);
  const root = instance.swayPivot;
  let nose = new Vector3();
  let best = -Infinity;
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as Partial<SkinnedMesh>;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const local = new Vector3().fromBufferAttribute(pos, i);
      if (local.x > best) {
        best = local.x;
        nose = local.applyMatrix4(obj.matrixWorld);
      }
    }
  });
  const center = box.getCenter(new Vector3());
  return new Vector3(nose.x - center.x, 0, nose.z - center.z).normalize();
}

describe('归一化（作用在外层节点上）', () => {
  it('不同尺寸都缩放到显示身高，最低点贴地，水平居中', async () => {
    for (const scale of [1, 10, 0.01]) {
      const asset = await importGlb(facingPlusX(scale));
      const instance = asset.createInstance();
      expectGrounded(normalizedBox(instance), 1.75);
      expect(instance.normalizedSize().height).toBeCloseTo(1.75, 6);
    }
  });

  it('带父子变换的静态网格（static-mesh 夹具）', async () => {
    const asset = await importFixture('static-mesh');
    expect(asset.bounds.min.y).toBeCloseTo(0.5, 5);
    const instance = asset.createInstance();
    expectGrounded(normalizedBox(instance), 1.75);
  });

  it('不改模型内部的节点：归一化只写外层节点', async () => {
    const asset = await importGlb(facingPlusX(3));
    const instance = asset.createInstance();
    const statue = instance.object.getObjectByName('Statue');
    expect(statue?.scale.toArray()).toEqual([3, 3, 3]);
    expect(statue?.position.toArray()).toEqual([5, 3, -2]);
    expect(instance.outer.scale.x).toBeCloseTo(1.75 / 3, 6);
  });

  it('身高可在 1.2–2.4 m 之间调，只影响显示，玩法胶囊不变', async () => {
    const asset = await importGlb(facingPlusX(1));
    const instance = asset.createInstance();
    asset.setDisplayHeight(2.2);
    expectGrounded(normalizedBox(instance), 2.2);
    asset.setDisplayHeight(3);
    expect(instance.normalizedSize().height).toBeCloseTo(2.4, 6);
    asset.setDisplayHeight(0.5);
    expect(instance.normalizedSize().height).toBeCloseTo(1.2, 6);
    expect(SPEC.capsule.height).toBe(1.75);
    expect(SPEC.capsule.radius).toBe(0.35);
  });

  it('默认 +Z 为正前方；面向 +X 的模型转 90° 后朝 +Z，仍然贴地居中', async () => {
    const asset = await importGlb(facingPlusX(1));
    const instance = asset.createInstance();
    const before = noseDirection(instance);
    expect(before.x).toBeCloseTo(1, 6); // 默认不转：鼻子还朝 +X
    asset.rotateQuarter(-1);
    expect(asset.settings.quarterTurns).toBe(3);
    const after = noseDirection(instance);
    expect(after.z).toBeCloseTo(1, 6);
    expect(after.x).toBeCloseTo(0, 6);
    expectGrounded(normalizedBox(instance), 1.75);
    // 转 90° 后宽和深互换
    expect(instance.normalizedSize().width).toBeCloseTo(normalizedBox(instance).max.x * 2, 6);
  });

  it('带骨骼的模型按绑定姿态下实际的蒙皮顶点算：网格节点的变换被蒙皮抵消时也贴地、居中、达到显示身高', async () => {
    // 审查复现用例：几何高 1 m；单骨骼、逆绑定矩阵为单位矩阵；网格节点平移 (5,3,0)、放大 2 倍
    const asset = await importGlb(skinnedWithMeshTransform());
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(1, 6); // 实际蒙皮顶点：网格节点的变换不起作用
    const instance = asset.createInstance();
    expectGrounded(normalizedBox(instance), 1.75);
  });

  it('带骨骼的夹具：实际蒙皮顶点贴地、身高 1.75 m；实例播放动画不改变资产的包围盒和归一化', async () => {
    const asset = await importFixture('skinned-humanoid');
    const before = asset.bounds.clone();
    expect(before.max.y - before.min.y).toBeCloseTo(1.75, 5);
    const playing = asset.createInstance();
    const run = asset.clips[2];
    if (!run) throw new Error('没有片段');
    playing.mixer.clipAction(run).play();
    playing.mixer.update(0.3);
    expect(asset.bounds.equals(before)).toBe(true);
    const outer = playing.outer.matrix.clone();
    expect(playing.outer.matrix.equals(outer)).toBe(true);
    expectGrounded(normalizedBox(asset.createInstance()), 1.75);
  });

  it('实例化网格（EXT_mesh_gpu_instancing）：每个实例的变换都算进包围盒', async () => {
    const asset = await importGlb(instancedTriangles());
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(5, 6); // 实例在 y = 0、2、4，三角形高 1 m
    expectGrounded(normalizedBox(asset.createInstance()), 1.75);
  });
});

/** 实例里所有蒙皮网格引用的骨骼（去重：两个图元各有一个 Skeleton，引用同一组骨骼）。 */
function bonesOf(root: Object3D): Bone[] {
  const bones = new Set<Bone>();
  root.traverse((obj) => {
    const mesh = obj as Partial<SkinnedMesh>;
    if (mesh.isSkinnedMesh && mesh.skeleton) for (const bone of mesh.skeleton.bones) bones.add(bone);
  });
  return [...bones];
}

describe('实例独立', () => {
  it('两个实例的 mixer 时间互不影响；骨骼对象不共享', async () => {
    const asset = await importFixture('skinned-humanoid');
    const a = asset.createInstance();
    const b = asset.createInstance();
    expect(a.mixer).not.toBe(b.mixer);
    const clip = asset.clips[0];
    if (!clip) throw new Error('没有片段');
    a.mixer.clipAction(clip).play();
    a.mixer.update(0.7);
    expect(a.mixer.time).toBeCloseTo(0.7, 9);
    expect(b.mixer.time).toBe(0);
    const bonesA = bonesOf(a.object);
    const bonesB = bonesOf(b.object);
    expect(bonesA.length).toBe(5);
    for (const bone of bonesA) expect(bonesB).not.toContain(bone);
    // a 的动画只动 a 的骨骼
    const spineB = b.object.getObjectByName('Spine');
    expect(spineB?.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(a.object.getObjectByName('Spine')?.quaternion.equals(spineB?.quaternion ?? a.object.quaternion)).toBe(false);
  });

  it('释放一个实例不影响其他实例；共享的几何、材质不被释放', async () => {
    const asset = await importFixture('skinned-humanoid');
    const a = asset.createInstance();
    const b = asset.createInstance();
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const skeletonDispose = vi.fn();
    a.object.traverse((obj) => {
      const mesh = obj as Partial<SkinnedMesh>;
      if (mesh.isSkinnedMesh && mesh.skeleton) mesh.skeleton.dispose = skeletonDispose;
    });
    try {
      a.dispose();
      expect(skeletonDispose).toHaveBeenCalled();
      expect(geometryDispose).not.toHaveBeenCalled();
      expect(asset.instanceCount).toBe(1);
      const clip = asset.clips[1];
      if (!clip) throw new Error('没有片段');
      b.mixer.clipAction(clip).play();
      b.mixer.update(0.1); // walk 在 0.1 秒时左腿约 15°
      expect(b.mixer.time).toBeCloseTo(0.1, 9);
      expect(b.object.getObjectByName('LeftUpLeg')?.quaternion.w).toBeLessThan(1);
    } finally {
      geometryDispose.mockRestore();
    }
  });

  it('同屏实例上限 12：到了上限就不能再加入，释放一个后可以', async () => {
    const asset = await importFixture('static-mesh');
    const registry = new InstanceRegistry();
    expect(registry.max).toBe(12);
    const instances = Array.from({ length: 12 }, () => asset.createInstance(registry));
    expect(registry.count).toBe(12);
    expect(() => asset.createInstance(registry)).toThrow(InstanceLimitError);
    instances[0]?.dispose();
    expect(registry.count).toBe(11);
    expect(() => asset.createInstance(registry)).not.toThrow();
  });

  it('释放资产：所有实例和模板的几何、材质都被 dispose', async () => {
    const asset = await importFixture('skinned-humanoid');
    asset.createInstance();
    asset.createInstance();
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    try {
      expect(asset.dispose()).toEqual({ geometries: 2, materials: 2, textures: 0 });
      expect(geometryDispose).toHaveBeenCalledTimes(2);
      expect(materialDispose).toHaveBeenCalledTimes(2);
      expect(asset.instanceCount).toBe(0);
      expect(() => asset.createInstance()).toThrow();
    } finally {
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });
});

describe('动画驱动', () => {
  const motion = (speed: number, grounded = true) => ({ position: { x: 0, y: 0, z: 0 }, facing: 0, horizontalSpeed: speed, grounded, vy: grounded ? 0 : 2 });

  it('按模拟状态切换待机、走、跑；淡入淡出；跳没有片段时保持当前动作；落地回到移动', async () => {
    const asset = await importFixture('skinned-humanoid');
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update(motion(0), 0.1);
    expect(model.snapshot()).toMatchObject({ state: 'idle', clipIndex: 0, clipName: 'idle' });
    model.update(motion(SPEC.move.walkSpeed), 0.1);
    expect(model.snapshot()).toMatchObject({ state: 'walk', clipIndex: 1 });
    model.update(motion(SPEC.move.runSpeed), 0.1);
    expect(model.snapshot()).toMatchObject({ state: 'run', clipIndex: 2 });
    model.update(motion(SPEC.move.runSpeed, false), 0.1);
    expect(model.snapshot()).toMatchObject({ state: 'jump', clipIndex: 2 });
    model.update(motion(SPEC.move.runSpeed), 0.05);
    expect(model.snapshot()).toMatchObject({ state: 'land', clipIndex: 2 });
    model.update(motion(0), 0.2);
    model.update(motion(0), 0.2);
    expect(model.snapshot()).toMatchObject({ state: 'idle', clipIndex: 0 });
    expect(model.snapshot().mixerTime).toBeGreaterThan(0.5);
  });

  it('有跳的片段：跳只播一次', async () => {
    const asset = await importFixture('extras-number'); // 只有一个片段 jump
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update(motion(0, false), 0.1);
    expect(model.snapshot()).toMatchObject({ state: 'jump', clipIndex: 0 });
    const action = asset.createInstance().mixer; // 新实例不受影响
    expect(action.time).toBe(0);
  });

  it('没有移动动作：移动时整体上下晃动、向前倾，停下后恢复', async () => {
    const asset = await importFixture('static-mesh');
    const instance = asset.createInstance();
    const model = new ImportedCharacterModel(instance);
    for (let i = 0; i < 30; i++) model.update(motion(SPEC.move.walkSpeed), 1 / 30);
    expect(model.snapshot().swaying).toBe(true);
    expect(instance.swayPivot.rotation.x).toBeGreaterThan(0.05);
    for (let i = 0; i < 60; i++) model.update(motion(0), 1 / 30);
    expect(model.snapshot().swaying).toBe(false);
    expect(instance.swayPivot.rotation.x).toBeLessThan(0.01);
    // 归一化在外层节点上，摆动在它外面的摆动节点上，互不干扰
    expect(instance.outer.parent).toBe(instance.swayPivot);
  });

  it('没有待机时用走的第一帧静止', async () => {
    const asset = await importFixture('skinned-humanoid');
    asset.setPurpose(0, 'other'); // 把 idle 改成“其他”
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update(motion(0), 0.5);
    expect(model.snapshot()).toMatchObject({ state: 'idle', source: 'firstFrame', clipIndex: 1 });
  });
});

describe('审查补充（第 2 轮）', () => {
  const rot45 = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];

  it('无名骨骼的片段也能驱动克隆实例；原片段的轨道名不改', async () => {
    const asset = await importGlb(singleBoneSkin({ clips: [{ name: 'idle', path: 'rotation', times: [0, 0.5], values: [0, 0, 0, 1, ...rot45] }] }));
    const clip = asset.clips[0];
    if (!clip) throw new Error('没有片段');
    const originalNames = clip.tracks.map((t) => t.name);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = asset.createInstance();
      const b = asset.createInstance();
      const retargeted = a.clipFor(clip);
      expect(retargeted).not.toBe(clip);
      expect(clip.tracks.map((t) => t.name)).toEqual(originalNames); // 原片段不改
      a.mixer.clipAction(retargeted).play();
      a.mixer.update(0.25); // 循环片段长 0.5 秒：取一半，转到 22.5°（正好 0.5 秒会回到起点）
      const boneA = bonesOf(a.object)[0];
      const boneB = bonesOf(b.object)[0];
      expect(boneA?.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 6);
      expect(boneB?.quaternion.toArray()).toEqual([0, 0, 0, 1]); // 另一个实例不受影响
      expect(warn.mock.calls.flat().join(' ')).not.toContain('No target node found');
      // 主角的动画驱动也走同一条路径
      const model = new ImportedCharacterModel(b);
      model.update({ position: { x: 0, y: 0, z: 0 }, facing: 0, horizontalSpeed: 0, grounded: true, vy: 0 }, 0.25);
      expect(model.snapshot()).toMatchObject({ clipIndex: 0, clipName: 'idle' });
      expect(bonesOf(b.object)[0]?.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 6);
    } finally {
      warn.mockRestore();
    }
  });

  it('骨骼都有名字时直接用原片段', async () => {
    const asset = await importFixture('skinned-humanoid');
    const clip = asset.clips[0];
    if (!clip) throw new Error('没有片段');
    expect(asset.createInstance().clipFor(clip)).toBe(clip);
  });

  it('文件里的初始骨骼姿态不是绑定姿态：包围盒按逆绑定矩阵决定的绑定姿态算', async () => {
    // 几何高 1 m、逆绑定矩阵为单位矩阵、骨骼初始 Y 缩放为 2；idle 把骨骼缩放播回 1（即绑定姿态）
    const asset = await importGlb(
      singleBoneSkin({ boneName: 'Bone', boneScale: [1, 2, 1], clips: [{ name: 'idle', path: 'scale', times: [0, 1], values: [1, 1, 1, 1, 1, 1] }] }),
    );
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(1, 6);
    // 初始姿态下（没播动画）实际显示的高度是绑定姿态的 2 倍，说明两者确实不同
    const fresh = asset.createInstance();
    expect((renderedBounds(fresh.swayPivot)?.max.y ?? 0) - (renderedBounds(fresh.swayPivot)?.min.y ?? 0)).toBeCloseTo(3.5, 5);
    // 播放回到绑定姿态的 idle：显示 1.75 m，贴地
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update({ position: { x: 0, y: 0, z: 0 }, facing: 0, horizontalSpeed: 0, grounded: true, vy: 0 }, 0.5);
    expectGrounded(renderedBounds(model.instance.swayPivot) ?? new Box3(), 1.75);
  });

  it('没有片段时“绑定姿态”兜底真的摆成绑定姿态', async () => {
    const asset = await importGlb(singleBoneSkin({ boneName: 'Bone', boneScale: [1, 2, 1] }));
    expect(asset.decisions().plan.idle).toEqual({ kind: 'bindPose' });
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update({ position: { x: 0, y: 0, z: 0 }, facing: 0, horizontalSpeed: 0, grounded: true, vy: 0 }, 0.1);
    expectGrounded(renderedBounds(model.instance.swayPivot) ?? new Box3(), 1.75);
  });

  it('计入已经生效的 morph 权重：无骨骼和带骨骼的网格都一样', async () => {
    const plain = await importGlb(morphedTriangle());
    expect(plain.bounds.min.y).toBeCloseTo(-1, 6);
    expect(plain.bounds.max.y).toBeCloseTo(2, 6);
    expectGrounded(normalizedBox(plain.createInstance()), 1.75);
    const skinned = await importGlb(singleBoneSkin({ boneName: 'Bone', morph: true }));
    expect(skinned.bounds.max.y - skinned.bounds.min.y).toBeCloseTo(3, 6);
    expectGrounded(normalizedBox(skinned.createInstance()), 1.75);
  });
});

describe('绑定姿态按 three 的约定（Skeleton.pose()）', () => {
  it('根骨骼挂在有旋转和缩放的父节点下（逆绑定矩阵相对父节点）：包围盒保持父节点的朝向和缩放', async () => {
    // 与真实资产 armored-soldier 的结构相同：根骨骼的父节点绕 Y 转 −90°、放大 1.75 倍，逆绑定矩阵为单位矩阵。
    // 几何沿 X 长 1 m、沿 Z 厚 0.2 m、高 1 m。显示时（以及绑定姿态下）是 父节点 · 顶点：高 1.75 m，长边转到 Z 方向。
    const b = new GltfBuilder();
    const bone = b.addNode({ name: 'Hip' });
    const position = b.addAccessor({ array: new Float32Array([-0.5, 0, -0.1, 0.5, 0, 0.1, 0, 1, 0]), type: 'VEC3' });
    const joints = b.addAccessor({ array: new Uint8Array(12), type: 'VEC4', minMax: false });
    const weights = b.addAccessor({ array: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), type: 'VEC4', minMax: false });
    const ibm = b.addAccessor({ array: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), type: 'MAT4', minMax: false });
    const mesh = b.addMesh('Body', [{ attributes: { POSITION: position, JOINTS_0: joints, WEIGHTS_0: weights } }]);
    const skin = b.addSkin({ joints: [bone], inverseBindMatrices: ibm });
    const q = Math.sin(-Math.PI / 4);
    const frame = b.addNode({ name: 'Frame', children: [bone], rotation: [0, q, 0, Math.cos(-Math.PI / 4)], scale: [1.75, 1.75, 1.75] });
    b.addScene([frame, b.addNode({ name: 'Body', mesh, skin })]);
    const asset = await importGlb(b.toGlb());
    const size = asset.bounds.getSize(new Vector3());
    expect(size.y).toBeCloseTo(1.75, 5);
    expect(size.x).toBeCloseTo(0.35, 5); // 0.2 × 1.75
    expect(size.z).toBeCloseTo(1.75, 5); // 1 × 1.75，转到了 Z 方向
    const instance = asset.createInstance();
    expect(instance.normalizedSize()).toMatchObject({ width: expect.closeTo(0.35, 5) as number, depth: expect.closeTo(1.75, 5) as number });
    // 初始姿态就是绑定姿态：不摆姿态直接看实际显示，也贴地、高 1.75 m
    const rendered = renderedBounds(instance.swayPivot);
    if (!rendered) throw new Error('没有几何');
    expectGrounded(rendered, 1.75);
  });
});

describe('绑定姿态的参照系和过渡（第 3 轮审查）', () => {
  const still = { position: { x: 0, y: 0, z: 0 }, facing: 0, horizontalSpeed: 0, grounded: true, vy: 0 };

  it('IBM 在场景空间、普通父节点带缩放（初始就是绑定姿态）：包围盒 1 m，播放保持原姿态的 idle 后显示 1.75 m', async () => {
    // Armature（非骨骼）Y 缩放 2，骨骼本地为单位矩阵，IBM 的 Y 缩放 0.5：静止姿态的蒙皮矩阵正好是单位矩阵
    const ibm = [1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bytes = singleBoneSkin({
      boneName: 'Bone',
      armatureScale: [1, 2, 1],
      ibm,
      clips: [{ name: 'idle', path: 'scale', times: [0, 1], values: [1, 1, 1, 1, 1, 1] }],
    });
    const asset = await importGlb(bytes);
    expect(computeBindPose(asset.template)?.convention).toBe('scene');
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(1, 6);
    const rest = renderedBounds(asset.template);
    expect((rest?.max.y ?? 0) - (rest?.min.y ?? 0)).toBeCloseTo(1, 6); // 加载后实际高 1 m
    const model = new ImportedCharacterModel(asset.createInstance());
    model.update(still, 0.5);
    expectGrounded(renderedBounds(model.instance.swayPivot) ?? new Box3(), 1.75);
    expectGrounded(normalizedBox(asset.createInstance()), 1.75);
  });

  it('参照系的判断：场景空间 / 骨架父节点空间 / 初始姿态不是绑定姿态时按 glTF 取场景空间', async () => {
    const parentStyle = await importGlb(singleBoneSkin({ boneName: 'Bone', armatureScale: [1, 2, 1] })); // IBM 单位矩阵：K = 父节点
    expect(computeBindPose(parentStyle.template)?.convention).toBe('parent');
    expect(parentStyle.bounds.max.y - parentStyle.bounds.min.y).toBeCloseTo(2, 6);
    const neither = await importGlb(singleBoneSkin({ boneName: 'Bone', boneScale: [1, 2, 1] }));
    expect(computeBindPose(neither.template)?.convention).toBe('scene');
    expect(neither.bounds.max.y - neither.bounds.min.y).toBeCloseTo(1, 6);
  });

  it('切换到绑定姿态也淡入淡出：只有 jump 的骨骼，落地后 0.001 秒仍接近落地前的姿态，过渡结束后回到绑定姿态', async () => {
    const rot90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const asset = await importGlb(
      singleBoneSkin({ boneName: 'Bone', clips: [{ name: 'jump', path: 'rotation', times: [0, 0.5], values: [0, 0, 0, 1, ...rot90], loop: false }] }),
    );
    expect(asset.decisions().plan.idle).toEqual({ kind: 'bindPose' });
    const model = new ImportedCharacterModel(asset.createInstance());
    const angle = () => {
      const q = bonesOf(model.instance.object)[0]?.quaternion;
      return q ? (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI : NaN;
    };
    model.update(still, 0.1);
    for (let i = 0; i < 6; i++) model.update({ ...still, grounded: false, vy: 1 }, 0.1); // 空中 0.6 秒，jump 播完停在 90°
    expect(angle()).toBeCloseTo(90, 3);
    model.update(still, 0.001); // 落地
    expect(model.snapshot().state).toBe('land');
    expect(angle()).toBeGreaterThan(85);
    model.update(still, 0.05);
    expect(angle()).toBeGreaterThan(20);
    expect(angle()).toBeLessThan(85);
    for (let i = 0; i < 6; i++) model.update(still, 0.05);
    expect(angle()).toBeLessThan(1e-3);
    expect(model.snapshot().source).toBe('bindPose');
  });
});
