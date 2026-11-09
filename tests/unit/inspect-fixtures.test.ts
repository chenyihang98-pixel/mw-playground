// 对每个代码生成的夹具运行结构检查，逐项核对报告字段。

import { describe, expect, it } from 'vitest';
import { FIXTURE_IDS, buildFixture, type FixtureId } from '../../src/asset/fixtures';
import {
  formatInspectReport,
  inspectGlb,
  type AnimationReport,
  type Box3,
  type InspectError,
  type InspectReport,
  type Metric,
} from '../../src/asset/inspect';

function report(id: FixtureId): InspectReport {
  const result = inspectGlb(buildFixture(id));
  if (!result.ok) throw new Error(`${id} 应该能检查：${result.error.message}`);
  return result.report;
}

function failure(id: FixtureId): InspectError {
  const result = inspectGlb(buildFixture(id));
  if (result.ok) throw new Error(`${id} 应该检查失败`);
  return result.error;
}

function value<T>(m: Metric<T>): T {
  if (m.status !== 'computed') throw new Error(`应为已计算，实际未计算：${m.reason}`);
  return m.value;
}

function reasonOf(m: Metric<unknown>): string {
  if (m.status !== 'not-computed') throw new Error(`应为未计算，实际值：${JSON.stringify(m.value)}`);
  return m.reason;
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`没有第 ${index} 项`);
  return item;
}

function anim(r: InspectReport, index: number): AnimationReport {
  const a = r.animations.animations[index];
  if (!a) throw new Error(`没有 animations[${index}]`);
  return a;
}

function expectBox(box: Box3, min: [number, number, number], max: [number, number, number]) {
  min.forEach((v, k) => {
    expect(box.min[k]).toBeCloseTo(v, 5);
  });
  max.forEach((v, k) => {
    expect(box.max[k]).toBeCloseTo(v, 5);
  });
}

function expectCommonContainer(r: InspectReport, id: FixtureId) {
  const size = buildFixture(id).byteLength;
  expect(r.container.fileSize).toBe(size);
  expect(r.container.version).toBe(2);
  expect(r.container.declaredLength).toBe(size);
  expect(r.container.actualLength).toBe(size);
  expect(r.container.lengthMatches).toBe(true);
  expect(r.asset).toEqual({ generator: 'mw-playground fixture writer', version: '2.0', minVersion: null });
}

describe('夹具生成器', () => {
  it('每个夹具的生成结果是确定的（两次生成字节相同）', () => {
    for (const id of FIXTURE_IDS) expect(buildFixture(id)).toEqual(buildFixture(id));
  });
});

