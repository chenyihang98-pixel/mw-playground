// GLB 结构检查（纯函数）。输入 ArrayBuffer 或 Uint8Array，输出结构化报告。
// 不用 fs、DOM、网络，也不用 three 的加载器；外部资源只列出，不读取。

import { DECODER_EXTENSIONS, PRIMITIVE_DECODER_EXTENSIONS, PRIMITIVE_MODE } from '../gltf/constants';
import { parseGlbContainer } from './container';
import { GltfData, decodeDataUri, isDataUri, normalizeDeclared } from './data';
import { readImageSize, sniffImageFormat } from './images';
import { formatSchemaIssues, gltfSchema, type GltfAnimation, type GltfJson } from './schema';
import { transformPoint, traverseScene, type MeshInstance } from './transform';
import {
  computed,
  notComputed,
  type AnimationReport,
  type AnimationsReport,
  type Box3,
  type BoundsReport,
  type ExternalResource,
  type ExtrasReport,
  type HorizontalMotionReport,
  type ImageReport,
  type InspectReport,
  type InspectResult,
  type LoopReport,
  type MeshesReport,
  type Metric,
  type PrimitiveReport,
  type SkinsReport,
  type TexturesReport,
  type Vec3,
} from './types';

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 数组最大值。不用 Math.max(...list)：通道很多时展开参数会超出调用栈。 */
function maxOf(list: readonly number[]): number {
  let max = -Infinity;
  for (const v of list) if (v > max) max = v;
  return max;
}

/** 合并原因：去重，最多列出 3 条。 */
function joinReasons(reasons: readonly string[]): string {
  const unique = [...new Set(reasons)];
  const shown = unique.slice(0, 3).join('；');
  return unique.length > 3 ? `${shown}；等 ${unique.length} 条原因` : shown;
}

// ---------- 网格 ----------

function primitiveCompression(extensions: Record<string, unknown> | undefined): string | null {
  return PRIMITIVE_DECODER_EXTENSIONS.find((name) => extensions?.[name] !== undefined) ?? null;
}

function trianglesFor(mode: number, count: number): number | null {
  switch (mode) {
    case PRIMITIVE_MODE.TRIANGLES:
      return Math.floor(count / 3);
    case PRIMITIVE_MODE.TRIANGLE_STRIP:
    case PRIMITIVE_MODE.TRIANGLE_FAN:
      return Math.max(0, count - 2);
    case PRIMITIVE_MODE.POINTS:
    case PRIMITIVE_MODE.LINES:
    case PRIMITIVE_MODE.LINE_LOOP:
    case PRIMITIVE_MODE.LINE_STRIP:
      return 0; // 点和线图元确实没有三角面
    default:
      return null;
  }
}

