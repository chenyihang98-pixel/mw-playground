// 代码生成的 GLB 夹具。全部在内存里生成，不读写文件，不下载任何外部模型。
// 人形夹具沿用模匠输出的约定：面向 +Z，单位米，身高 1.75 m，轴心在脚底中心。

import { GltfBuilder, type AnimationSpec, type JsonObject, type Quat, type Vec3 } from './glbWriter';
import { bytesToBase64, checkerPng, jpegHeaderOnly } from './imageBytes';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export const FIXTURE_IDS = [
  'skinned-humanoid',
  'loop-false',
  'loop-string',
  'extras-number',
  'duplicate-names',
  'unnamed-clips',
  'root-motion',
  'node-animation',
  'static-mesh',
  'textured',
  'external-buffer',
  'draco-required',
  'corrupt-magic',
  'corrupt-truncated',
] as const;

export type FixtureId = (typeof FIXTURE_IDS)[number];

export interface FixtureSpec {
  readonly id: FixtureId;
  readonly title: string;
  /** 能否在页面里用 GLTFLoader 加载预览（外部 buffer、Draco、只有头的 JPEG、损坏容器都不能）。 */
  readonly previewable: boolean;
  /** 是否是合法的 GLB 容器。 */
  readonly validGlb: boolean;
  build(): Uint8Array<ArrayBuffer>;
}

// ---------- 几何 ----------

interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
  joints: number[];
  weights: number[];
}

function emptyMesh(): MeshData {
  return { positions: [], normals: [], indices: [], joints: [], weights: [] };
}

