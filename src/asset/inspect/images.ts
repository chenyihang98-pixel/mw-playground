// 从内嵌图片的文件头读尺寸。只认 PNG 和 JPEG，不解码像素。

import type { ImageSize } from './types';

export type SniffedFormat = 'png' | 'jpeg';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffImageFormat(bytes: Uint8Array): SniffedFormat | null {
  if (bytes.byteLength >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

export type ImageSizeResult =
  | { readonly ok: true; readonly format: SniffedFormat; readonly size: ImageSize }
  | { readonly ok: false; readonly format: SniffedFormat | null; readonly reason: string };

function readPngSize(bytes: Uint8Array): ImageSizeResult {
  // 签名(8) + IHDR 长度(4) + "IHDR"(4) + 宽(4) + 高(4)
  if (bytes.byteLength < 24) return { ok: false, format: 'png', reason: 'PNG 文件头不完整' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== 'IHDR') return { ok: false, format: 'png', reason: 'PNG 的第一个块不是 IHDR' };
  return { ok: true, format: 'png', size: { width: view.getUint32(16, false), height: view.getUint32(20, false) } };
}

function isSofMarker(marker: number): boolean {
  // SOF0–SOF15，排除 DHT(C4)、JPG(C8)、DAC(CC)
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegSize(bytes: Uint8Array): ImageSizeResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // 跳过 SOI
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return { ok: false, format: 'jpeg', reason: `JPEG 段标记错误（偏移 ${offset}）` };
    let marker = bytes[offset + 1] ?? 0;
    // 跳过填充用的 0xFF
    while (marker === 0xff && offset + 2 < bytes.byteLength) {
      offset++;
      marker = bytes[offset + 1] ?? 0;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI 或 SOS：之后不会再有尺寸
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2; // 没有长度字段的独立标记
      continue;
    }
    if (offset + 4 > bytes.byteLength) break;
    const length = view.getUint16(offset + 2, false);
    if (isSofMarker(marker)) {
      if (offset + 9 > bytes.byteLength) break;
      return {
        ok: true,
        format: 'jpeg',
        size: { width: view.getUint16(offset + 7, false), height: view.getUint16(offset + 5, false) },
      };
    }
    if (length < 2) return { ok: false, format: 'jpeg', reason: `JPEG 段长度错误（偏移 ${offset}）` };
    offset += 2 + length;
  }
  return { ok: false, format: 'jpeg', reason: 'JPEG 文件头里没有找到 SOF 段' };
}

export function readImageSize(bytes: Uint8Array): ImageSizeResult {
  const format = sniffImageFormat(bytes);
  if (format === 'png') return readPngSize(bytes);
  if (format === 'jpeg') return readJpegSize(bytes);
  return { ok: false, format: null, reason: '不是 PNG 或 JPEG，未读取尺寸' };
}
