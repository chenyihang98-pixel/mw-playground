// 夹具用的图片字节：一个真实可解码的 PNG 编码器（未压缩 deflate），和一个只有文件头的 JPEG。

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crc = crc32(concat([typeBytes, data]));
  return concat([u32be(data.byteLength), typeBytes, data, u32be(crc)]);
}

/** 用“存储”（不压缩）的 deflate 块编码 zlib 流。 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const MAX = 0xffff;
  let offset = 0;
  do {
    const len = Math.min(MAX, raw.byteLength - offset);
    const final = offset + len >= raw.byteLength ? 1 : 0;
    const header = new Uint8Array([final, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff]);
    parts.push(header, raw.subarray(offset, offset + len));
    offset += len;
  } while (offset < raw.byteLength);
  parts.push(u32be(adler32(raw)));
  return concat(parts);
}

/** 编码 8 位 RGBA PNG。rgba 长度必须是 width*height*4。 */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  if (rgba.byteLength !== width * height * 4) throw new Error('PNG 像素数据长度不对');
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 过滤类型 None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width, false);
  v.setUint32(4, height, false);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** 棋盘格 PNG。 */
export function checkerPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (x + y) % 2 === 0;
      const i = (y * width + x) * 4;
      rgba[i] = on ? 230 : 60;
      rgba[i + 1] = on ? 200 : 90;
      rgba[i + 2] = on ? 120 : 160;
      rgba[i + 3] = 255;
    }
  }
  return encodePngRgba(width, height, rgba);
}

/**
 * 只有文件头的 JPEG（SOI + APP0/JFIF + SOF0 + EOI），没有图像数据，不能解码。
 * 只用于测试“从 JPEG 头读尺寸”。
 */
export function jpegHeaderOnly(width: number, height: number): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64_ALPHABET.charAt((n >>> 18) & 63);
    out += BASE64_ALPHABET.charAt((n >>> 12) & 63);
    out += b1 === undefined ? '=' : BASE64_ALPHABET.charAt((n >>> 6) & 63);
    out += b2 === undefined ? '=' : BASE64_ALPHABET.charAt(n & 63);
  }
  return out;
}
