// 读取 buffer / bufferView / accessor 的数据。读不了时返回原因，不抛异常，也不猜数据。
// 先按 JSON 里声明的长度检查访问区间，再读数据；读取时不按 count 分配数组，内存只与文件大小有关。

import { BUFFER_VIEW_DECODER_EXTENSIONS, accessorComponentCount, componentByteSize } from '../gltf/constants';
import type { GltfJson } from './schema';

export type DataResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const ok = <T>(value: T): DataResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): DataResult<T> => ({ ok: false, reason });

const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // base64url
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? (BASE64_LOOKUP[code] ?? -1) : -1;
    if (v < 0) return null;
    value = ((value << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** 解码 data: URI。只在内存里处理，不访问任何外部资源。 */
export function decodeDataUri(uri: string): DataResult<{ mediaType: string; bytes: Uint8Array }> {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) return fail('data URI 格式错误');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const mediaType = (isBase64 ? meta.slice(0, -7) : meta).split(';')[0] ?? '';
  if (isBase64) {
    const bytes = decodeBase64(payload);
    return bytes ? ok({ mediaType, bytes }) : fail('data URI 的 base64 内容无法解码');
  }
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    if (ch === 0x25 && i + 2 < payload.length) {
      const byte = Number.parseInt(payload.slice(i + 1, i + 3), 16);
      if (Number.isNaN(byte)) return fail('data URI 的百分号转义无法解码');
      bytes.push(byte);
      i += 2;
    } else {
      bytes.push(ch & 0xff);
    }
  }
  return ok({ mediaType, bytes: Uint8Array.from(bytes) });
}

export function isDataUri(uri: string): boolean {
  return uri.startsWith('data:');
}

/** 访问器的内存布局（只根据 JSON 声明的长度检查过）。 */
export interface AccessorLayout {
  readonly index: number;
  readonly count: number;
  readonly components: number;
  readonly componentType: number;
  readonly componentSize: number;
  readonly normalized: boolean;
  /** undefined：没有 bufferView，按规范全为 0。 */
  readonly bufferView: number | undefined;
  /** 在 bufferView 内的起始偏移。 */
  readonly byteOffset: number;
  readonly stride: number;
}

/** 可以逐个读取元素的访问器。不复制数据。 */
export interface AccessorView {
  readonly index: number;
  readonly count: number;
  readonly components: number;
  /** 需要逐个检查的元素数：全零的访问器（没有 bufferView）只有一种值，只检查 1 个。 */
  readonly distinctCount: number;
  /** 读第 element 个元素的第 component 个分量（已按 normalized 换算）。调用方保证下标在范围内。 */
  get(element: number, component: number): number;
}

/** 把 glTF JSON 里的 buffers / bufferViews / accessors 解析成可读的数据，带缓存。 */
export class GltfData {
  private readonly buffers: DataResult<Uint8Array>[];
  private readonly accessorCache = new Map<number, DataResult<AccessorView>>();
  private readonly nonFiniteReported = new Set<number>();

  /** bin 的长度已由调用方核对过（不短于 buffers[0].byteLength）。 */
  constructor(
    private readonly doc: GltfJson,
    bin: Uint8Array | null,
    private readonly issues: string[],
  ) {
    this.buffers = (doc.buffers ?? []).map((buffer, i): DataResult<Uint8Array> => {
      if (buffer.uri === undefined) {
        if (i === 0 && bin) return ok(bin.subarray(0, buffer.byteLength));
        if (i === 0) return fail('buffers[0] 没有 uri，但 GLB 里没有 BIN 块');
        const meshoptFallback = BUFFER_VIEW_DECODER_EXTENSIONS.some((name) => buffer.extensions?.[name] !== undefined);
        if (meshoptFallback) return fail(`buffers[${i}] 是 meshopt 压缩的回退 buffer，没有数据`);
        issues.push(`buffers[${i}] 没有 uri（只有 buffers[0] 可以指向 BIN 块）`);
        return fail(`buffers[${i}] 没有 uri，也不是 buffers[0]，没有数据来源`);
      }
      if (isDataUri(buffer.uri)) {
        const decoded = decodeDataUri(buffer.uri);
        if (!decoded.ok) return fail(`buffers[${i}] 的 ${decoded.reason}`);
        if (decoded.value.bytes.byteLength < buffer.byteLength) {
          return fail(`buffers[${i}] 的 data URI 只有 ${decoded.value.bytes.byteLength} 字节，小于 byteLength（${buffer.byteLength}）`);
        }
        return ok(decoded.value.bytes.subarray(0, buffer.byteLength));
      }
      return fail(`buffers[${i}] 引用外部文件 "${buffer.uri}"，本工具不读取外部资源`);
    });
  }