function inspectMeshes(doc: GltfJson, data: GltfData, issues: string[]): MeshesReport {
  const meshes = doc.meshes ?? [];
  const primitives: PrimitiveReport[] = [];
  meshes.forEach((mesh, m) => {
    mesh.primitives.forEach((prim, p) => {
      const where = `meshes[${m}].primitives[${p}]`;
      const mode = prim.mode ?? PRIMITIVE_MODE.TRIANGLES;
      const compression = primitiveCompression(prim.extensions);
      let triangles: Metric<number>;
      if (compression) {
        triangles = notComputed(`${where} 使用 ${compression}，需要解码器才能得到真实的索引；本工具不解码`);
      } else {
        const source = prim.indices !== undefined ? 'indices' : 'POSITION';
        const accessorIndex = prim.indices ?? prim.attributes.POSITION;
        // count 先按声明的 bufferView / buffer 长度核对过，才用来计数。
        const layout = accessorIndex === undefined ? undefined : data.layout(accessorIndex);
        if (!layout) {
          triangles = notComputed(`${where} 既没有 indices 也没有 POSITION`);
        } else if (!layout.ok) {
          triangles = notComputed(`${where} 的 ${source} 访问器无效：${layout.reason}`);
        } else {
          const count = layout.value.count;
          const tri = trianglesFor(mode, count);
          if (tri === null) {
            triangles = notComputed(`${where} 的 mode ${mode} 未知`);
          } else {
            if (mode === PRIMITIVE_MODE.TRIANGLES && count % 3 !== 0) {
              issues.push(`${where} 的 ${source} count（${count}）不是 3 的倍数`);
            }
            triangles = computed(tri);
          }
        }
      }
      primitives.push({ mesh: m, primitive: p, mode, compression, triangles });
    });
  });

  let total: Metric<number>;
  const missing = primitives.filter((p) => p.triangles.status === 'not-computed');
  const sum = primitives.reduce((n, p) => (p.triangles.status === 'computed' ? n + p.triangles.value : n), 0);
  if (missing.length === 0) {
    total = computed(sum);
  } else {
    const reasons = missing.map((p) => (p.triangles.status === 'not-computed' ? p.triangles.reason : ''));
    const rest = primitives.length - missing.length;
    total = notComputed(
      `${missing.length} 个图元无法计算（${joinReasons(reasons)}）` + (rest > 0 ? `；其余 ${rest} 个图元合计 ${sum}` : ''),
    );
  }
  return { meshCount: meshes.length, primitiveCount: primitives.length, triangles: total, primitives };
}

// ---------- 图片 ----------

function inspectTextures(doc: GltfJson, data: GltfData): TexturesReport {
  const images: ImageReport[] = (doc.images ?? []).map((image, i) => {
    const base = { index: i, name: image.name ?? null, declaredMimeType: image.mimeType ?? null };
    let bytes: Uint8Array | null = null;
    let source: ImageReport['source'];
    let unavailable: string | null = null;
    if (image.bufferView !== undefined) {
      source = 'bufferView';
      const view = data.bufferView(image.bufferView);
      if (view.ok) bytes = view.value;
      else unavailable = view.reason;
    } else if (image.uri !== undefined && isDataUri(image.uri)) {
      source = 'data-uri';
      const decoded = decodeDataUri(image.uri);
      if (decoded.ok) bytes = decoded.value.bytes;
      else unavailable = decoded.reason;
    } else if (image.uri !== undefined) {
      source = 'external-uri';
      unavailable = `外部图片 "${image.uri}"，本工具不读取外部资源`;
    } else {
      source = 'none';
      unavailable = '既没有 uri 也没有 bufferView';
    }
    if (!bytes) {
      return { ...base, source, detectedFormat: null, size: notComputed(unavailable ?? '无法读取图片数据') };
    }
    const result = readImageSize(bytes);
    return {
      ...base,
      source,
      detectedFormat: sniffImageFormat(bytes),
      size: result.ok
        ? computed(result.size)
        : notComputed(result.format === null ? `不是 PNG 或 JPEG（声明的 mimeType：${image.mimeType ?? '无'}），未读取尺寸` : result.reason),
    };
  });
  return { textureCount: doc.textures?.length ?? 0, imageCount: images.length, images };
}

// ---------- 蒙皮 ----------

function inspectSkins(doc: GltfJson): SkinsReport {
  const skins = (doc.skins ?? []).map((skin, i) => ({
    index: i,
    name: skin.name ?? null,
    jointCount: skin.joints.length,
    skeleton: skin.skeleton ?? null,
  }));
  const unique = new Set((doc.skins ?? []).flatMap((skin) => skin.joints));
  return { count: skins.length, skins, uniqueJointCount: unique.size };
}

// ---------- 动画 ----------

function extrasOf(anim: GltfAnimation): ExtrasReport {
  if (!('extras' in anim) || anim.extras === undefined) return { kind: 'missing' };
  if (isPlainObject(anim.extras)) return { kind: 'object' };
  return { kind: 'not-object', valueType: valueType(anim.extras), value: anim.extras };
}

