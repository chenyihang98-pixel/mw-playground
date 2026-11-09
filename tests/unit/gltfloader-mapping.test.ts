// 把“原始 animation.extras”和“加载后 clip.userData”的对应关系固定在锁定的 three 版本上。
// 在 vitest 的 Node 环境里用 GLTFLoader.parse 加载不含贴图的夹具，不需要环境补丁
// （没有贴图时 GLTFLoader 不会用到 Image / createImageBitmap / URL.createObjectURL）。

import { REVISION } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixture, toArrayBuffer, type FixtureId } from '../../src/asset/fixtures';
import { inspectGlb, type InspectReport } from '../../src/asset/inspect';

const LOADABLE: readonly FixtureId[] = [
  'skinned-humanoid',
  'loop-false',
  'loop-string',
  'extras-number',
  'duplicate-names',
  'unnamed-clips',
  'root-motion',
  'node-animation',
  'static-mesh',
];

async function load(id: FixtureId): Promise<{ gltf: GLTF; report: InspectReport }> {
  const bytes = buildFixture(id);
  const result = inspectGlb(bytes);
  if (!result.ok) throw new Error(result.error.message);
  const gltf = await new GLTFLoader().parseAsync(toArrayBuffer(bytes), '');
  return { gltf, report: result.report };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('锁定的 three 版本是 r187', () => {
  expect(REVISION).toBe('187');
});

describe.each(LOADABLE)('%s', (id) => {
  it('clip.userData.loop 与检查报告里的原始 extras.loop 一致；片段名与报告的加载后名字一致', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gltf, report } = await load(id);
    const animations = report.animations.animations;
    expect(gltf.animations.map((clip) => clip.name)).toEqual(animations.map((a) => a.loaderName));
    gltf.animations.forEach((clip, i) => {
      const loop = animations[i]?.loop;
      switch (loop?.kind) {
        case 'true':
          expect(clip.userData.loop).toBe(true);
          break;
        case 'false':
          expect(clip.userData.loop).toBe(false);
          break;
        case 'missing':
          expect(Object.hasOwn(clip.userData, 'loop')).toBe(false);
          break;
        case 'other':
          expect(clip.userData.loop).toStrictEqual(loop.value);
          break;
        default:
          throw new Error(`animations[${i}] 没有报告`);
      }
      const actual = animations[i]?.duration.actual;
      if (actual?.status === 'computed') expect(clip.duration).toBeCloseTo(actual.value, 5);
    });
  });
});

describe('逐项固定', () => {
  it('loop 缺失时 clip.userData 里没有 loop；true / false 原样合并', async () => {
    const { gltf } = await load('skinned-humanoid');
    const [idle, walk, run] = gltf.animations;
    expect(idle?.userData).toEqual({ designed: true, loop: true });
    expect(walk?.userData).toEqual({ designed: true, loop: true });
    expect(run?.userData).toEqual({ designed: true });
    expect(run && Object.hasOwn(run.userData, 'loop')).toBe(false);
    const { gltf: falseGltf } = await load('loop-false');
    expect(falseGltf.animations[0]?.userData).toEqual({ designed: true, loop: false });
  });

  it('非布尔的 loop 原样进入 clip.userData.loop', async () => {
    const { gltf } = await load('loop-string');
    expect(gltf.animations[0]?.userData.loop).toBe('yes');
  });

  it('extras 不是对象：GLTFLoader 只打警告，不合并，clip.userData 为空', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gltf } = await load('extras-number');
    expect(gltf.animations[0]?.userData).toEqual({});
    expect(warn).toHaveBeenCalledWith('THREE.GLTFLoader: Ignoring primitive type .extras, 42');
  });

  it('无名片段（没有 name 或 name 为空字符串）加载后名为 animation_<序号>', async () => {
    const { gltf } = await load('unnamed-clips');
    expect(gltf.animations.map((c) => c.name)).toEqual(['named', 'animation_1', 'animation_2']);
  });

  it('同名片段加载后仍是两个独立的片段', async () => {
    const { gltf } = await load('duplicate-names');
    expect(gltf.animations.map((c) => c.name)).toEqual(['idle', 'idle', 'walk']);
    expect(gltf.animations[0]).not.toBe(gltf.animations[1]);
  });

  it('带骨骼的夹具加载出 SkinnedMesh 和 5 根骨骼', async () => {
    const { gltf } = await load('skinned-humanoid');
    let skinned = 0;
    let bones = 0;
    gltf.scene.traverse((obj) => {
      if ((obj as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned++;
      if ((obj as { isBone?: boolean }).isBone) bones++;
    });
    expect(skinned).toBeGreaterThan(0);
    expect(bones).toBe(5);
  });
});
