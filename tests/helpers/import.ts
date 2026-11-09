// 导入测试的辅助：在内存里构造各种 GLB，按导入流程导入（Node 里运行，不需要浏览器）。

import { GltfBuilder, buildFixture, encodeGlb, jpegHeaderOnly, type FixtureId } from '../../src/asset/fixtures';
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

/** 单骨骼的蒙皮网格：几何高 1 m，骨骼和逆绑定矩阵都是单位矩阵，网格节点平移 (5,3,0)、放大 2 倍。 */
export function skinnedWithMeshTransform(): Uint8Array {
  const b = new GltfBuilder();
  const bone = b.addNode({ name: 'Bone' });
  const position = b.addAccessor({ array: new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 1, 0.1]), type: 'VEC3' });
  const joints = b.addAccessor({ array: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), type: 'VEC4', minMax: false });
  const weights = b.addAccessor({ array: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), type: 'VEC4', minMax: false });
  const ibm = b.addAccessor({ array: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), type: 'MAT4', minMax: false });
  const mesh = b.addMesh('Skinned', [{ attributes: { POSITION: position, JOINTS_0: joints, WEIGHTS_0: weights } }]);
  const skin = b.addSkin({ joints: [bone], inverseBindMatrices: ibm });
  const meshNode = b.addNode({ name: 'Body', mesh, skin, translation: [5, 3, 0], scale: [2, 2, 2] });
  b.addScene([bone, meshNode]);
  return b.toGlb();
}

/** 一个高 1 m 的三角形，用 EXT_mesh_gpu_instancing 放在 y = 0、2、4 三处。 */
export function instancedTriangles(): Uint8Array {
  const b = new GltfBuilder();
  const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), type: 'VEC3' });
  const translation = b.addAccessor({ array: new Float32Array([0, 0, 0, 0, 2, 0, 0, 4, 0]), type: 'VEC3' });
  const mesh = b.addMesh('Tri', [{ attributes: { POSITION: position } }]);
  b.addScene([b.addNode({ name: 'Instanced', mesh })]);
  const json = b.json();
  json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
  const nodes = json.nodes as Record<string, unknown>[];
  const node = nodes[0];
  if (node) node.extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: translation } } };
  return encodeGlb(json, b.binary());
}

const IDENTITY_IBM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 单骨骼蒙皮的三角形（高 1 m）；骨骼可选名字和初始缩放；可选片段。 */
export function singleBoneSkin(options: {
  boneName?: string;
  boneScale?: [number, number, number];
  jointIndex?: number;
  morph?: boolean;
  /** 把骨骼挂在一个普通（非骨骼）的 Armature 节点下，这个节点带这个缩放。 */
  armatureScale?: [number, number, number];
  /** 蒙皮网格节点也放在 Armature 下（默认在场景根上）。 */
  meshUnderArmature?: boolean;
  /** 自定义逆绑定矩阵（列主序 16 个数），默认单位矩阵。 */
  ibm?: number[];
  clips?: { name: string; path: 'rotation' | 'scale'; times: number[]; values: number[]; loop?: boolean }[];
}): Uint8Array {
  const b = new GltfBuilder();
  const bone = b.addNode({ ...(options.boneName === undefined ? {} : { name: options.boneName }), ...(options.boneScale ? { scale: options.boneScale } : {}) });
  const position = b.addAccessor({ array: new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 1, 0.1]), type: 'VEC3' });
  const j = options.jointIndex ?? 0;
  const joints = b.addAccessor({ array: new Uint8Array([j, 0, 0, 0, j, 0, 0, 0, j, 0, 0, 0]), type: 'VEC4', minMax: false });
  const weights = b.addAccessor({ array: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), type: 'VEC4', minMax: false });
  const ibm = b.addAccessor({ array: new Float32Array(options.ibm ?? IDENTITY_IBM), type: 'MAT4', minMax: false });
  const morph = options.morph ? b.addAccessor({ array: new Float32Array([0, -1, 0, 0, -1, 0, 0, 1, 0]), type: 'VEC3' }) : null;
  const mesh = b.addMesh('Skinned', [{ attributes: { POSITION: position, JOINTS_0: joints, WEIGHTS_0: weights } }]);
  const skin = b.addSkin({ joints: [bone], inverseBindMatrices: ibm });
  const body = b.addNode({ name: 'Body', mesh, skin });
  const inside = options.meshUnderArmature === true && options.armatureScale !== undefined;
  const top = options.armatureScale ? b.addNode({ name: 'Armature', children: inside ? [bone, body] : [bone], scale: options.armatureScale }) : bone;
  b.addScene(inside ? [top] : [top, body]);
  for (const clip of options.clips ?? []) {
    b.addAnimation({ name: clip.name, extras: { loop: clip.loop ?? true }, channels: [{ node: bone, path: clip.path, times: clip.times, values: clip.values }] });
  }
  const json = b.json();
  if (morph !== null) addMorphTarget(json, morph);
  return encodeGlb(json, b.binary());
}

/** 给第一个网格的第一个图元加一个 morph 目标，默认权重 1。 */
function addMorphTarget(json: Record<string, unknown>, accessor: number): void {
  const meshes = json.meshes as { primitives: Record<string, unknown>[]; weights?: number[] }[];
  const mesh = meshes[0];
  const primitive = mesh?.primitives[0];
  if (!mesh || !primitive) throw new Error('没有网格');
  primitive.targets = [{ POSITION: accessor }];
  mesh.weights = [1];
}

/** 无骨骼的三角形（y ∈ [0, 1]），带一个默认权重为 1 的 morph：把 y 变成 [−1, 2]。 */
export function morphedTriangle(): Uint8Array {
  const b = new GltfBuilder();
  const position = b.addAccessor({ array: new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 1, 0.1]), type: 'VEC3' });
  const morph = b.addAccessor({ array: new Float32Array([0, -1, 0, 0, -1, 0, 0, 1, 0]), type: 'VEC3' });
  b.addScene([b.addNode({ name: 'Morphed', mesh: b.addMesh('Morphed', [{ attributes: { POSITION: position } }]) })]);
  const json = b.json();
  addMorphTarget(json, morph);
  return encodeGlb(json, b.binary());
}
