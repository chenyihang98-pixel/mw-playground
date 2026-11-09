// 归一化、实例独立、资源释放、实例上限、动画驱动（状态切换和整体摆动）。

import { Box3, BufferGeometry, Material, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GltfBuilder } from '../../src/asset/fixtures';
import { SPEC } from '../../src/game/spec';
import { ImportedCharacterModel } from '../../src/import/animator';
import { InstanceLimitError, InstanceRegistry } from '../../src/import/asset';
import { bindPoseBounds } from '../../src/import/normalize';
import { importFixture, importGlb, instancedTriangles, skinnedWithMeshTransform } from '../helpers/import';

function normalizedBox(root: Object3D): Box3 {
  const box = bindPoseBounds(root);
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
function noseDirection(root: Object3D): Vector3 {
  const box = normalizedBox(root);
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
      expectGrounded(normalizedBox(instance.swayPivot), 1.75);
      expect(instance.normalizedSize().height).toBeCloseTo(1.75, 6);
    }
  });

  it('带父子变换的静态网格（static-mesh 夹具）', async () => {
    const asset = await importFixture('static-mesh');
    expect(asset.bounds.min.y).toBeCloseTo(0.5, 5);
    const instance = asset.createInstance();
    expectGrounded(normalizedBox(instance.swayPivot), 1.75);
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
    expectGrounded(normalizedBox(instance.swayPivot), 2.2);
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
    const before = noseDirection(instance.swayPivot);
    expect(before.x).toBeCloseTo(1, 6); // 默认不转：鼻子还朝 +X
    asset.rotateQuarter(-1);
    expect(asset.settings.quarterTurns).toBe(3);
    const after = noseDirection(instance.swayPivot);
    expect(after.z).toBeCloseTo(1, 6);
    expect(after.x).toBeCloseTo(0, 6);
    expectGrounded(normalizedBox(instance.swayPivot), 1.75);
    // 转 90° 后宽和深互换
    expect(instance.normalizedSize().width).toBeCloseTo(normalizedBox(instance.swayPivot).max.x * 2, 6);
  });

  it('带骨骼的模型按绑定姿态下实际的蒙皮顶点算：网格节点的变换被蒙皮抵消时也贴地、居中、达到显示身高', async () => {
    // 审查复现用例：几何高 1 m；单骨骼、逆绑定矩阵为单位矩阵；网格节点平移 (5,3,0)、放大 2 倍
    const asset = await importGlb(skinnedWithMeshTransform());
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(1, 6); // 实际蒙皮顶点：网格节点的变换不起作用
    const instance = asset.createInstance();
    // normalizedBox 用 three 的 applyBoneTransform 计算实际显示的顶点
    expectGrounded(normalizedBox(instance.swayPivot), 1.75);
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
    expectGrounded(normalizedBox(asset.createInstance().swayPivot), 1.75);
  });

  it('实例化网格（EXT_mesh_gpu_instancing）：每个实例的变换都算进包围盒', async () => {
    const asset = await importGlb(instancedTriangles());
    expect(asset.bounds.max.y - asset.bounds.min.y).toBeCloseTo(5, 6); // 实例在 y = 0、2、4，三角形高 1 m
    expectGrounded(normalizedBox(asset.createInstance().swayPivot), 1.75);
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
