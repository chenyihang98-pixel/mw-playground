// 可复现的随机数：只由种子（字符串）决定，不用 Math.random 或墙钟。纯模块。
// 种子先用 cyrb128 散列成 128 位状态，再用 sfc32 生成随机数；子种子由“父种子 + 标签”派生。

function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** 由父种子和标签派生子种子（例如每次布局尝试一个）。 */
export function deriveSeed(seed: string, label: string): string {
  return `${seed}/${label}`;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(seed);
  }

  /** [0, 1) 的随机数（sfc32）。 */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** [min, max] 的整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** [min, max) 的实数。 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('不能从空列表里选');
    return item;
  }

  /** 打乱后的副本（Fisher–Yates）。 */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /** 由这个随机数的种子派生出的子随机数（与当前状态无关，只由种子和标签决定）。 */
  child(label: string): Rng {
    return new Rng(deriveSeed(this.seed, label));
  }
}

/** 字符串的 64 位 FNV-1a 散列（16 位十六进制）。用来给布局算哈希、给关卡起 id。 */
export function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ k, 0x01000193);
    h2 = Math.imul(h2 ^ k ^ (h1 >>> 7), 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 对象的规范 JSON（键按字母排序），哈希用。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // undefined、函数等没有 JSON 表示的值按 null 处理
  const text = JSON.stringify(value) as string | undefined;
  return text ?? 'null';
}
