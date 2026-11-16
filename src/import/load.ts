// 加载器：GLB（GLTFLoader.parse），以及静态模型 OBJ / STL / PLY。
// 静态模型一律用默认材质；OBJ 不读 MTL；PLY 有顶点颜色就用顶点颜色。

import { Group, Mesh, MeshStandardMaterial, type AnimationClip, type BufferGeometry, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { ImportFormat } from './precheck';
import { disposeObject } from './resources';
import { t } from '../i18n';

export const OBJ_MATERIAL_NOTICE = t('import.objDefaultMaterial');

export interface LoadedModel {
  readonly scene: Object3D;
  readonly clips: readonly AnimationClip[];
  readonly notices: readonly string[];
}

export class ModelParseError extends Error {}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function defaultMaterial(vertexColors = false): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xbcbcbc, roughness: 0.75, metalness: 0, vertexColors });
}

/** 几何必须有有限的顶点坐标，并且至少能组成一个三角形。 */
function checkGeometry(geometry: BufferGeometry, label: string): void {
  if (!geometry.hasAttribute('position') || geometry.getAttribute('position').count < 3) {
    throw new ModelParseError(t('import.noTriangles', { label }));
  }
  for (const value of geometry.getAttribute('position').array as ArrayLike<number> & Iterable<number>) {
    if (!Number.isFinite(value)) throw new ModelParseError(t('import.badVertices', { label }));
  }
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
}

function staticScene(geometry: BufferGeometry, name: string, vertexColors: boolean): Object3D {
  const group = new Group();
  group.name = name;
  const mesh = new Mesh(geometry, defaultMaterial(vertexColors));
  mesh.name = name;
  group.add(mesh);
  return group;
}

export async function loadModel(format: ImportFormat, bytes: Uint8Array): Promise<LoadedModel> {
  switch (format) {
    case 'glb': {
      const gltf = await new GLTFLoader().parseAsync(toArrayBuffer(bytes), '');
      return { scene: gltf.scene, clips: gltf.animations, notices: [] };
    }
    case 'obj': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const group = new OBJLoader().parse(text);
      // 加载器已经建好了几何和材质：校验失败时在这里释放，再把错误交给上层
      return withCleanup(
        () => {
          disposeObject(group);
        },
        () => {
          let meshes = 0;
          group.traverse((obj) => {
            const mesh = obj as Partial<Mesh>;
            if (mesh.isMesh !== true || !mesh.geometry) return;
            checkGeometry(mesh.geometry, 'OBJ');
            // 不读 MTL：替换成默认材质（OBJLoader 自己建的材质随即释放）
            const old = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const m of old) m.dispose();
            mesh.material = defaultMaterial(false);
            meshes++;
          });
          if (meshes === 0) throw new ModelParseError(t('import.objNoMesh'));
          group.name = 'obj';
          return { scene: group, clips: [], notices: [OBJ_MATERIAL_NOTICE] };
        },
      );
    }
    case 'stl': {
      const geometry = new STLLoader().parse(toArrayBuffer(bytes));
      return withCleanup(
        () => {
          geometry.dispose();
        },
        () => {
          checkGeometry(geometry, 'STL');
          return { scene: staticScene(geometry, 'stl', false), clips: [], notices: [t('import.stlDefaultMaterial')] };
        },
      );
    }
    case 'ply': {
      const faces = plyFaceCount(bytes);
      const geometry = new PLYLoader().parse(toArrayBuffer(bytes));
      return withCleanup(
        () => {
          geometry.dispose();
        },
        () => {
          // 有面的 PLY 也可能没有索引：面上带 UV 或颜色时 PLYLoader 会调用 toNonIndexed()。按文件头里的面数判断是不是点云。
          if (faces === 0) throw new ModelParseError(t('import.plyPointsOnly'));
          checkGeometry(geometry, 'PLY');
          return plyModel(geometry);
        },
      );
    }
  }
}

function plyModel(geometry: BufferGeometry): LoadedModel {
  const vertexColors = geometry.hasAttribute('color');
  return {
    scene: staticScene(geometry, 'ply', vertexColors),
    clips: [],
    notices: [vertexColors ? t('import.plyVertexColors') : t('import.plyDefaultMaterial')],
  };
}

/** 运行 body；抛错时先调用 cleanup 释放已经建好的资源，再把错误抛给上层。 */
function withCleanup<T>(cleanup: () => void, body: () => T): T {
  try {
    return body();
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** PLY 文件头里声明的面数（文件头是 ASCII，二进制 PLY 也一样）。读不到时返回 null（交给加载器判断）。 */
export function plyFaceCount(bytes: Uint8Array): number | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024)));
  const end = head.indexOf('end_header');
  if (end < 0) return null;
  const match = /^element\s+face\s+(\d+)\s*$/m.exec(head.slice(0, end));
  return match ? Number(match[1]) : 0;
}
