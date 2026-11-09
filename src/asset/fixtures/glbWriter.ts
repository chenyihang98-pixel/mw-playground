// 最小的 GLB 写入器：只为生成测试夹具。不依赖 fs、DOM 或 three，浏览器和 Node 都能用。
// 能精确控制 animation 的 name 和 extras（包括“没有 name 字段”和“extras 不是对象”这类情况）。

import {
  CHUNK_TYPE_BIN,
  CHUNK_TYPE_JSON,
  COMPONENT_TYPE,
  GLB_HEADER_BYTES,
  GLB_CHUNK_HEADER_BYTES,
  GLB_MAGIC,
  GLB_VERSION,
  accessorComponentCount,
  type AccessorType,
  type ComponentType,
} from '../gltf/constants';

export type JsonObject = Record<string, unknown>;
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export type TypedArrayData = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;

export interface AccessorSpec {
  readonly array: TypedArrayData;
  readonly type: AccessorType;
  readonly normalized?: boolean;
  /** 是否写 min/max。默认写。 */
  readonly minMax?: boolean;
  /** bufferView.target（34962 顶点属性 / 34963 索引）。 */
  readonly target?: number;
}

export interface NodeSpec {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
  readonly translation?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
  readonly matrix?: readonly number[];
}

export interface PrimitiveSpec {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
  readonly extensions?: JsonObject;
}

export type AnimationPath = 'translation' | 'rotation' | 'scale' | 'weights';

export interface AnimationChannelSpec {
  readonly node: number;
  readonly path: AnimationPath;
  readonly times: readonly number[];
  readonly values: readonly number[];
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

/**
 * name：省略这个键 = JSON 里没有 name 字段；'' = 空字符串。
 * extras：省略这个键 = JSON 里没有 extras；给什么值就原样写什么值（可以是数字、字符串等非对象）。
 */
export interface AnimationSpec {
  readonly name?: string;
  readonly extras?: unknown;
  readonly channels: readonly AnimationChannelSpec[];
}

export interface GlbBuildOptions {
  /** 设置后：buffers[0] 写成这个外部 uri，GLB 不带 BIN 块。 */
  readonly externalBufferUri?: string;
}

const ARRAY_KEYS = [
  'scenes',
  'nodes',
  'meshes',
  'materials',
  'textures',
  'images',
  'samplers',
  'accessors',
  'bufferViews',
  'skins',
  'animations',
] as const;
type ArrayKey = (typeof ARRAY_KEYS)[number];

function componentTypeOf(array: TypedArrayData): ComponentType {
  if (array instanceof Float32Array) return COMPONENT_TYPE.FLOAT;
  if (array instanceof Uint32Array) return COMPONENT_TYPE.UNSIGNED_INT;
  if (array instanceof Uint16Array) return COMPONENT_TYPE.UNSIGNED_SHORT;
  if (array instanceof Uint8Array) return COMPONENT_TYPE.UNSIGNED_BYTE;
  if (array instanceof Int16Array) return COMPONENT_TYPE.SHORT;
  return COMPONENT_TYPE.BYTE;
}

function alignTo4(n: number): number {
  return (n + 3) & ~3;
}

export class GltfBuilder {
  private readonly root: JsonObject;
  private readonly lists = new Map<ArrayKey, unknown[]>();
  private readonly binParts: Uint8Array[] = [];
  private binLength = 0;
  private readonly timeAccessorCache = new Map<string, number>();

  constructor(generator = 'mw-playground fixture writer') {
    this.root = { asset: { version: '2.0', generator } };
  }

  /** 顶层字段（extensionsUsed、scene 等）直接写。 */
  set(key: string, value: unknown): this {
    this.root[key] = value;
    return this;
  }

  private push(key: ArrayKey, item: unknown): number {
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(item);
    return list.length - 1;
  }

