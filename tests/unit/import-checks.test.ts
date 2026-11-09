// 导入前后的检查：外部引用、压缩扩展、各项上限、大小、损坏的文件、静态模型；超限时释放已加载的资源。

import { BoxGeometry, BufferGeometry, Material, Mesh, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildFixture } from '../../src/asset/fixtures';
import { IMPORT_LIMITS } from '../../src/import/limits';
import { OBJ_MATERIAL_NOTICE } from '../../src/import/load';
import { checkBeforeRead, precheckGlb } from '../../src/import/precheck';
import { disposeObject, loadedStats, postLoadCheck } from '../../src/import/resources';
import { bigTexture, declaredTriangles, importBytes, instancedTriangles, manyBones, manyClips, text } from '../helpers/import';

const MB = 1024 * 1024;

async function errorOf(name: string, bytes: Uint8Array): Promise<string> {
  const outcome = await importBytes(name, bytes);
  if (outcome.ok) throw new Error('应该被拒绝');
  return outcome.error;
}

describe('读取之前', () => {
  it('超过 50 MB 提示，超过 150 MB 拒绝', () => {
    const warn = checkBeforeRead('big.glb', 60 * MB);
    expect(warn.ok).toBe(true);
    expect(warn.warnings.join()).toContain('文件较大');
    const reject = checkBeforeRead('huge.glb', 151 * MB);
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toContain('超过 150.0 MB 的上限');
    expect(checkBeforeRead('ok.glb', 10 * MB).warnings).toEqual([]);
  });

  it('只接受 .glb / .obj / .stl / .ply（不区分大小写）', () => {
    expect(checkBeforeRead('A.GLB', 10).ok).toBe(true);
    expect(checkBeforeRead('a.Obj', 10).ok).toBe(true);
    const fbx = checkBeforeRead('a.fbx', 10);
    expect(fbx.ok).toBe(false);
    if (!fbx.ok) expect(fbx.error).toContain('不支持的文件类型');
    const gltf = checkBeforeRead('a.gltf', 10);
    if (!gltf.ok) expect(gltf.error).toContain('自包含的 GLB');
  });
});

describe('GLB 预检（不经过加载器）', () => {
  it('引用外部资源：拒绝', async () => {
    expect(await errorOf('ext.glb', buildFixture('external-buffer'))).toBe('文件引用了外部资源，请导出为自包含的 GLB');
  });

  it('extensionsRequired 里有本版没接解码器的压缩扩展：拒绝，只说本版不支持', async () => {
    const error = await errorOf('draco.glb', buildFixture('draco-required'));
    expect(error).toBe('本版不支持这种压缩格式：KHR_draco_mesh_compression');
  });

  it('三角面超过 30 万提示，超过 100 万拒绝（声明值）', () => {
    const warn = precheckGlb(declaredTriangles(300_001));
    expect(warn.ok).toBe(true);
    expect(warn.warnings.join()).toContain('三角面较多（300,001）');
    const reject = precheckGlb(declaredTriangles(1_000_001));
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toContain('三角面太多（1,000,001）');
    expect(precheckGlb(declaredTriangles(300_000)).warnings).toEqual([]);
  });

  it('骨骼超过 256：拒绝；256 个可以', () => {
    const reject = precheckGlb(manyBones(257));
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toContain('骨骼太多（257）');
    expect(precheckGlb(manyBones(256)).ok).toBe(true);
  });

  it('片段超过 64：拒绝；64 个可以', () => {
    const reject = precheckGlb(manyClips(65));
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toContain('动画片段太多（65）');
    expect(precheckGlb(manyClips(64)).ok).toBe(true);
  });

  it('贴图边长超过 8192：拒绝', () => {
    const reject = precheckGlb(bigTexture(8193));
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toContain('8193×16');
    expect(precheckGlb(bigTexture(8192)).ok).toBe(true);
  });

  it('损坏的容器：友好的错误', async () => {
    expect(await errorOf('bad.glb', buildFixture('corrupt-truncated'))).toContain('文件损坏或不是合法的 GLB');
    expect(await errorOf('bad.glb', buildFixture('corrupt-magic'))).toContain('文件损坏或不是合法的 GLB');
    expect(await errorOf('model.glb', text('v 0 0 0\nf 1 1 1\n'))).toContain('OBJ');
  });
});

describe('加载之后', () => {
  it('实际三角面数超限：拒绝，并释放已经加载的几何、材质、贴图', () => {
    const geometry = new BoxGeometry();
    const map = new Texture();
    const material = new MeshStandardMaterial({ map });
    const mesh = new Mesh(geometry, material);
    const stats = loadedStats(mesh);
    expect(stats.triangles).toBe(12);
    const limits = { ...IMPORT_LIMITS, trianglesReject: 10 };
    const result = postLoadCheck(stats, limits);
    expect(result.ok).toBe(false);
    const spies = [vi.spyOn(geometry, 'dispose'), vi.spyOn(material, 'dispose'), vi.spyOn(map, 'dispose')];
    expect(disposeObject(mesh)).toEqual({ geometries: 1, materials: 1, textures: 1 });
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('能读到的贴图尺寸超限：拒绝', () => {
    const texture = new Texture({ width: 9000, height: 64 } as unknown as HTMLImageElement);
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: texture }));
    const result = postLoadCheck(loadedStats(mesh));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('9000×64');
  });

  it('导入流程在加载后超限时调用 dispose（静态 STL，限制调小）', async () => {
    const stl = asciiStl(3);
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(MeshStandardMaterial.prototype, 'dispose');
    try {
      const outcome = await importBytes('three.stl', stl, { ...IMPORT_LIMITS, trianglesReject: 2 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.stage).toBe('postcheck');
        expect(outcome.error).toContain('三角面太多（3）');
      }
      expect(geometryDispose).toHaveBeenCalledTimes(1);
      expect(materialDispose).toHaveBeenCalledTimes(1);
    } finally {
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });
});