describe('skinned-humanoid：带骨骼，idle / walk / run', () => {
  const r = report('skinned-humanoid');

  it('容器、资产、扩展、外部资源', () => {
    expectCommonContainer(r, 'skinned-humanoid');
    expect(r.container.chunks.map((c) => c.type)).toEqual(['JSON', 'BIN']);
    expect(r.extensionsUsed).toEqual([]);
    expect(r.extensionsRequired).toEqual([]);
    expect(r.externalResources).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('网格、贴图、蒙皮', () => {
    expect(r.meshes.meshCount).toBe(1);
    expect(r.meshes.primitiveCount).toBe(2);
    expect(value(r.meshes.triangles)).toBe(60);
    expect(r.textures).toEqual({ textureCount: 0, imageCount: 0, images: [] });
    expect(r.skins.count).toBe(1);
    expect(r.skins.skins[0]).toMatchObject({ name: 'Armature', jointCount: 5 });
  });

  it('三个片段：名字、通道数、时长（声明与实际分开）、loop true / true / 缺失', () => {
    expect(r.animations.count).toBe(3);
    expect(r.animations.animations.map((a) => a.rawName)).toEqual(['idle', 'walk', 'run']);
    expect(r.animations.animations.map((a) => a.channelCount)).toEqual([2, 2, 3]);
    const durations = [2, 1, 0.6];
    durations.forEach((d, i) => {
      expect(value(anim(r, i).duration.declared)).toBeCloseTo(d, 5);
      expect(value(anim(r, i).duration.actual)).toBeCloseTo(d, 5);
    });
    expect(anim(r, 0).loop).toEqual({ kind: 'true' });
    expect(anim(r, 1).loop).toEqual({ kind: 'true' });
    expect(anim(r, 2).loop).toEqual({ kind: 'missing', reason: 'no-loop-key' });
    expect(r.animations.animations.every((a) => a.extras.kind === 'object')).toBe(true);
    expect(r.animations.duplicateNames).toEqual([]);
  });

  it('包围盒：身高 1.75 m，脚底在 0，鼻子朝 +Z', () => {
    expect(r.bounds.basis).toBe('scenes[0]');
    const declared = value(r.bounds.declared);
    expectBox(declared, [-0.2, 0, -0.11], [0.2, 1.75, 0.16]);
    expect(declared.size[1]).toBeCloseTo(1.75, 5);
    expectBox(value(r.bounds.actual), [-0.2, 0, -0.11], [0.2, 1.75, 0.16]);
  });
});

describe('loop 的四种情况分别报告，false 和缺失不混淆', () => {
  it('true / false / 缺失 / 非布尔', () => {
    expect(anim(report('skinned-humanoid'), 0).loop).toEqual({ kind: 'true' });
    expect(anim(report('loop-false'), 0).loop).toEqual({ kind: 'false' });
    expect(anim(report('skinned-humanoid'), 2).loop).toEqual({ kind: 'missing', reason: 'no-loop-key' });
    expect(anim(report('loop-string'), 0).loop).toEqual({ kind: 'other', valueType: 'string', value: 'yes' });
  });

  it('文本报告里 false 和缺失写法不同，并注明加载后对应 clip.userData.loop', () => {
    const falseText = formatInspectReport(report('loop-false'));
    const missingText = formatInspectReport(report('skinned-humanoid'));
    expect(falseText).toContain('extras.loop（原始）：false（boolean）');
    expect(missingText).toContain('extras.loop（原始）：缺失（extras 里没有 loop）');
    expect(falseText).not.toContain('缺失');
    for (const text of [falseText, missingText]) {
      expect(text).toContain('加载后对应 clip.userData.loop（three r187 GLTFLoader）');
    }
    expect(formatInspectReport(report('loop-string'))).toContain('extras.loop（原始）：其他类型：string，原值 "yes"');
  });
});

describe('loop-false', () => {
  const r = report('loop-false');
  it('一个片段 wave，loop 为 false', () => {
    expectCommonContainer(r, 'loop-false');
    expect(r.animations.count).toBe(1);
    expect(anim(r, 0)).toMatchObject({ rawName: 'wave', unnamed: false, loaderName: 'wave', channelCount: 1 });
    expect(anim(r, 0).extras).toEqual({ kind: 'object' });
    expect(anim(r, 0).loop).toEqual({ kind: 'false' });
    expect(r.skins.count).toBe(0);
  });
});

describe('loop-string', () => {
  it('loop 是字符串 "yes"：列出类型和原值', () => {
    const r = report('loop-string');
    expect(anim(r, 0).rawName).toBe('dance');
    expect(anim(r, 0).loop).toEqual({ kind: 'other', valueType: 'string', value: 'yes' });
  });
});

describe('extras-number', () => {
  const r = report('extras-number');
  it('extras 不是对象：报告类型和原值，loop 记为缺失（extras 不是对象）', () => {
    expect(anim(r, 0).extras).toEqual({ kind: 'not-object', valueType: 'number', value: 42 });
    expect(anim(r, 0).loop).toEqual({ kind: 'missing', reason: 'extras-not-object' });
    const text = formatInspectReport(r);
    expect(text).toContain('extras：不是对象（number：42）');
    expect(text).toContain('extras.loop（原始）：缺失（extras 不是对象）');
  });
});

describe('duplicate-names', () => {
  const r = report('duplicate-names');
  it('两个 idle 被标出来，walk 不受影响', () => {
    expect(r.animations.animations.map((a) => a.rawName)).toEqual(['idle', 'idle', 'walk']);
    expect(r.animations.duplicateNames).toEqual([{ name: 'idle', indices: [0, 1] }]);
    expect(anim(r, 0).duplicateOf).toEqual([1]);
    expect(anim(r, 1).duplicateOf).toEqual([0]);
    expect(anim(r, 2).duplicateOf).toEqual([]);
    expect(anim(r, 1).loop).toEqual({ kind: 'false' });
    const text = formatInspectReport(r);
    expect(text).toContain('#1 "idle"  ⚠ 重名：与 #0 加载后同名');
  });
});

describe('unnamed-clips', () => {
  const r = report('unnamed-clips');
  it('没有 name 字段和 name 为空字符串都算无名，加载后为 animation_<序号>', () => {
    expect(anim(r, 0)).toMatchObject({ rawName: 'named', unnamed: false, loaderName: 'named' });
    expect(anim(r, 1)).toMatchObject({ rawName: null, unnamed: true, loaderName: 'animation_1' });
    expect(anim(r, 2)).toMatchObject({ rawName: '', unnamed: true, loaderName: 'animation_2' });
    const text = formatInspectReport(r);
    expect(text).toContain('#1 无名；GLTFLoader 加载后为 animation_1');
    expect(text).toContain('#2 无名（name 是空字符串）；GLTFLoader 加载后为 animation_2');
    expect(r.animations.duplicateNames).toEqual([]);
  });
});

describe('root-motion', () => {
  const r = report('root-motion');
  it('Hips 的 translation 轨道在 2 秒内水平移动 2 m', () => {
    expect(r.animations.count).toBe(1);
    const a = anim(r, 0);
    expect(a.rawName).toBe('walk_forward');
    expect(a.loop).toEqual({ kind: 'true' });
    expect(value(a.duration.actual)).toBeCloseTo(2, 5);
    expect(a.horizontalMotion).toHaveLength(1);
    const motion = at(a.horizontalMotion, 0);
    expect(motion.nodeName).toBe('Hips');
    // 新口径（F1）：模型空间，各关键帧相对首帧的最大水平距离
    expect(motion.interpolation).toBe('LINEAR');
    const d = value(motion.displacement);
    expect(d.maxDistance).toBeCloseTo(2, 5);
    expect(d.atKeyframe).toBe(2);
    expect(d.keyframes).toBe(3);
    expect(d.first).toEqual([0, 0]);
    expect(r.skins.count).toBe(1);
  });
});

describe('node-animation', () => {
  const r = report('node-animation');
  it('无骨骼的节点动画：spin（rotation）和 bob（translation，只有竖直位移）', () => {
    expect(r.skins.count).toBe(0);
    expect(r.animations.animations.map((a) => a.rawName)).toEqual(['spin', 'bob']);
    expect(anim(r, 0).targetPaths).toEqual({ rotation: 1 });
    expect(anim(r, 1).targetPaths).toEqual({ translation: 1 });
    expect(value(anim(r, 0).duration.actual)).toBeCloseTo(2, 5);
    expect(value(anim(r, 1).duration.actual)).toBeCloseTo(1, 5);
    // 竖直往返的位移按 XZ 计算确实是 0（已计算），和“未计算”不同。
    expect(value(at(anim(r, 1).horizontalMotion, 0).displacement).maxDistance).toBe(0);
  });
});

describe('static-mesh', () => {
  const r = report('static-mesh');
  it('没有动画；包围盒包含父子节点的平移、旋转、缩放', () => {
    expect(r.animations).toEqual({ count: 0, animations: [], duplicateNames: [] });
    expect(r.skins.count).toBe(0);
    expect(r.meshes).toMatchObject({ meshCount: 1, primitiveCount: 1 });
    expect(value(r.meshes.triangles)).toBe(12);
    expectBox(value(r.bounds.declared), [0.5, 0.5, -3], [1.5, 2.5, -1]);
    expectBox(value(r.bounds.actual), [0.5, 0.5, -3], [1.5, 2.5, -1]);
  });
});

describe('textured', () => {
  const r = report('textured');
  it('从内嵌 PNG（bufferView）和 JPEG（data URI）的文件头读出尺寸；data URI 不算外部资源', () => {
    expect(r.textures.textureCount).toBe(2);
    expect(r.textures.imageCount).toBe(2);
    expect(r.textures.images[0]).toMatchObject({ source: 'bufferView', declaredMimeType: 'image/png', detectedFormat: 'png' });
    expect(value(at(r.textures.images, 0).size)).toEqual({ width: 4, height: 2 });
    expect(r.textures.images[1]).toMatchObject({ source: 'data-uri', detectedFormat: 'jpeg' });
    expect(value(at(r.textures.images, 1).size)).toEqual({ width: 16, height: 8 });
    expect(r.externalResources).toEqual([]);
  });
});

describe('external-buffer', () => {
  const r = report('external-buffer');
  it('列出外部 buffer 和外部图片，不读取', () => {
    expect(r.externalResources).toEqual([
      { kind: 'buffer', index: 0, uri: 'fixture-external.bin' },
      { kind: 'image', index: 0, uri: 'textures/fixture-albedo.png' },
    ]);
    expect(r.container.chunks.map((c) => c.type)).toEqual(['JSON']);
  });

  it('依赖 BIN 数据的实际值写“未计算”和原因，不是 0；只依赖 JSON 的声明值照常计算', () => {
    expect(reasonOf(r.bounds.actual)).toContain('外部文件 "fixture-external.bin"');
    expectBox(value(r.bounds.declared), [-0.4, 0, -0.4], [0.4, 0.8, 0.4]);
    expect(value(r.meshes.triangles)).toBe(12); // 三角面数只用 count，不需要读外部数据
    expect(value(anim(r, 0).duration.declared)).toBe(1);
    expect(reasonOf(anim(r, 0).duration.actual)).toContain('不读取外部资源');
    expect(reasonOf(at(anim(r, 0).horizontalMotion, 0).displacement)).toContain('外部');
    expect(reasonOf(at(r.textures.images, 0).size)).toContain('外部图片');
    const text = formatInspectReport(r);
    expect(text).toContain('实际值（从 BIN 读出的顶点 + 节点静态变换）：未计算（');
  });
});

describe('draco-required', () => {
  const r = report('draco-required');
  it('标出需要解码器的必需扩展', () => {
    expect(r.extensionsRequired).toEqual(['KHR_draco_mesh_compression']);
    expect(r.extensionsUsed).toEqual(['KHR_draco_mesh_compression']);
    expect(formatInspectReport(r)).toContain('extensionsRequired：KHR_draco_mesh_compression（需要解码器：KHR_draco_mesh_compression）');
  });

  it('三角面数和实际包围盒写“未计算”和原因，不是 0', () => {
    expect(at(r.meshes.primitives, 0).compression).toBe('KHR_draco_mesh_compression');
    expect(reasonOf(r.meshes.triangles)).toContain('KHR_draco_mesh_compression');
    expect(reasonOf(r.bounds.actual)).toContain('需要解码器');
    // 声明值只来自访问器的 min/max，可以照常给出
    expectBox(value(r.bounds.declared), [-0.5, 0, -0.5], [0.5, 1, 0.5]);
    const text = formatInspectReport(r);
    expect(text).toMatch(/三角面数.*：未计算（/);
    expect(text).not.toMatch(/三角面数.*：0/);
  });
});

describe('损坏的容器', () => {
  it('magic 错误：明确的错误', () => {
    const error = failure('corrupt-magic');
    expect(error.code).toBe('not-glb');
    expect(error.message).toContain('0x46546c67（"glTF"）');
    expect(error.message).toContain('"gltf"');
  });

  it('文件被截断：明确的错误，写出声明长度和实际长度', () => {
    const error = failure('corrupt-truncated');
    const full = buildFixture('skinned-humanoid').byteLength;
    expect(error.code).toBe('truncated');
    expect(error.message).toContain(`声明长度 ${full} 字节`);
    expect(error.message).toContain(`实际只有 ${Math.floor(full / 2)} 字节`);
  });
});
