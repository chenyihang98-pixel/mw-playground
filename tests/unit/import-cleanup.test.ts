// 加载之后的任何一步出错（包括意外的异常），都要释放已经加载的几何和材质。

import { BufferGeometry, Material } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixture } from '../../src/asset/fixtures';
import { importBytes, singleBoneSkin } from '../helpers/import';

const failBounds = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/import/normalize', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/import/normalize')>();
  return {
    ...original,
    bindPoseBounds: (root: Parameters<typeof original.bindPoseBounds>[0]) => {
      if (failBounds.on) throw new Error('模拟的意外异常');
      return original.bindPoseBounds(root);
    },
  };
});

afterEach(() => {
  failBounds.on = false;
  vi.restoreAllMocks();
});

describe('加载后的异常路径', () => {
  it('关节索引超出骨骼数量（只有 1 个关节，JOINTS_0 引用 1）：友好地拒绝，并释放几何和材质', async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const outcome = await importBytes('bad-joint.glb', singleBoneSkin({ boneName: 'Bone', jointIndex: 1 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('postcheck');
      expect(outcome.error).toContain('引用了不存在的骨骼');
    }
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('加载之后的步骤抛出意外异常：返回错误，并释放已经加载的资源', async () => {
    failBounds.on = true;
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const outcome = await importBytes('humanoid.glb', buildFixture('skinned-humanoid'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('模拟的意外异常');
    expect(geometryDispose).toHaveBeenCalledTimes(2);
    expect(materialDispose).toHaveBeenCalledTimes(2);
  });

  it('没有出错时照常导入', async () => {
    const outcome = await importBytes('humanoid.glb', buildFixture('skinned-humanoid'));
    expect(outcome.ok).toBe(true);
  });
});
