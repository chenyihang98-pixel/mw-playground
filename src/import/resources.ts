// 加载后的统计（实际三角面数、贴图尺寸）和资源释放（几何、材质、贴图、骨骼贴图）。

import type { BufferGeometry, InstancedMesh, Material, Mesh, Object3D, SkinnedMesh, Texture } from 'three';
import { IMPORT_LIMITS, type ImportLimits } from './limits';
import { formatCount, type CheckResult } from './precheck';
import { t as tr } from '../i18n';

export interface Resources {
  readonly geometries: Set<BufferGeometry>;
  readonly materials: Set<Material>;
  readonly textures: Set<Texture>;
}

function isMesh(obj: Object3D): obj is Mesh {
  return (obj as Partial<Mesh>).isMesh === true;
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && (value as Partial<Texture>).isTexture === true;
}

export function collectResources(root: Object3D): Resources {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((obj) => {
    if (!isMesh(obj)) return;
    geometries.add(obj.geometry);
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (isTexture(value)) textures.add(value);
    }
  });
  return { geometries, materials, textures };
}

/** 释放几何、材质、贴图。返回释放的数量（测试用）。 */
export function disposeResources(resources: Resources): { geometries: number; materials: number; textures: number } {
  for (const t of resources.textures) t.dispose();
  for (const m of resources.materials) m.dispose();
  for (const g of resources.geometries) g.dispose();
  return { geometries: resources.geometries.size, materials: resources.materials.size, textures: resources.textures.size };
}

export function disposeObject(root: Object3D): { geometries: number; materials: number; textures: number } {
  disposeInstancedMeshes(root);
  return disposeResources(collectResources(root));
}

function isInstanced(obj: Object3D): obj is InstancedMesh {
  return (obj as Partial<InstancedMesh>).isInstancedMesh === true;
}

/** 释放实例化网格自己的实例属性（每个克隆都有自己的 instanceMatrix）。 */
export function disposeInstancedMeshes(root: Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    if (isInstanced(obj)) {
      obj.dispose();
      count++;
    }
  });
  return count;
}

/** 释放克隆出来的骨骼（每个实例有自己的 Skeleton，骨骼贴图在这里释放）。 */
export function disposeSkeletons(root: Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    const skinned = obj as Partial<SkinnedMesh>;
    if (skinned.isSkinnedMesh === true && skinned.skeleton) {
      skinned.skeleton.dispose();
      count++;
    }
  });
  return count;
}

export interface TextureInfo {
  readonly width: number;
  readonly height: number;
}

export interface LoadedStats {
  readonly triangles: number;
  readonly meshes: number;
  readonly skinnedMeshes: number;
  readonly bones: number;
  /** 关节索引（权重不为 0 的）超出骨骼数量的蒙皮网格数。 */
  readonly invalidSkinMeshes: number;
  readonly textures: readonly TextureInfo[];
}

function textureSize(texture: Texture): TextureInfo | null {
  const image = texture.image as { width?: unknown; height?: unknown } | null | undefined;
  if (!image || typeof image.width !== 'number' || typeof image.height !== 'number') return null;
  return { width: image.width, height: image.height };
}

/** 有没有权重不为 0、却指向不存在的骨骼的关节索引。 */
function hasInvalidSkinIndex(mesh: SkinnedMesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry.hasAttribute('skinIndex') || !geometry.hasAttribute('skinWeight')) return false;
  const indices = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const boneCount = mesh.skeleton.bones.length;
  for (let i = 0; i < indices.count; i++) {
    for (let c = 0; c < indices.itemSize; c++) {
      if (weights.getComponent(i, c) === 0) continue;
      const index = indices.getComponent(i, c);
      if (!Number.isInteger(index) || index < 0 || index >= boneCount || !mesh.skeleton.bones[index]) return true;
    }
  }
  return false;
}

/** 实际的三角面数、骨骼数和能读到的贴图尺寸。 */
export function loadedStats(root: Object3D): LoadedStats {
  let triangles = 0;
  let meshes = 0;
  let skinnedMeshes = 0;
  let invalidSkinMeshes = 0;
  const bones = new Set<Object3D>();
  root.traverse((obj) => {
    if (!isMesh(obj)) return;
    meshes++;
    const geometry = obj.geometry;
    const count = geometry.index ? geometry.index.count : geometry.hasAttribute('position') ? geometry.getAttribute('position').count : 0;
    // 实例化网格（例如 EXT_mesh_gpu_instancing）按实际实例数计算
    const instances = isInstanced(obj) ? obj.count : 1;
    triangles += Math.floor(count / 3) * instances;
    const skinned = obj as Partial<SkinnedMesh>;
    if (skinned.isSkinnedMesh === true && skinned.skeleton) {
      skinnedMeshes++;
      for (const bone of skinned.skeleton.bones) bones.add(bone);
      if (hasInvalidSkinIndex(obj as SkinnedMesh)) invalidSkinMeshes++;
    }
  });
  const textures: TextureInfo[] = [];
  for (const texture of collectResources(root).textures) {
    const size = textureSize(texture);
    if (size) textures.push(size);
  }
  return { triangles, meshes, skinnedMeshes, bones: bones.size, invalidSkinMeshes, textures };
}

/** 加载之后的检查：实际三角面数、骨骼数、能读到的贴图尺寸。超限时调用方负责释放资源。 */
export function postLoadCheck(stats: LoadedStats, limits: ImportLimits = IMPORT_LIMITS): CheckResult<LoadedStats> {
  const warnings: string[] = [];
  if (stats.meshes === 0 || stats.triangles === 0) return { ok: false, error: tr('import.noTrianglesInFile'), warnings };
  if (stats.triangles > limits.trianglesReject) {
    return { ok: false, error: tr('import.tooManyTriangles', { count: formatCount(stats.triangles), limit: formatCount(limits.trianglesReject) }), warnings };
  }
  if (stats.triangles > limits.trianglesWarn) warnings.push(tr('import.manyTriangles', { count: formatCount(stats.triangles) }));
  if (stats.invalidSkinMeshes > 0) {
    return { ok: false, error: tr('import.badSkin'), warnings };
  }
  if (stats.bones > limits.bonesMax) {
    return { ok: false, error: tr('import.tooManyBones', { count: formatCount(stats.bones), limit: formatCount(limits.bonesMax) }), warnings };
  }
  for (const t of stats.textures) {
    if (Math.max(t.width, t.height) > limits.textureEdgeMax) {
      return {
        ok: false,
        error: tr('import.textureTooLarge', { width: String(t.width), height: String(t.height), limit: formatCount(limits.textureEdgeMax) }),
        warnings,
      };
    }
  }
  return { ok: true, value: stats, warnings };
}
