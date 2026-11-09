// 解析 GLB 容器：12 字节头、JSON 块、可选的 BIN 块。

import {
  CHUNK_TYPE_BIN,
  CHUNK_TYPE_JSON,
  GLB_CHUNK_HEADER_BYTES,
  GLB_HEADER_BYTES,
  GLB_MAGIC,
  GLB_VERSION,
} from '../gltf/constants';
import type { ChunkReport, ContainerReport, InspectError, InspectErrorCode } from './types';

export interface GlbContainer {
  readonly report: ContainerReport;
  readonly json: Uint8Array;
  readonly bin: Uint8Array | null;
  readonly issues: readonly string[];
}

export type ContainerResult = { readonly ok: true; readonly container: GlbContainer } | { readonly ok: false; readonly error: InspectError };

function hex32(n: number): string {
  return `0x${n.toString(16).padStart(8, '0')}`;
}

function asciiPreview(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < Math.min(length, bytes.byteLength); i++) {
    const b = bytes[i] ?? 0;
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return out;
}

function latin1(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < Math.min(length, bytes.byteLength); i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/** 文件不是 GLB 时，猜一下它是什么，给出更明确的原因。 */
export function sniffNonGlb(bytes: Uint8Array): string | null {
  const head = latin1(bytes, 1024);
  const trimmed = head.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) return '看起来是 JSON 文本（可能是 .gltf），不是 GLB 二进制容器';
  if (/^ply\r?\n/.test(head)) return '看起来是 PLY 文件';
  if (bytes.byteLength >= 84) {
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (bytes.byteLength === 84 + triangles * 50) return '看起来是二进制 STL 文件';
  }
  if (/^solid[ \t\r\n]/.test(trimmed)) return '看起来是 ASCII STL 文件';
  if (/^(#|v |vn |vt |f |o |g |mtllib |usemtl |s )/m.test(trimmed)) return '看起来是 OBJ 文本';
  if (head.startsWith('\x89PNG')) return '看起来是 PNG 图片';
  if (head.startsWith('\xff\xd8')) return '看起来是 JPEG 图片';
  if (head.startsWith('PK\x03\x04')) return '看起来是 ZIP 压缩包';
  if (head.startsWith('Kaydara FBX Binary')) return '看起来是 FBX 文件';
  return null;
}

function badContainer(code: InspectErrorCode, message: string): ContainerResult {
  return { ok: false, error: { code, message } };
}

function notGlb(bytes: Uint8Array, detail: string): ContainerResult {
  const hint = sniffNonGlb(bytes);
  return {
    ok: false,
    error: { code: 'not-glb', message: `不是 GLB 文件：${detail}${hint ? `；${hint}` : ''}` },
  };
}

export function parseGlbContainer(bytes: Uint8Array): ContainerResult {
  const actualLength = bytes.byteLength;
  if (actualLength === 0) return { ok: false, error: { code: 'empty', message: '文件是空的（0 字节）' } };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (actualLength < 4) return notGlb(bytes, `文件只有 ${actualLength} 字节，放不下 magic`);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    return notGlb(bytes, `开头 4 字节是 ${hex32(magic)}（"${asciiPreview(bytes, 4)}"），应为 0x46546c67（"glTF"）`);
  }
  if (actualLength < GLB_HEADER_BYTES) {
    return {
      ok: false,
      error: { code: 'truncated', message: `文件被截断：只有 ${actualLength} 字节，放不下 12 字节的 GLB 头` },
    };
  }
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) {
    return {
      ok: false,
      error: { code: 'unsupported-version', message: `容器版本是 ${version}，只支持 GLB 2（glTF 2.0）` },
    };
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength > actualLength) {
    return {
      ok: false,
      error: {
        code: 'truncated',
        message: `文件被截断：头部声明长度 ${declaredLength} 字节，实际只有 ${actualLength} 字节`,
      },
    };
  }

  if (declaredLength < actualLength) {
    return badContainer(
      'length-mismatch',
      `头部声明长度 ${declaredLength} 字节，小于实际长度 ${actualLength} 字节（文件末尾多出 ${actualLength - declaredLength} 字节）`,
    );
  }

  // 下面检查到的都是容器损坏：不合规范的 GLB 不当作检查成功。
  // 只有未知类型的块是规范允许的（读取方必须忽略），记在问题里。
  const issues: string[] = [];
  const chunks: ChunkReport[] = [];
  let offset = GLB_HEADER_BYTES;
  while (offset < declaredLength) {
    const index = chunks.length;
    if (offset + GLB_CHUNK_HEADER_BYTES > declaredLength) {
      return badContainer('bad-chunks', `第 ${index} 个块的块头不完整（偏移 ${offset}，声明长度 ${declaredLength}）`);
    }
    const length = view.getUint32(offset, true);
    const typeCode = view.getUint32(offset + 4, true);
    const dataStart = offset + GLB_CHUNK_HEADER_BYTES;
    if (dataStart + length > declaredLength) {
      return badContainer(
        'bad-chunks',
        `第 ${index} 个块声明长度 ${length} 字节，超出了文件声明长度（块数据从偏移 ${dataStart} 开始，文件声明长度 ${declaredLength}）`,
      );
    }
    const type = typeCode === CHUNK_TYPE_JSON ? 'JSON' : typeCode === CHUNK_TYPE_BIN ? 'BIN' : 'unknown';
    if (length % 4 !== 0) {
      return badContainer('bad-chunks', `第 ${index} 个块（${type}）长度 ${length} 字节，不是 4 的倍数（规范要求块按 4 字节对齐）`);
    }
    if (index === 0 && type !== 'JSON') {
      return badContainer('bad-chunks', `第一个块的类型是 ${hex32(typeCode)}，应为 JSON 块（0x4e4f534a）`);
    }
    if (index > 0 && type === 'JSON') {
      return badContainer('bad-chunks', `第 ${index} 个块又是 JSON 块（规范只允许一个 JSON 块）`);
    }
    if (index !== 1 && type === 'BIN') {
      return badContainer('bad-chunks', `第 ${index} 个块是 BIN 块（规范只允许一个 BIN 块，而且必须是第二个块）`);
    }
    if (type === 'unknown') issues.push(`第 ${index} 个块类型未知（${hex32(typeCode)}），按规范忽略`);
    chunks.push({ index, type, typeCode, byteOffset: dataStart, byteLength: length });
    offset = dataStart + length;
  }

  const first = chunks[0];
  if (!first) return badContainer('bad-chunks', 'GLB 里没有任何块（缺少 JSON 块）');
  const second = chunks[1];
  const bin = second?.type === 'BIN' ? bytes.subarray(second.byteOffset, second.byteOffset + second.byteLength) : null;

  return {
    ok: true,
    container: {
      report: {
        fileSize: actualLength,
        version,
        declaredLength,
        actualLength,
        lengthMatches: declaredLength === actualLength,
        chunks,
      },
      json: bytes.subarray(first.byteOffset, first.byteOffset + first.byteLength),
      bin,
      issues,
    },
  };
}