function loopOf(anim: GltfAnimation): LoopReport {
  const extras = anim.extras;
  if (extras === undefined) return { kind: 'missing', reason: 'no-extras' };
  if (!isPlainObject(extras)) return { kind: 'missing', reason: 'extras-not-object' };
  if (!Object.hasOwn(extras, 'loop')) return { kind: 'missing', reason: 'no-loop-key' };
  const loop = extras.loop;
  if (loop === true) return { kind: 'true' };
  if (loop === false) return { kind: 'false' };
  return { kind: 'other', valueType: valueType(loop), value: loop };
}

/** 输入（时间）访问器里的最大时间，按访问器缓存：很多通道共用同一条时间轴时只读一次。 */
type TimeMax = (accessor: number) => { ok: true; value: number } | { ok: false; reason: string };

function timeMaxReader(data: GltfData): TimeMax {
  const cache = new Map<number, ReturnType<TimeMax>>();
  return (accessor) => {
    const cached = cache.get(accessor);
    if (cached) return cached;
    let result: ReturnType<TimeMax>;
    const times = data.accessor(accessor);
    if (!times.ok) {
      result = times;
    } else if (times.value.count === 0) {
      result = { ok: false, reason: `输入访问器 accessors[${accessor}] 没有关键帧` };
    } else {
      let max = -Infinity;
      const scanned = data.scan(times.value, (values) => {
        max = Math.max(max, values[0] ?? -Infinity);
      });
      result = scanned.ok ? { ok: true, value: max } : scanned;
    }
    cache.set(accessor, result);
    return result;
  };
}

function inspectAnimation(
  doc: GltfJson,
  data: GltfData,
  timeMax: TimeMax,
  anim: GltfAnimation,
  index: number,
  issues: string[],
): AnimationReport {
  const where = `animations[${index}]`;
  const rawName = anim.name ?? null;
  const unnamed = rawName === null || rawName === '';
  const loaderName = unnamed ? `animation_${index}` : rawName;

  const targetPaths: Record<string, number> = {};
  const declaredMax: number[] = [];
  const declaredMissing: string[] = [];
  const actualMax: number[] = [];
  const actualMissing: string[] = [];
  const horizontalMotion: HorizontalMotionReport[] = [];

  anim.channels.forEach((channel, c) => {
    targetPaths[channel.target.path] = (targetPaths[channel.target.path] ?? 0) + 1;
    const sampler = anim.samplers[channel.sampler];
    if (!sampler) {
      issues.push(`${where}.channels[${c}] 引用的 samplers[${channel.sampler}] 不存在`);
      declaredMissing.push(`channels[${c}] 的采样器不存在`);
      actualMissing.push(`channels[${c}] 的采样器不存在`);
      return;
    }
    const input = doc.accessors?.[sampler.input];
    const maxDeclared = input?.max?.[0];
    if (!input) declaredMissing.push(`输入访问器 accessors[${sampler.input}] 不存在`);
    else if (maxDeclared === undefined) declaredMissing.push(`输入访问器 accessors[${sampler.input}] 缺 max`);
    else declaredMax.push(maxDeclared);

    const time = timeMax(sampler.input);
    if (time.ok) actualMax.push(time.value);
    else actualMissing.push(time.reason);

    if (channel.target.path === 'translation' && channel.target.node !== undefined) {
      const node = channel.target.node;
      const output = data.accessor(sampler.output);
      let displacement: HorizontalMotionReport['displacement'];
      if (!output.ok) {
        displacement = notComputed(output.reason);
      } else if (output.value.components !== 3 || output.value.count === 0) {
        displacement = notComputed(`输出访问器 accessors[${sampler.output}] 不是非空的 VEC3`);
      } else {
        // CUBICSPLINE 的输出按 [入切线, 值, 出切线] 排列，取中间的值。
        const cubic = sampler.interpolation === 'CUBICSPLINE';
        const keys = cubic ? Math.floor(output.value.count / 3) : output.value.count;
        const keyAt = (k: number) => data.element(output.value, cubic ? k * 3 + 1 : k);
        const first = keys > 0 ? keyAt(0) : null;
        const last = keys > 0 ? keyAt(keys - 1) : null;
        if (!first || !last) {
          displacement = notComputed(`输出访问器 accessors[${sampler.output}] 没有关键帧`);
        } else if (!first.ok) {
          displacement = notComputed(first.reason);
        } else if (!last.ok) {
          displacement = notComputed(last.reason);
        } else {
          const from: [number, number] = [first.value[0] ?? 0, first.value[2] ?? 0];
          const to: [number, number] = [last.value[0] ?? 0, last.value[2] ?? 0];
          const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
          displacement = Number.isFinite(distance)
            ? computed({ from, to, distance })
            : notComputed('位移超出数值范围（坐标过大）');
        }
      }
      horizontalMotion.push({ channel: c, node, nodeName: doc.nodes?.[node]?.name ?? null, displacement });
    }
  });

  const noChannels = anim.channels.length === 0 ? '片段没有通道' : null;
  const declared: Metric<number> =
    noChannels !== null
      ? notComputed(noChannels)
      : declaredMissing.length > 0
        ? notComputed(joinReasons(declaredMissing))
        : computed(maxOf(declaredMax));
  const actual: Metric<number> =
    noChannels !== null
      ? notComputed(noChannels)
      : actualMissing.length > 0
        ? notComputed(joinReasons(actualMissing))
        : computed(maxOf(actualMax));

  return {
    index,
    rawName,
    unnamed,
    loaderName,
    channelCount: anim.channels.length,
    samplerCount: anim.samplers.length,
    targetPaths,
    duration: { declared, actual },
    extras: extrasOf(anim),
    loop: loopOf(anim),
    duplicateOf: [],
    horizontalMotion,
  };
}