  /** 只用 JSON 声明的长度检查访问器的区间（外部 buffer 也能检查），不读数据。 */
  layout(index: number): DataResult<AccessorLayout> {
    const acc = this.doc.accessors?.[index];
    if (!acc) return fail(`accessors[${index}] 不存在`);
    const components = accessorComponentCount(acc.type);
    const componentSize = componentByteSize(acc.componentType);
    if (components === undefined) return fail(`accessors[${index}] 的 type "${acc.type}" 未知`);
    if (componentSize === undefined) return fail(`accessors[${index}] 的 componentType ${acc.componentType} 未知`);
    if ((acc.type === 'MAT2' || acc.type === 'MAT3') && componentSize < 4) {
      return fail(`accessors[${index}] 是带列对齐的 ${acc.type}，本工具未实现读取`);
    }
    const elementSize = components * componentSize;
    const base = {
      index,
      count: acc.count,
      components,
      componentType: acc.componentType,
      componentSize,
      normalized: acc.normalized ?? false,
    };
    if (acc.bufferView === undefined) return ok({ ...base, bufferView: undefined, byteOffset: 0, stride: elementSize });

    const view = this.doc.bufferViews?.[acc.bufferView];
    if (!view) return fail(`accessors[${index}] 引用的 bufferViews[${acc.bufferView}] 不存在`);
    if (view.byteStride !== undefined && view.byteStride < elementSize) {
      return fail(`bufferViews[${acc.bufferView}] 的 byteStride（${view.byteStride}）小于 accessors[${index}] 的元素大小（${elementSize}）`);
    }
    const stride = view.byteStride ?? elementSize;
    const byteOffset = acc.byteOffset ?? 0;
    if (acc.count > 0 && byteOffset + stride * (acc.count - 1) + elementSize > view.byteLength) {
      return fail(
        `accessors[${index}]（count ${acc.count}）超出 bufferViews[${acc.bufferView}] 的范围（bufferView 只有 ${view.byteLength} 字节）`,
      );
    }
    const buffer = this.doc.buffers?.[view.buffer];
    if (!buffer) return fail(`bufferViews[${acc.bufferView}] 引用的 buffers[${view.buffer}] 不存在`);
    const viewEnd = (view.byteOffset ?? 0) + view.byteLength;
    if (viewEnd > buffer.byteLength) {
      return fail(`bufferViews[${acc.bufferView}] 超出 buffers[${view.buffer}] 的范围（结束于 ${viewEnd}，byteLength 只有 ${buffer.byteLength}）`);
    }
    return ok({ ...base, bufferView: acc.bufferView, byteOffset, stride });
  }

  bufferView(index: number): DataResult<Uint8Array> {
    const view = this.doc.bufferViews?.[index];
    if (!view) return fail(`bufferViews[${index}] 不存在`);
    const ext = BUFFER_VIEW_DECODER_EXTENSIONS.find((name) => view.extensions?.[name] !== undefined);
    if (ext) return fail(`bufferViews[${index}] 使用 ${ext}，需要解码器`);
    const buffer = this.buffers[view.buffer];
    if (!buffer) return fail(`bufferViews[${index}] 引用的 buffers[${view.buffer}] 不存在`);
    if (!buffer.ok) return fail(buffer.reason);
    const start = view.byteOffset ?? 0;
    const end = start + view.byteLength;
    if (end > buffer.value.byteLength) {
      return fail(`bufferViews[${index}] 越界（结束于 ${end}，buffers[${view.buffer}] 只有 ${buffer.value.byteLength} 字节）`);
    }
    return ok(buffer.value.subarray(start, end));
  }