  addBufferView(bytes: Uint8Array, target?: number): number {
    const padded = alignTo4(this.binLength);
    if (padded > this.binLength) {
      this.binParts.push(new Uint8Array(padded - this.binLength));
      this.binLength = padded;
    }
    const byteOffset = this.binLength;
    this.binParts.push(bytes.slice());
    this.binLength += bytes.byteLength;
    const view: JsonObject = { buffer: 0, byteOffset, byteLength: bytes.byteLength };
    if (target !== undefined) view.target = target;
    return this.push('bufferViews', view);
  }

  addAccessor(spec: AccessorSpec): number {
    const components = accessorComponentCount(spec.type);
    if (components === undefined || spec.array.length % components !== 0) {
      throw new Error(`accessor 数据长度 ${spec.array.length} 不是 ${spec.type} 分量数的整数倍`);
    }
    const count = spec.array.length / components;
    const bytes = new Uint8Array(spec.array.buffer, spec.array.byteOffset, spec.array.byteLength);
    const bufferView = this.addBufferView(bytes, spec.target);
    const def: JsonObject = { bufferView, componentType: componentTypeOf(spec.array), count, type: spec.type };
    if (spec.normalized) def.normalized = true;
    if (spec.minMax ?? true) {
      const min = new Array<number>(components).fill(Infinity);
      const max = new Array<number>(components).fill(-Infinity);
      for (let i = 0; i < spec.array.length; i++) {
        const c = i % components;
        const v = spec.array[i] ?? 0;
        if (v < (min[c] ?? Infinity)) min[c] = v;
        if (v > (max[c] ?? -Infinity)) max[c] = v;
      }
      def.min = min;
      def.max = max;
    }
    return this.push('accessors', def);
  }

  /** 不带数据的访问器（例如 Draco 压缩图元的访问器只声明 count、min、max）。 */
  addAccessorDescriptor(def: JsonObject): number {
    return this.push('accessors', { ...def });
  }

  addNode(spec: NodeSpec): number {
    const def: JsonObject = {};
    if (spec.name !== undefined) def.name = spec.name;
    if (spec.children && spec.children.length > 0) def.children = [...spec.children];
    if (spec.mesh !== undefined) def.mesh = spec.mesh;
    if (spec.skin !== undefined) def.skin = spec.skin;
    if (spec.matrix) def.matrix = [...spec.matrix];
    if (spec.translation) def.translation = [...spec.translation];
    if (spec.rotation) def.rotation = [...spec.rotation];
    if (spec.scale) def.scale = [...spec.scale];
    return this.push('nodes', def);
  }

  /** 给已有节点追加子节点。 */
  addChildren(parent: number, children: readonly number[]): void {
    const node = this.lists.get('nodes')?.[parent] as JsonObject | undefined;
    if (!node) throw new Error(`nodes[${parent}] 不存在`);
    const existing = (node.children as number[] | undefined) ?? [];
    node.children = [...existing, ...children];
  }

  addMesh(name: string, primitives: readonly PrimitiveSpec[]): number {
    return this.push('meshes', {
      name,
      primitives: primitives.map((p) => {
        const def: JsonObject = { attributes: { ...p.attributes } };
        if (p.indices !== undefined) def.indices = p.indices;
        if (p.material !== undefined) def.material = p.material;
        if (p.mode !== undefined) def.mode = p.mode;
        if (p.extensions) def.extensions = p.extensions;
        return def;
      }),
    });
  }

  addMaterial(def: JsonObject): number {
    return this.push('materials', def);
  }

  addTexture(def: JsonObject): number {
    return this.push('textures', def);
  }

  addImage(def: JsonObject): number {
    return this.push('images', def);
  }

  addSkin(def: { name?: string; joints: readonly number[]; inverseBindMatrices?: number; skeleton?: number }): number {
    const skin: JsonObject = { joints: [...def.joints] };
    if (def.name !== undefined) skin.name = def.name;
    if (def.inverseBindMatrices !== undefined) skin.inverseBindMatrices = def.inverseBindMatrices;
    if (def.skeleton !== undefined) skin.skeleton = def.skeleton;
    return this.push('skins', skin);
  }

