// 读取 buffer / bufferView / accessor 的数据。读不了时返回原因，不抛异常，也不猜数据。

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
    value = (value << 6) | v;
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

export interface ReadAccessor {
  readonly values: Float64Array;
  readonly components: number;
  readonly count: number;
}

/** 把 glTF JSON 里的 buffers / bufferViews / accessors 解析成可读的数据，带缓存。 */
export class GltfData {
  private readonly buffers: DataResult<Uint8Array>[];
  private readonly accessorCache = new Map<number, DataResult<ReadAccessor>>();

  constructor(
    private readonly doc: GltfJson,
    bin: Uint8Array | null,
    issues: string[],
  ) {
    this.buffers = (doc.buffers ?? []).map((buffer, i): DataResult<Uint8Array> => {
      if (buffer.uri === undefined) {
        if (i !== 0) return fail(`buffers[${i}] 没有 uri（只有 buffers[0] 可以指向 BIN 块）`);
        if (!bin) return fail('buffers[0] 没有 uri，但 GLB 里没有 BIN 块');
        if (bin.byteLength < buffer.byteLength) {
          issues.push(`BIN 块只有 ${bin.byteLength} 字节，小于 buffers[0].byteLength（${buffer.byteLength}）`);
          return fail(`BIN 块只有 ${bin.byteLength} 字节，小于 buffers[0].byteLength（${buffer.byteLength}）`);
        }
        return ok(bin.subarray(0, buffer.byteLength));
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

  bufferView(index: number): DataResult<{ bytes: Uint8Array; byteStride: number | undefined }> {
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
    return ok({ bytes: buffer.value.subarray(start, end), byteStride: view.byteStride });
  }

  accessor(index: number): DataResult<ReadAccessor> {
    const cached = this.accessorCache.get(index);
    if (cached) return cached;
    const result = this.readAccessor(index);
    this.accessorCache.set(index, result);
    return result;
  }

  private readAccessor(index: number): DataResult<ReadAccessor> {
    const acc = this.doc.accessors?.[index];
    if (!acc) return fail(`accessors[${index}] 不存在`);
    if (acc.sparse !== undefined) return fail(`accessors[${index}] 是稀疏访问器（sparse），本工具未实现读取`);
    const components = accessorComponentCount(acc.type);
    const componentSize = componentByteSize(acc.componentType);
    if (components === undefined) return fail(`accessors[${index}] 的 type "${acc.type}" 未知`);
    if (componentSize === undefined) return fail(`accessors[${index}] 的 componentType ${acc.componentType} 未知`);
    if ((acc.type === 'MAT2' || acc.type === 'MAT3') && componentSize < 4) {
      return fail(`accessors[${index}] 是带列对齐的 ${acc.type}，本工具未实现读取`);
    }
    const values = new Float64Array(acc.count * components);
    if (acc.bufferView === undefined) {
      // 规范：没有 bufferView 的访问器全为 0。
      return ok({ values, components, count: acc.count });
    }
    const view = this.bufferView(acc.bufferView);
    if (!view.ok) return fail(view.reason);
    const elementSize = components * componentSize;
    const stride = view.value.byteStride ?? elementSize;
    const base = acc.byteOffset ?? 0;
    const bytes = view.value.bytes;
    if (acc.count > 0 && base + stride * (acc.count - 1) + elementSize > bytes.byteLength) {
      return fail(`accessors[${index}] 超出 bufferViews[${acc.bufferView}] 的范围`);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read = componentReader(acc.componentType, acc.normalized ?? false);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < components; c++) {
        values[i * components + c] = read(dv, base + i * stride + c * componentSize);
      }
    }
    return ok({ values, components, count: acc.count });
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