  accessor(index: number): DataResult<AccessorView> {
    const cached = this.accessorCache.get(index);
    if (cached) return cached;
    const result = this.openAccessor(index);
    this.accessorCache.set(index, result);
    return result;
  }

  private openAccessor(index: number): DataResult<AccessorView> {
    const layout = this.layout(index);
    if (!layout.ok) return layout;
    const { count, components, stride, byteOffset, componentSize } = layout.value;
    if (this.doc.accessors?.[index]?.sparse !== undefined) {
      return fail(`accessors[${index}] 是稀疏访问器（sparse），本工具未实现读取`);
    }
    if (layout.value.bufferView === undefined) {
      // 规范：没有 bufferView 的访问器全为 0。不按 count 分配，也不逐个遍历。
      return ok({ index, count, components, distinctCount: Math.min(count, 1), get: () => 0 });
    }
    const bytes = this.bufferView(layout.value.bufferView);
    if (!bytes.ok) return bytes;
    // layout 已按 bufferView.byteLength 检查过区间，bufferView() 保证实际字节数等于 byteLength。
    const dv = new DataView(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength);
    const read = componentReader(layout.value.componentType, layout.value.normalized);
    return ok({
      index,
      count,
      components,
      distinctCount: count,
      get: (element, component) => read(dv, byteOffset + element * stride + component * componentSize),
    });
  }

  /** 读一个元素；含 NaN / Infinity 时返回原因。 */
  element(view: AccessorView, element: number): DataResult<number[]> {
    const values: number[] = [];
    for (let c = 0; c < view.components; c++) {
      const v = view.get(element, c);
      if (!Number.isFinite(v)) return this.nonFinite(view, element, v);
      values.push(v);
    }
    return ok(values);
  }

  /** 逐个读取需要检查的元素；遇到 NaN / Infinity 立即返回原因，并记一条问题。 */
  scan(view: AccessorView, visit: (values: readonly number[]) => void): DataResult<void> {
    const values = new Array<number>(view.components).fill(0);
    for (let e = 0; e < view.distinctCount; e++) {
      for (let c = 0; c < view.components; c++) {
        const v = view.get(e, c);
        if (!Number.isFinite(v)) return this.nonFinite(view, e, v);
        values[c] = v;
      }
      visit(values);
    }
    return ok(undefined);
  }

  private nonFinite<T>(view: AccessorView, element: number, value: number): DataResult<T> {
    const reason = `accessors[${view.index}] 第 ${element} 个元素含非有限数值（${String(value)}）`;
    if (!this.nonFiniteReported.has(view.index)) {
      this.nonFiniteReported.add(view.index);
      this.issues.push(reason);
    }
    return fail(reason);
  }
}

/** 按 componentType 读一个分量；normalized 时按规范换算到 [0,1] 或 [-1,1]。 */
export function componentReader(componentType: number, normalized: boolean): (dv: DataView, offset: number) => number {
  switch (componentType) {
    case 5120:
      return normalized ? (dv, o) => Math.max(dv.getInt8(o) / 127, -1) : (dv, o) => dv.getInt8(o);
    case 5121:
      return normalized ? (dv, o) => dv.getUint8(o) / 255 : (dv, o) => dv.getUint8(o);
    case 5122:
      return normalized ? (dv, o) => Math.max(dv.getInt16(o, true) / 32767, -1) : (dv, o) => dv.getInt16(o, true);
    case 5123:
      return normalized ? (dv, o) => dv.getUint16(o, true) / 65535 : (dv, o) => dv.getUint16(o, true);
    case 5125:
      return (dv, o) => dv.getUint32(o, true);
    default:
      return (dv, o) => dv.getFloat32(o, true);
  }
}

/** 把声明的 min/max（存储值）按 normalized 规则换算成实际值。 */
export function normalizeDeclared(value: number, componentType: number, normalized: boolean): number {
  if (!normalized) return value;
  switch (componentType) {
    case 5120:
      return Math.max(value / 127, -1);
    case 5121:
      return value / 255;
    case 5122:
      return Math.max(value / 32767, -1);
    case 5123:
      return value / 65535;
    default:
      return value;
  }
}