function asciiStl(triangles: number): Uint8Array {
  let s = 'solid t\n';
  for (let i = 0; i < triangles; i++) {
    s += ` facet normal 0 0 1\n  outer loop\n   vertex ${String(i)} 0 0\n   vertex ${String(i + 1)} 0 0\n   vertex ${String(i)} 1 0\n  endloop\n endfacet\n`;
  }
  return text(`${s}endsolid t\n`);
}

describe('静态模型', () => {
  it('OBJ：不读 MTL，用默认材质，并写明', async () => {
    const outcome = await importBytes('cube.obj', text('mtllib cube.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 3 4\n'));
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.asset.notices).toContain(OBJ_MATERIAL_NOTICE);
    expect(outcome.asset.stats.triangles).toBe(2);
    expect(outcome.asset.clips).toEqual([]);
  });

  it('STL：默认材质', async () => {
    const outcome = await importBytes('tri.stl', asciiStl(2));
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.asset.stats.triangles).toBe(2);
  });

  it('PLY：有顶点颜色就用顶点颜色', async () => {
    const ply = text(
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
        'property uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n' +
        '0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n',
    );
    const outcome = await importBytes('tri.ply', ply);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.asset.notices).toContain('PLY 使用顶点颜色');
    let vertexColors = false;
    outcome.asset.template.traverse((obj) => {
      const mesh = obj as Partial<Mesh>;
      if (mesh.isMesh && !Array.isArray(mesh.material)) vertexColors = (mesh.material as MeshStandardMaterial).vertexColors;
    });
    expect(vertexColors).toBe(true);
  });

  it('损坏的 OBJ / STL：友好的错误', async () => {
    expect(await errorOf('bad.obj', text('this is not an obj file'))).toContain('文件损坏或格式不对');
    expect(await errorOf('bad.stl', new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toContain('文件损坏或格式不对');
  });
});

describe('审查补充：实例化网格、非索引 PLY、校验失败时释放资源', () => {
  it('实例化网格按实际实例数统计三角面，超限时拒绝（一个三角形实例化 3 次，上限 2）', async () => {
    const ok = await importBytes('instanced.glb', instancedTriangles());
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.asset.stats.triangles).toBe(3);
    const rejected = await importBytes('instanced.glb', instancedTriangles(), { ...IMPORT_LIMITS, trianglesReject: 2 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.stage).toBe('postcheck');
      expect(rejected.error).toContain('三角面太多（3）');
    }
  });

  it('面上带 UV 的 PLY：加载器生成的是没有索引的三角网格，照常导入', async () => {
    const ply = text(
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
        'element face 1\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n' +
        '0 0 0\n1 0 0\n0 1 0\n3 0 1 2 6 0 0 1 0 0 1\n',
    );
    const outcome = await importBytes('uv.ply', ply);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.asset.stats.triangles).toBe(1);
    let indexed = true;
    outcome.asset.template.traverse((obj) => {
      const mesh = obj as Partial<Mesh>;
      if (mesh.isMesh && mesh.geometry) indexed = mesh.geometry.index !== null;
    });
    expect(indexed).toBe(false);
  });

  it('只有点的 PLY：拒绝，并释放已经解析出的几何', async () => {
    const ply = text('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    try {
      const outcome = await importBytes('points.ply', ply);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('PLY 里只有点，没有面');
      expect(geometryDispose).toHaveBeenCalledTimes(1);
    } finally {
      geometryDispose.mockRestore();
    }
  });

  it('OBJ 里一个网格正常、一个有 NaN：拒绝，并释放所有已经建好的几何和材质', async () => {
    const obj = text('o good\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no bad\nv nan 0 0\nv 1 0 0\nv 0 1 0\nf 4 5 6\n');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    try {
      const outcome = await importBytes('mixed.obj', obj);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('非法数值');
      expect(geometryDispose).toHaveBeenCalledTimes(2);
      // 第一个网格：OBJLoader 的材质换成默认材质时释放一次，默认材质失败后再释放一次；第二个网格的 OBJLoader 材质释放一次
      expect(materialDispose).toHaveBeenCalledTimes(3);
    } finally {
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });

  it('STL 有 NaN 顶点：拒绝，并释放解析出的几何', async () => {
    const stl = text('solid t\n facet normal 0 0 1\n  outer loop\n   vertex nan 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid t\n');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    try {
      const outcome = await importBytes('nan.stl', stl);
      expect(outcome.ok).toBe(false);
      expect(geometryDispose).toHaveBeenCalledTimes(1);
    } finally {
      geometryDispose.mockRestore();
    }
  });
});