function inspectAnimations(doc: GltfJson, data: GltfData, issues: string[]): AnimationsReport {
  const timeMax = timeMaxReader(data);
  const animations = (doc.animations ?? []).map((anim, i) => inspectAnimation(doc, data, timeMax, anim, i, issues));
  const byName = new Map<string, number[]>();
  for (const a of animations) byName.set(a.loaderName, [...(byName.get(a.loaderName) ?? []), a.index]);
  const duplicateNames = [...byName.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([name, indices]) => ({ name, indices }));
  const withDuplicates = animations.map((a) => ({
    ...a,
    duplicateOf: (byName.get(a.loaderName) ?? []).filter((i) => i !== a.index),
  }));
  return { count: animations.length, animations: withDuplicates, duplicateNames };
}

// ---------- 包围盒 ----------

class BoxBuilder {
  private min: Vec3 = [Infinity, Infinity, Infinity];
  private max: Vec3 = [-Infinity, -Infinity, -Infinity];
  private empty = true;

  add([x, y, z]: readonly [number, number, number]): void {
    this.empty = false;
    this.min = [Math.min(this.min[0], x), Math.min(this.min[1], y), Math.min(this.min[2], z)];
    this.max = [Math.max(this.max[0], x), Math.max(this.max[1], y), Math.max(this.max[2], z)];
  }

  /** emptyReason：一个点都没有加入时的原因。 */
  result(emptyReason: string): Metric<Box3> {
    if (this.empty) return notComputed(emptyReason);
    const size: Vec3 = [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]];
    if (![...this.min, ...this.max, ...size].every(Number.isFinite)) {
      return notComputed('计算结果超出数值范围（节点变换或坐标过大）');
    }
    return computed({ min: [...this.min], max: [...this.max], size });
  }
}

function inspectBounds(doc: GltfJson, data: GltfData, issues: string[]): BoundsReport {
  const { basis, instances } = traverseScene(doc, issues);
  const meshInstances = instances.filter((inst) => {
    if (doc.meshes?.[inst.mesh]) return true;
    issues.push(`nodes[${inst.node}] 引用的 meshes[${inst.mesh}] 不存在`);
    return false;
  });
  if (meshInstances.length === 0) {
    const reason = `${basis} 里没有引用网格的节点`;
    return { basis, declared: notComputed(reason), actual: notComputed(reason) };
  }
  return { basis, declared: declaredBounds(doc, meshInstances), actual: actualBounds(doc, data, meshInstances) };
}