  addScene(nodes: readonly number[], name = 'Scene'): number {
    const index = this.push('scenes', { name, nodes: [...nodes] });
    if (this.root.scene === undefined) this.root.scene = index;
    return index;
  }

  private timeAccessor(times: readonly number[]): number {
    const key = times.join(',');
    const cached = this.timeAccessorCache.get(key);
    if (cached !== undefined) return cached;
    // 规范要求动画输入访问器带 min/max。
    const index = this.addAccessor({ array: new Float32Array(times), type: 'SCALAR' });
    this.timeAccessorCache.set(key, index);
    return index;
  }

  addAnimation(spec: AnimationSpec): number {
    const samplers: JsonObject[] = [];
    const channels: JsonObject[] = [];
    for (const ch of spec.channels) {
      const input = this.timeAccessor(ch.times);
      const type: AccessorType = ch.path === 'rotation' ? 'VEC4' : ch.path === 'weights' ? 'SCALAR' : 'VEC3';
      const output = this.addAccessor({ array: new Float32Array(ch.values), type, minMax: false });
      samplers.push({ input, output, interpolation: ch.interpolation ?? 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } });
    }
    const def: JsonObject = {};
    if ('name' in spec) def.name = spec.name;
    def.channels = channels;
    def.samplers = samplers;
    if ('extras' in spec) def.extras = spec.extras;
    return this.push('animations', def);
  }

  /** 当前 BIN 数据（已按 4 字节对齐拼接）。 */
  binary(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.binLength);
    let offset = 0;
    for (const part of this.binParts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  /** 生成 glTF JSON 对象（buffers 按选项决定）。 */
  json(options: GlbBuildOptions = {}): JsonObject {
    const json: JsonObject = { ...this.root };
    for (const key of ARRAY_KEYS) {
      const list = this.lists.get(key);
      if (list && list.length > 0) json[key] = list;
    }
    if (this.binLength > 0) {
      const buffer: JsonObject = { byteLength: this.binLength };
      if (options.externalBufferUri !== undefined) buffer.uri = options.externalBufferUri;
      json.buffers = [buffer];
    }
    return json;
  }

  toGlb(options: GlbBuildOptions = {}): Uint8Array<ArrayBuffer> {
    const json = this.json(options);
    const bin = options.externalBufferUri === undefined && this.binLength > 0 ? this.binary() : undefined;
    return encodeGlb(json, bin);
  }
}

function padded(bytes: Uint8Array, fill: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(alignTo4(bytes.byteLength)).fill(fill);
  out.set(bytes);
  return out;
}

/** 把 glTF JSON 和可选的 BIN 数据打包成 GLB 2.0 容器。JSON 块用空格补齐，BIN 块用 0 补齐。 */
export function encodeGlb(json: unknown, bin?: Uint8Array): Uint8Array<ArrayBuffer> {
  const jsonChunk = padded(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = bin ? padded(bin, 0) : undefined;
  const total =
    GLB_HEADER_BYTES +
    GLB_CHUNK_HEADER_BYTES +
    jsonChunk.byteLength +
    (binChunk ? GLB_CHUNK_HEADER_BYTES + binChunk.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  let offset = GLB_HEADER_BYTES;
  view.setUint32(offset, jsonChunk.byteLength, true);
  view.setUint32(offset + 4, CHUNK_TYPE_JSON, true);
  out.set(jsonChunk, offset + GLB_CHUNK_HEADER_BYTES);
  offset += GLB_CHUNK_HEADER_BYTES + jsonChunk.byteLength;
  if (binChunk) {
    view.setUint32(offset, binChunk.byteLength, true);
    view.setUint32(offset + 4, CHUNK_TYPE_BIN, true);
    out.set(binChunk, offset + GLB_CHUNK_HEADER_BYTES);
  }
  return out;
}

/** 复制出独立的 ArrayBuffer（GLTFLoader.parse 需要 ArrayBuffer）。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