// 每个面：法线 n 和两个切向 u、v，满足 u × v = n，四个角按逆时针（从外面看）排列。
const BOX_FACES: readonly { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** 追加一个轴对齐的盒子（24 个顶点、12 个三角形）；joint 给出时整块绑到这个关节。 */
function appendBox(mesh: MeshData, min: Vec3, max: Vec3, joint?: number): void {
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const h: Vec3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  for (const { n, u, v } of BOX_FACES) {
    const base = mesh.positions.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const axis = (k: 0 | 1 | 2) => c[k] + (su * u[k] + sv * v[k] + n[k]) * h[k];
      mesh.positions.push(axis(0), axis(1), axis(2));
      mesh.normals.push(n[0], n[1], n[2]);
      if (joint !== undefined) {
        mesh.joints.push(joint, 0, 0, 0);
        mesh.weights.push(1, 0, 0, 0);
      }
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function addPrimitive(b: GltfBuilder, mesh: MeshData, material: number, skinned: boolean) {
  const attributes: Record<string, number> = {
    POSITION: b.addAccessor({ array: new Float32Array(mesh.positions), type: 'VEC3', target: ARRAY_BUFFER }),
    NORMAL: b.addAccessor({ array: new Float32Array(mesh.normals), type: 'VEC3', target: ARRAY_BUFFER, minMax: false }),
  };
  if (skinned) {
    attributes.JOINTS_0 = b.addAccessor({ array: new Uint8Array(mesh.joints), type: 'VEC4', target: ARRAY_BUFFER, minMax: false });
    attributes.WEIGHTS_0 = b.addAccessor({ array: new Float32Array(mesh.weights), type: 'VEC4', target: ARRAY_BUFFER, minMax: false });
  }
  const indices = b.addAccessor({ array: new Uint16Array(mesh.indices), type: 'SCALAR', target: ELEMENT_ARRAY_BUFFER, minMax: false });
  return { attributes, indices, material };
}

function colorMaterial(b: GltfBuilder, name: string, rgb: Vec3, extra: JsonObject = {}): number {
  return b.addMaterial({
    name,
    pbrMetallicRoughness: { baseColorFactor: [rgb[0], rgb[1], rgb[2], 1], metallicFactor: 0, roughnessFactor: 0.8, ...extra },
  });
}

// ---------- 数学 ----------

const DEG = Math.PI / 180;

function quatAxisAngle(axis: Vec3, degrees: number): Quat {
  const half = (degrees * DEG) / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function quatKeys(axis: Vec3, degrees: readonly number[]): number[] {
  return degrees.flatMap((d) => [...quatAxisAngle(axis, d)]);
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

// ---------- 人形（带骨骼） ----------

interface Humanoid {
  readonly hips: number;
  readonly spine: number;
  readonly head: number;
  readonly leftLeg: number;
  readonly rightLeg: number;
}

/** 5 个关节的简易人形：身高 1.75 m，面向 +Z（鼻子在 +Z 一侧），轴心在脚底中心。 */
function buildHumanoid(b: GltfBuilder): Humanoid {
  const head = b.addNode({ name: 'Head', translation: [0, 0.45, 0] });
  const spine = b.addNode({ name: 'Spine', translation: [0, 0.1, 0], children: [head] });
  const leftLeg = b.addNode({ name: 'LeftUpLeg', translation: [0.1, 0, 0] });
  const rightLeg = b.addNode({ name: 'RightUpLeg', translation: [-0.1, 0, 0] });
  const hips = b.addNode({ name: 'Hips', translation: [0, 0.9, 0], children: [leftLeg, rightLeg, spine] });

  // 关节顺序和绑定姿态下的世界坐标（只有平移）。
  const joints = [hips, spine, head, leftLeg, rightLeg];
  const bindPositions: Vec3[] = [
    [0, 0.9, 0],
    [0, 1.0, 0],
    [0, 1.45, 0],
    [0.1, 0.9, 0],
    [-0.1, 0.9, 0],
  ];
  const ibm = new Float32Array(16 * joints.length);
  bindPositions.forEach((p, j) => {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], j * 16);
  });
  const inverseBindMatrices = b.addAccessor({ array: ibm, type: 'MAT4', minMax: false });

  const body = emptyMesh();
  appendBox(body, [0.03, 0, -0.07], [0.17, 0.9, 0.07], 3); // 左腿
  appendBox(body, [-0.17, 0, -0.07], [-0.03, 0.9, 0.07], 4); // 右腿
  appendBox(body, [-0.2, 0.9, -0.1], [0.2, 1.45, 0.1], 1); // 躯干
  const headMesh = emptyMesh();
  appendBox(headMesh, [-0.11, 1.45, -0.11], [0.11, 1.75, 0.11], 2); // 头
  appendBox(headMesh, [-0.03, 1.57, 0.11], [0.03, 1.63, 0.16], 2); // 鼻子（标出 +Z 朝向）

  const bodyMat = colorMaterial(b, 'Body', [0.25, 0.45, 0.75]);
  const headMat = colorMaterial(b, 'Head', [0.95, 0.8, 0.65]);
  const mesh = b.addMesh('Humanoid', [addPrimitive(b, body, bodyMat, true), addPrimitive(b, headMesh, headMat, true)]);
  const skin = b.addSkin({ name: 'Armature', joints, inverseBindMatrices, skeleton: hips });
  const bodyNode = b.addNode({ name: 'Body', mesh, skin });
  const character = b.addNode({ name: 'Character', children: [hips, bodyNode] });
  b.addScene([character]);
  return { hips, spine, head, leftLeg, rightLeg };
}

function legSwing(h: Humanoid, times: readonly number[], amplitude: number) {
  const left = times.map((_, i) => (i % 2 === 0 ? amplitude : -amplitude));
  const right = left.map((d) => -d);
  return [
    { node: h.leftLeg, path: 'rotation' as const, times, values: quatKeys(X, left) },
    { node: h.rightLeg, path: 'rotation' as const, times, values: quatKeys(X, right) },
  ];
}

function skinnedHumanoid(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const h = buildHumanoid(b);
  b.addAnimation({
    name: 'idle',
    extras: { designed: true, loop: true },
    channels: [
      { node: h.spine, path: 'rotation', times: [0, 0.5, 1, 1.5, 2], values: quatKeys(Z, [0, 3, 0, -3, 0]) },
      { node: h.head, path: 'rotation', times: [0, 0.5, 1, 1.5, 2], values: quatKeys(X, [0, 4, 0, -2, 0]) },
    ],
  });
  b.addAnimation({
    name: 'walk',
    extras: { designed: true, loop: true },
    channels: legSwing(h, [0, 0.5, 1], 25),
  });
  b.addAnimation({
    name: 'run',
    extras: { designed: true },
    channels: [
      ...legSwing(h, [0, 0.3, 0.6], 45),
      { node: h.spine, path: 'rotation', times: [0, 0.6], values: quatKeys(X, [12, 12]) },
    ],
  });
  return b.toGlb();
}

function rootMotion(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const h = buildHumanoid(b);
  b.addAnimation({
    name: 'walk_forward',
    extras: { designed: true, loop: true },
    channels: [
      ...legSwing(h, [0, 0.5, 1, 1.5, 2], 25),
      // Hips 的 position 轨道：2 秒内沿 +Z 水平前进 2 m，高度不变。
      { node: h.hips, path: 'translation', times: [0, 1, 2], values: [0, 0.9, 0, 0, 0.9, 1, 0, 0.9, 2] },
    ],
  });
  return b.toGlb();
}

// ---------- 无骨骼的方块 ----------

function buildCube(b: GltfBuilder, name = 'Cube'): number {
  const mesh = emptyMesh();
  appendBox(mesh, [-0.4, 0, -0.4], [0.4, 0.8, 0.4]);
  const mat = colorMaterial(b, `${name}Material`, [0.85, 0.55, 0.25]);
  const meshIndex = b.addMesh(name, [addPrimitive(b, mesh, mat, false)]);
  const node = b.addNode({ name, mesh: meshIndex });
  b.addScene([node]);
  return node;
}

function spinChannel(node: number, duration: number) {
  const times = [0, duration / 3, (2 * duration) / 3, duration];
  return { node, path: 'rotation' as const, times, values: quatKeys(Y, [0, 120, 240, 360]) };
}

/** 一个方块，加上若干个绕 Y 旋转的片段；片段的 name 和 extras 原样写入。 */
function cubeWithClips(clips: readonly Omit<AnimationSpec, 'channels'>[]): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const node = buildCube(b);
  clips.forEach((clip, i) => {
    b.addAnimation({ ...clip, channels: [spinChannel(node, 1 + i * 0.5)] });
  });
  return b.toGlb();
}

function nodeAnimation(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const node = buildCube(b);
  b.addAnimation({ name: 'spin', extras: { designed: true, loop: true }, channels: [spinChannel(node, 2)] });
  b.addAnimation({
    name: 'bob',
    extras: { designed: true, loop: true },
    channels: [{ node, path: 'translation', times: [0, 0.5, 1], values: [0, 0, 0, 0, 0.3, 0, 0, 0, 0] }],
  });
  return b.toGlb();
}

/** 静态网格，带父子变换：Root 平移 (0,0.5,0)；Crate 平移 (1,0,-2)、绕 Y 转 90°、放大 2 倍。 */
function staticMesh(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const mesh = emptyMesh();
  appendBox(mesh, [-0.5, 0, -0.25], [0.5, 1, 0.25]);
  const mat = colorMaterial(b, 'Crate', [0.6, 0.45, 0.3]);
  const meshIndex = b.addMesh('Crate', [addPrimitive(b, mesh, mat, false)]);
  const crate = b.addNode({ name: 'Crate', mesh: meshIndex, translation: [1, 0, -2], rotation: quatAxisAngle(Y, 90), scale: [2, 2, 2] });
  const root = b.addNode({ name: 'Root', translation: [0, 0.5, 0], children: [crate] });
  b.addScene([root]);
  return b.toGlb();
}

/** 两张内嵌图片：PNG（bufferView，4×2，可解码）和 JPEG（data URI，16×8，只有文件头）。 */
function textured(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const png = checkerPng(4, 2);
  const pngView = b.addBufferView(png);
  const pngImage = b.addImage({ name: 'checker', mimeType: 'image/png', bufferView: pngView });
  const jpegImage = b.addImage({ name: 'header-only', uri: `data:image/jpeg;base64,${bytesToBase64(jpegHeaderOnly(16, 8))}` });
  const pngTexture = b.addTexture({ source: pngImage });
  b.addTexture({ source: jpegImage });
  const mesh = emptyMesh();
  appendBox(mesh, [-0.5, 0, -0.5], [0.5, 1, 0.5]);
  const mat = colorMaterial(b, 'Checker', [1, 1, 1], { baseColorTexture: { index: pngTexture } });
  const meshIndex = b.addMesh('TexturedBox', [addPrimitive(b, mesh, mat, false)]);
  b.addScene([b.addNode({ name: 'TexturedBox', mesh: meshIndex })]);
  return b.toGlb();
}

/** buffers[0] 和 images[0] 都引用外部文件；GLB 不带 BIN 块。 */
function externalBuffer(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  const node = buildCube(b);
  b.addAnimation({
    name: 'slide',
    extras: { designed: true, loop: false },
    channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }],
  });
  const image = b.addImage({ uri: 'textures/fixture-albedo.png', mimeType: 'image/png' });
  b.addTexture({ source: image });
  return b.toGlb({ externalBufferUri: 'fixture-external.bin' });
}