function eachPrimitive(doc: GltfJson, instances: readonly MeshInstance[]) {
  return instances.flatMap((inst) =>
    (doc.meshes?.[inst.mesh]?.primitives ?? []).map((prim, p) => ({ inst, prim, where: `meshes[${inst.mesh}].primitives[${p}]` })),
  );
}

function declaredBounds(doc: GltfJson, instances: readonly MeshInstance[]): Metric<Box3> {
  const box = new BoxBuilder();
  const missing: string[] = [];
  for (const { inst, prim, where } of eachPrimitive(doc, instances)) {
    const index = prim.attributes.POSITION;
    const acc = index === undefined ? undefined : doc.accessors?.[index];
    if (index === undefined || !acc) {
      missing.push(`${where} 没有可用的 POSITION 访问器`);
      continue;
    }
    if (!acc.min || !acc.max || acc.min.length < 3 || acc.max.length < 3) {
      missing.push(`${where} 的 POSITION 访问器 accessors[${index}] 缺 min/max`);
      continue;
    }
    const n = (v: number | undefined) => normalizeDeclared(v ?? 0, acc.componentType, acc.normalized ?? false);
    const lo = [n(acc.min[0]), n(acc.min[1]), n(acc.min[2])] as const;
    const hi = [n(acc.max[0]), n(acc.max[1]), n(acc.max[2])] as const;
    for (let corner = 0; corner < 8; corner++) {
      box.add(
        transformPoint(inst.world, corner & 1 ? hi[0] : lo[0], corner & 2 ? hi[1] : lo[1], corner & 4 ? hi[2] : lo[2]),
      );
    }
  }
  if (missing.length > 0) return notComputed(joinReasons(missing));
  return box.result('没有图元');
}

function actualBounds(doc: GltfJson, data: GltfData, instances: readonly MeshInstance[]): Metric<Box3> {
  const box = new BoxBuilder();
  const missing: string[] = [];
  for (const { inst, prim, where } of eachPrimitive(doc, instances)) {
    const compression = primitiveCompression(prim.extensions);
    if (compression) {
      missing.push(`${where} 使用 ${compression}，需要解码器；本工具不解码`);
      continue;
    }
    const index = prim.attributes.POSITION;
    if (index === undefined) {
      missing.push(`${where} 没有 POSITION`);
      continue;
    }
    const positions = data.accessor(index);
    if (!positions.ok) {
      missing.push(positions.reason);
      continue;
    }
    if (positions.value.components !== 3) {
      missing.push(`${where} 的 POSITION 不是 VEC3`);
      continue;
    }
    const scanned = data.scan(positions.value, ([x = 0, y = 0, z = 0]) => {
      box.add(transformPoint(inst.world, x, y, z));
    });
    if (!scanned.ok) missing.push(scanned.reason);
  }
  if (missing.length > 0) return notComputed(joinReasons(missing));
  return box.result('所有图元都没有顶点');
}

// ---------- 入口 ----------

function externalResources(doc: GltfJson): ExternalResource[] {
  const list: ExternalResource[] = [];
  (doc.buffers ?? []).forEach((buffer, i) => {
    if (buffer.uri !== undefined && !isDataUri(buffer.uri)) list.push({ kind: 'buffer', index: i, uri: buffer.uri });
  });
  (doc.images ?? []).forEach((image, i) => {
    if (image.uri !== undefined && !isDataUri(image.uri)) list.push({ kind: 'image', index: i, uri: image.uri });
  });
  return list;
}

