// 导入测试的辅助：在内存里构造各种 GLB，按导入流程导入（Node 里运行，不需要浏览器）。

import { GltfBuilder, buildFixture, jpegHeaderOnly, type FixtureId } from '../../src/asset/fixtures';
import type { ImportedAsset } from '../../src/import/asset';
import { IMPORT_LIMITS, type ImportLimits } from '../../src/import/limits';
import { importModel, type ImportOutcome } from '../../src/import/pipeline';

export function importBytes(name: string, bytes: Uint8Array, limits: ImportLimits = IMPORT_LIMITS): Promise<ImportOutcome> {
  return importModel({ name, size: bytes.byteLength, read: () => Promise.resolve(bytes) }, limits);
}

export async function importFixture(id: FixtureId): Promise<ImportedAsset> {
  const outcome = await importBytes(`${id}.glb`, buildFixture(id));
  if (!outcome.ok) throw new Error(`${id} 应该能导入：${outcome.error}`);
  return outcome.asset;
}

export async function importGlb(bytes: Uint8Array, name = 'custom.glb'): Promise<ImportedAsset> {
  const outcome = await importBytes(name, bytes);
  if (!outcome.ok) throw new Error(`应该能导入：${outcome.error}`);
  return outcome.asset;
}

/** 一个三角形的网格（可选再挂到别的节点下）。 */
export function triangleMesh(b: GltfBuilder, scale = 1): number {
  const position = b.addAccessor({ array: new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0]), type: 'VEC3' });
  return b.addMesh('Tri', [{ attributes: { POSITION: position } }]);
}

/** 只声明数量、不带数据的网格：POSITION 访问器没有 bufferView（按规范全为 0），用来测声明的三角面上限。 */
export function declaredTriangles(triangles: number): Uint8Array {
  const b = new GltfBuilder();
  const position = b.addAccessorDescriptor({ componentType: 5126, count: triangles * 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] });
  b.addScene([b.addNode({ name: 'Big', mesh: b.addMesh('Big', [{ attributes: { POSITION: position } }]) })]);
  return b.toGlb();
}

export function manyBones(count: number): Uint8Array {
  const b = new GltfBuilder();
  const joints = Array.from({ length: count }, (_, i) => b.addNode({ name: `bone-${String(i)}` }));
  const mesh = triangleMesh(b);
  const skin = b.addSkin({ name: 'Big', joints });
  b.addScene([...joints, b.addNode({ name: 'Body', mesh, skin })]);
  return b.toGlb();
}

export function manyClips(count: number): Uint8Array {
  const b = new GltfBuilder();
  const node = b.addNode({ name: 'N', mesh: triangleMesh(b) });
  b.addScene([node]);
  for (let i = 0; i < count; i++) {
    b.addAnimation({ name: `clip-${String(i)}`, channels: [{ node, path: 'scale', times: [0, 1], values: [1, 1, 1, 2, 2, 2] }] });
  }
  return b.toGlb();
}

export function bigTexture(edge: number): Uint8Array {
  const b = new GltfBuilder();
  const view = b.addBufferView(jpegHeaderOnly(edge, 16));
  const image = b.addImage({ mimeType: 'image/jpeg', bufferView: view });
  const texture = b.addTexture({ source: image });
  const material = b.addMaterial({ pbrMetallicRoughness: { baseColorTexture: { index: texture } } });
  const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), type: 'VEC3' });
  b.addScene([b.addNode({ mesh: b.addMesh('Tex', [{ attributes: { POSITION: position }, material }]) })]);
  return b.toGlb();
}

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