/** 声明并使用 KHR_draco_mesh_compression；压缩数据只是占位字节，不是真的 Draco 数据。 */
function dracoRequired(): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  b.set('extensionsUsed', ['KHR_draco_mesh_compression']);
  b.set('extensionsRequired', ['KHR_draco_mesh_compression']);
  const placeholder = b.addBufferView(new TextEncoder().encode('placeholder, not real draco data'));
  const position = b.addAccessorDescriptor({ componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
  const normal = b.addAccessorDescriptor({ componentType: 5126, count: 24, type: 'VEC3' });
  const indices = b.addAccessorDescriptor({ componentType: 5123, count: 36, type: 'SCALAR' });
  const mat = colorMaterial(b, 'Draco', [0.5, 0.5, 0.5]);
  const mesh = b.addMesh('DracoBox', [
    {
      attributes: { POSITION: position, NORMAL: normal },
      indices,
      material: mat,
      extensions: { KHR_draco_mesh_compression: { bufferView: placeholder, attributes: { POSITION: 0, NORMAL: 1 } } },
    },
  ]);
  b.addScene([b.addNode({ name: 'DracoBox', mesh })]);
  return b.toGlb();
}

function corruptMagic(): Uint8Array<ArrayBuffer> {
  const bytes = skinnedHumanoid();
  bytes.set(new TextEncoder().encode('gltf'), 0); // 正确的是 "glTF"
  return bytes;
}

function corruptTruncated(): Uint8Array<ArrayBuffer> {
  const bytes = skinnedHumanoid();
  return bytes.slice(0, Math.floor(bytes.byteLength / 2));
}

export const FIXTURES: readonly FixtureSpec[] = [
  { id: 'skinned-humanoid', title: '带骨骼人形：idle / walk / run（loop true / true / 缺失）', previewable: true, validGlb: true, build: skinnedHumanoid },
  {
    id: 'loop-false',
    title: 'loop 为 false',
    previewable: true,
    validGlb: true,
    build: () => cubeWithClips([{ name: 'wave', extras: { designed: true, loop: false } }]),
  },
  {
    id: 'loop-string',
    title: 'loop 为字符串 "yes"',
    previewable: true,
    validGlb: true,
    build: () => cubeWithClips([{ name: 'dance', extras: { designed: true, loop: 'yes' } }]),
  },
  {
    id: 'extras-number',
    title: 'extras 是数字 42',
    previewable: true,
    validGlb: true,
    build: () => cubeWithClips([{ name: 'jump', extras: 42 }]),
  },
  {
    id: 'duplicate-names',
    title: '两个片段同名 idle',
    previewable: true,
    validGlb: true,
    build: () =>
      cubeWithClips([
        { name: 'idle', extras: { designed: true, loop: true } },
        { name: 'idle', extras: { designed: true, loop: false } },
        { name: 'walk', extras: { designed: true, loop: true } },
      ]),
  },
  {
    id: 'unnamed-clips',
    title: '无名片段（没有 name 字段、name 为空字符串）',
    previewable: true,
    validGlb: true,
    build: () =>
      cubeWithClips([
        { name: 'named', extras: { designed: true, loop: true } },
        { extras: { designed: true, loop: true } },
        { name: '', extras: { designed: true, loop: false } },
      ]),
  },
  { id: 'root-motion', title: '带水平位移的片段：Hips 2 秒前进 2 m', previewable: true, validGlb: true, build: rootMotion },
  { id: 'node-animation', title: '无骨骼的节点动画：spin / bob', previewable: true, validGlb: true, build: nodeAnimation },
  { id: 'static-mesh', title: '没有动画的静态网格（带父子变换）', previewable: true, validGlb: true, build: staticMesh },
  { id: 'textured', title: '内嵌 PNG（bufferView）和只有头的 JPEG（data URI）', previewable: false, validGlb: true, build: textured },
  { id: 'external-buffer', title: '引用外部 buffer 和外部图片', previewable: false, validGlb: true, build: externalBuffer },
  { id: 'draco-required', title: 'extensionsRequired 含 KHR_draco_mesh_compression', previewable: false, validGlb: true, build: dracoRequired },
  { id: 'corrupt-magic', title: '损坏：magic 错误', previewable: false, validGlb: false, build: corruptMagic },
  { id: 'corrupt-truncated', title: '损坏：文件被截断', previewable: false, validGlb: false, build: corruptTruncated },
];

export const DEFAULT_PREVIEW_FIXTURE: FixtureId = 'skinned-humanoid';

export function isFixtureId(id: string): id is FixtureId {
  return (FIXTURE_IDS as readonly string[]).includes(id);
}

export function getFixture(id: FixtureId): FixtureSpec {
  const spec = FIXTURES.find((f) => f.id === id);
  if (!spec) throw new Error(`未知夹具：${id}`);
  return spec;
}

export function buildFixture(id: FixtureId): Uint8Array<ArrayBuffer> {
  return getFixture(id).build();
}
