// 节点静态变换（列主序 4×4 矩阵，与 glTF 一致）。

import type { GltfJson, GltfNode } from './schema';

export type Mat4 = Float64Array;

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function at(m: Mat4, i: number): number {
  return m[i] ?? 0;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += at(a, k * 4 + row) * at(b, col * 4 + k);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function composeTRS(t: readonly number[], r: readonly number[], s: readonly number[]): Mat4 {
  const [tx = 0, ty = 0, tz = 0] = t;
  const [x = 0, y = 0, z = 0, w = 1] = r;
  const [sx = 1, sy = 1, sz = 1] = s;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return Float64Array.from([
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

export function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return Float64Array.from(node.matrix);
  return composeTRS(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    at(m, 0) * x + at(m, 4) * y + at(m, 8) * z + at(m, 12),
    at(m, 1) * x + at(m, 5) * y + at(m, 9) * z + at(m, 13),
    at(m, 2) * x + at(m, 6) * y + at(m, 10) * z + at(m, 14),
  ];
}

export interface MeshInstance {
  readonly node: number;
  readonly mesh: number;
  readonly world: Mat4;
}

export interface SceneTraversal {
  readonly basis: string;
  readonly instances: readonly MeshInstance[];
}

/** 从默认场景（没有 scene 时用 scenes[0]；都没有时用所有根节点）遍历节点树，收集带网格的节点和它们的世界矩阵。 */
export function traverseScene(doc: GltfJson, issues: string[]): SceneTraversal {
  const nodes = doc.nodes ?? [];
  let roots: readonly number[];
  let basis: string;
  const sceneIndex = doc.scene ?? (doc.scenes && doc.scenes.length > 0 ? 0 : undefined);
  const scene = sceneIndex === undefined ? undefined : doc.scenes?.[sceneIndex];
  if (sceneIndex !== undefined && scene) {
    roots = scene.nodes ?? [];
    basis = `scenes[${sceneIndex}]${doc.scene === undefined ? '（文件没有指定 scene，用第一个）' : ''}`;
  } else {
    if (sceneIndex !== undefined) issues.push(`scene 指向的 scenes[${sceneIndex}] 不存在，改用所有根节点`);
    const isChild = new Set<number>();
    for (const node of nodes) for (const c of node.children ?? []) isChild.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !isChild.has(i));
    basis = '所有根节点（文件没有场景）';
  }

  const instances: MeshInstance[] = [];
  const visited = new Set<number>();
  const stack: { node: number; parent: Mat4 }[] = roots.map((node) => ({ node, parent: identity() }));
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const node = nodes[item.node];
    if (!node) {
      issues.push(`场景引用的 nodes[${item.node}] 不存在`);
      continue;
    }
    if (visited.has(item.node)) {
      issues.push(`nodes[${item.node}] 在节点树里出现了不止一次（多个父节点或有环），只计算第一次`);
      continue;
    }
    visited.add(item.node);
    const world = multiply(item.parent, localMatrix(node));
    if (node.mesh !== undefined) instances.push({ node: item.node, mesh: node.mesh, world });
    for (const child of node.children ?? []) stack.push({ node: child, parent: world });
  }
  instances.sort((a, b) => a.node - b.node);
  return { basis, instances };
}