function decodeJsonChunk(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; message: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, message: 'JSON 块以 UTF-8 BOM 开头（规范不允许）' };
  }
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0) {
    return { ok: false, message: 'JSON 块末尾是 0 字节（规范要求用空格补齐），无法按 JSON 解析' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, message: 'JSON 块不是合法的 UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: `JSON 块无法解析：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function inspectGlb(input: ArrayBuffer | Uint8Array): InspectResult {
  const bytes = toBytes(input);
  const parsed = parseGlbContainer(bytes);
  if (!parsed.ok) return parsed;
  const { container } = parsed;
  const issues = [...container.issues];

  const json = decodeJsonChunk(container.json);
  if (!json.ok) return { ok: false, error: { code: 'invalid-json', message: json.message } };
  if (!isPlainObject(json.value)) {
    return { ok: false, error: { code: 'invalid-gltf', message: `JSON 块的顶层是 ${valueType(json.value)}，应为对象` } };
  }
  const schema = gltfSchema.safeParse(json.value);
  if (!schema.success) {
    return { ok: false, error: { code: 'invalid-gltf', message: `glTF JSON 结构不合法：${formatSchemaIssues(schema.error)}` } };
  }
  const doc = schema.data;

  const invalid = (message: string): InspectResult => ({ ok: false, error: { code: 'invalid-gltf', message } });
  if (!doc.asset) return invalid('缺少必需的 asset 对象');
  if (doc.asset.version === undefined) return invalid('缺少必需的 asset.version');
  if (!/^2\.\d+$/.test(doc.asset.version)) return invalid(`asset.version 是 "${doc.asset.version}"，只支持 glTF 2.x`);
  const binError = checkBinChunk(doc, container.bin, issues);
  if (binError) return { ok: false, error: { code: 'bad-chunks', message: binError } };
  const used = doc.extensionsUsed ?? [];
  const required = doc.extensionsRequired ?? [];
  for (const ext of required) {
    if (!used.includes(ext)) issues.push(`extensionsRequired 里的 ${ext} 没有出现在 extensionsUsed 里`);
  }

  const data = new GltfData(doc, container.bin, issues);
  const report: InspectReport = {
    reportVersion: 1,
    container: container.report,
    asset: {
      generator: doc.asset.generator ?? null,
      version: doc.asset.version,
      minVersion: doc.asset.minVersion ?? null,
    },
    extensionsUsed: used,
    extensionsRequired: required,
    externalResources: externalResources(doc),
    meshes: inspectMeshes(doc, data, issues),
    textures: inspectTextures(doc, data),
    skins: inspectSkins(doc),
    animations: inspectAnimations(doc, data, issues),
    bounds: inspectBounds(doc, data, issues),
    issues,
  };
  return { ok: true, report };
}

/** BIN 块与 buffers[0] 的对应关系。返回错误信息；没有错误返回 null。 */
function checkBinChunk(doc: GltfJson, bin: Uint8Array | null, issues: string[]): string | null {
  const first = doc.buffers?.[0];
  const glbStored = first !== undefined && first.uri === undefined;
  if (first && glbStored) {
    if (!bin) return 'buffers[0] 没有 uri（指向 GLB 的 BIN 块），但文件里没有 BIN 块';
    if (bin.byteLength < first.byteLength) {
      return `BIN 块只有 ${bin.byteLength} 字节，小于 buffers[0].byteLength（${first.byteLength}）`;
    }
    if (bin.byteLength > first.byteLength + 3) {
      return `BIN 块有 ${bin.byteLength} 字节，比 buffers[0].byteLength（${first.byteLength}）多出 ${bin.byteLength - first.byteLength} 字节（规范最多允许 3 字节补齐）`;
    }
  }
  if (!glbStored && bin) issues.push('文件有 BIN 块，但没有 buffer 引用它（buffers[0] 有 uri 或没有 buffers）');
  return null;
}

/** 报告里要标出的“需要解码器”的扩展。 */
export function decoderExtensionsIn(list: readonly string[]): string[] {
  return list.filter((ext) => DECODER_EXTENSIONS.includes(ext));
}
