// 结构检查对异常数据的健壮性：巨大的 count、越界的访问区间、NaN / Infinity、数值溢出。
// 要求：不抛异常、不按 count 分配内存；受影响的指标写“未计算”和原因；报告里没有非有限数（JSON 里会变成 null）。

import { describe, expect, it } from 'vitest';
import { FIXTURES, GltfBuilder, encodeGlb, type JsonObject } from '../../src/asset/fixtures';
import { CHUNK_TYPE_BIN } from '../../src/asset/gltf/constants';
import { inspectGlb, type InspectReport, type Metric } from '../../src/asset/inspect';

function ok(bytes: Uint8Array): InspectReport {
  const result = inspectGlb(bytes);
  if (!result.ok) throw new Error(`应该能检查：${result.error.message}`);
  return result.report;
}

function value<T>(m: Metric<T>): T {
  if (m.status !== 'computed') throw new Error(`应为已计算：${m.reason}`);
  return m.value;
}

function reasonOf(m: Metric<unknown>): string {
  if (m.status !== 'not-computed') throw new Error(`应为未计算，实际值：${JSON.stringify(m.value)}`);
  return m.reason;
}

/** 报告里所有不是有限数的数字的位置。 */
function nonFiniteNumbers(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFiniteNumbers(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => nonFiniteNumbers(v, `${path}.${k}`));
  }
  return [];
}

/** 把 GLB 拆回 JSON 和 BIN，方便改字段后重新打包。 */
function splitGlb(bytes: Uint8Array): { json: JsonObject; bin: Uint8Array | undefined } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as JsonObject;
  const binStart = 20 + jsonLength;
  if (binStart + 8 > bytes.byteLength || view.getUint32(binStart + 4, true) !== CHUNK_TYPE_BIN) return { json, bin: undefined };
  const binLength = view.getUint32(binStart, true);
  return { json, bin: bytes.slice(binStart + 8, binStart + 8 + binLength) };
}

function triangle(): GltfBuilder {
  const b = new GltfBuilder();
  const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), type: 'VEC3' });
  b.addScene([b.addNode({ name: 'Tri', mesh: b.addMesh('Tri', [{ attributes: { POSITION: position } }]) })]);
  return b;
}

function accessors(json: JsonObject): JsonObject[] {
  return json.accessors as JsonObject[];
}

describe('巨大的或越界的 count', () => {
  it('POSITION.count = 2**50：不抛异常；三角面数和实际包围盒未计算，声明包围盒照常', () => {
    const b = triangle();
    const json = b.json();
    const acc = accessors(json)[0];
    if (acc) acc.count = 2 ** 50;
    const r = ok(encodeGlb(json, b.binary()));
    expect(reasonOf(r.meshes.triangles)).toContain('超出 bufferViews[0] 的范围');
    expect(reasonOf(r.bounds.actual)).toContain('超出 bufferViews[0] 的范围');
    expect(value(r.bounds.declared).max).toEqual([1, 1, 0]);
  });

  it('没有 bufferView 的全零访问器 count = 2**50：不分配、不逐个遍历，实际包围盒是原点', () => {
    const b = triangle();
    const json = b.json();
    const acc = accessors(json)[0];
    if (acc) {
      delete acc.bufferView;
      acc.count = 2 ** 50;
      acc.min = [0, 0, 0];
      acc.max = [0, 0, 0];
    }
    const started = Date.now();
    const r = ok(encodeGlb(json, b.binary()));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(value(r.bounds.actual)).toEqual({ min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] });
  });

  it('bufferView 超出 buffer 的 byteLength：外部 buffer 时也能按声明长度判断，三角面数未计算', () => {
    const b = triangle();
    const json = b.json({ externalBufferUri: 'outside.bin' });
    const views = json.bufferViews as JsonObject[];
    if (views[0]) views[0].byteLength = 4096;
    const r = ok(encodeGlb(json));
    expect(reasonOf(r.meshes.triangles)).toContain('超出 buffers[0] 的范围');
  });

  it('byteStride 小于元素大小：实际包围盒未计算', () => {
    const b = triangle();
    const json = b.json();
    const views = json.bufferViews as JsonObject[];
    if (views[0]) views[0].byteStride = 4;
    const r = ok(encodeGlb(json, b.binary()));
    expect(reasonOf(r.bounds.actual)).toContain('byteStride（4）小于');
  });
});

describe('NaN 和 Infinity', () => {
  it('POSITION 里有 NaN：实际包围盒未计算并说明原因，记一条问题；声明包围盒不受影响', () => {
    const b = triangle();
    const bin = b.binary();
    new DataView(bin.buffer).setFloat32(4, Number.NaN, true);
    const r = ok(encodeGlb(b.json(), bin));
    expect(reasonOf(r.bounds.actual)).toBe('accessors[0] 第 0 个元素含非有限数值（NaN）');
    expect(r.issues).toContain('accessors[0] 第 0 个元素含非有限数值（NaN）');
    expect(value(r.bounds.declared).max).toEqual([1, 1, 0]);
    expect(nonFiniteNumbers(r)).toEqual([]);
  });

  function animated(path: 'translation' | 'rotation') {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    const values = path === 'translation' ? [0, 0, 0, 2, 0, 0] : [0, 0, 0, 1, 0, 0, 0, 1];
    b.addAnimation({ name: 'a', channels: [{ node, path, times: [0, 1], values }] });
    return b;
  }

  it('动画时间里有 Infinity：实际时长未计算，声明时长照常', () => {
    const b = animated('rotation');
    const bin = b.binary();
    new DataView(bin.buffer).setFloat32(4, Number.POSITIVE_INFINITY, true); // 第 2 个时间值
    const a = ok(encodeGlb(b.json(), bin)).animations.animations[0];
    expect(a && reasonOf(a.duration.actual)).toContain('非有限数值（Infinity）');
    expect(a && value(a.duration.declared)).toBe(1);
  });

  it('动画时间里有 NaN：不会被静默忽略', () => {
    const b = animated('rotation');
    const bin = b.binary();
    new DataView(bin.buffer).setFloat32(0, Number.NaN, true);
    const a = ok(encodeGlb(b.json(), bin)).animations.animations[0];
    expect(a && reasonOf(a.duration.actual)).toContain('NaN');
  });

  it('平移输出里有 NaN：水平位移未计算', () => {
    const b = animated('translation');
    const json = b.json();
    const bin = b.binary();
    const outputView = (json.bufferViews as JsonObject[])[1];
    new DataView(bin.buffer).setFloat32(Number(outputView?.byteOffset ?? 0) + 12, Number.NaN, true); // 最后一个关键帧的 x
    const a = ok(encodeGlb(json, bin)).animations.animations[0];
    expect(a && reasonOf(a.horizontalMotion[0]?.displacement ?? { status: 'computed', value: null })).toContain('NaN');
  });

  it('节点变换导致数值溢出：包围盒未计算，不输出 Infinity', () => {
    const b = new GltfBuilder();
    const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 3e38, 0, 0, 0, 3e38, 0]), type: 'VEC3' });
    const mesh = b.addMesh('Huge', [{ attributes: { POSITION: position } }]);
    b.addScene([b.addNode({ mesh, scale: [1e300, 1e300, 1e300] })]);
    const r = ok(b.toGlb());
    expect(reasonOf(r.bounds.declared)).toContain('超出数值范围');
    expect(reasonOf(r.bounds.actual)).toContain('超出数值范围');
    expect(nonFiniteNumbers(r)).toEqual([]);
  });
});

describe('规模', () => {
  it('一个动画有 300000 个通道：不因展开参数超出调用栈而抛异常', () => {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    b.addAnimation({ name: 'many', channels: [{ node, path: 'scale', times: [0, 2], values: [1, 1, 1, 2, 2, 2] }] });
    const json = b.json();
    const anim = (json.animations as JsonObject[])[0];
    if (anim) anim.channels = Array.from({ length: 300_000 }, () => ({ sampler: 0, target: { node, path: 'scale' } }));
    const a = ok(encodeGlb(json, b.binary())).animations.animations[0];
    expect(a?.channelCount).toBe(300_000);
    expect(a && value(a.duration.declared)).toBe(2);
    expect(a && value(a.duration.actual)).toBe(2);
  });
});

describe('对所有合法夹具做变异：不抛异常，报告里没有非有限数', () => {
  const valid = FIXTURES.filter((f) => f.validGlb);

  function check(bytes: Uint8Array, label: string) {
    let result: ReturnType<typeof inspectGlb>;
    try {
      result = inspectGlb(bytes);
    } catch (error) {
      throw new Error(`${label}：抛出异常 ${String(error)}`);
    }
    if (result.ok) {
      expect(nonFiniteNumbers(result.report), label).toEqual([]);
      expect(JSON.parse(JSON.stringify(result.report)), label).toEqual(result.report);
    }
  }

  it.each(valid.map((f) => [f.id, f] as const))('%s：访问器和 bufferView 字段变异', (_id, fixture) => {
    const original = splitGlb(fixture.build());
    const accessorCount = accessors(original.json).length;
    const viewCount = ((original.json.bufferViews as JsonObject[] | undefined) ?? []).length;
    const mutate = (label: string, edit: (json: JsonObject) => void) => {
      const json = structuredClone(original.json);
      edit(json);
      check(encodeGlb(json, original.bin), `${fixture.id} ${label}`);
    };
    for (let i = 0; i < accessorCount; i++) {
      for (const count of [0, 1, 2 ** 31, 2 ** 50, Number.MAX_SAFE_INTEGER]) {
        mutate(`accessors[${i}].count=${count}`, (json) => {
          const acc = accessors(json)[i];
          if (acc) acc.count = count;
        });
      }
      mutate(`accessors[${i}].byteOffset=2**40`, (json) => {
        const acc = accessors(json)[i];
        if (acc) acc.byteOffset = 2 ** 40;
      });
      mutate(`accessors[${i}] 去掉 bufferView 且 count=2**50`, (json) => {
        const acc = accessors(json)[i];
        if (acc) {
          delete acc.bufferView;
          acc.count = 2 ** 50;
        }
      });
    }
    for (let v = 0; v < viewCount; v++) {
      for (const [field, fieldValue] of [
        ['byteLength', 2 ** 40],
        ['byteOffset', 2 ** 40],
        ['byteStride', 4],
        ['byteStride', 252],
      ] as const) {
        mutate(`bufferViews[${v}].${field}=${fieldValue}`, (json) => {
          const view = (json.bufferViews as JsonObject[])[v];
          if (view) view[field] = fieldValue;
        });
      }
    }
  });

  it.each(valid.map((f) => [f.id, f] as const))('%s：BIN 数据被 NaN / Infinity / 随机字节覆盖', (_id, fixture) => {
    const original = splitGlb(fixture.build());
    if (!original.bin) return;
    const fills: [string, (dv: DataView, offset: number, i: number) => void][] = [
      [
        'NaN',
        (dv, o) => {
          dv.setFloat32(o, Number.NaN, true);
        },
      ],
      [
        'Infinity',
        (dv, o) => {
          dv.setFloat32(o, Number.NEGATIVE_INFINITY, true);
        },
      ],
      [
        '随机',
        (dv, o, i) => {
          dv.setUint32(o, Math.imul(i + 1, 2654435761) >>> 0, true);
        },
      ],
    ];
    for (const [label, fill] of fills) {
      const bin = original.bin.slice();
      const dv = new DataView(bin.buffer);
      for (let o = 0, i = 0; o + 4 <= bin.byteLength; o += 4, i++) fill(dv, o, i);
      check(encodeGlb(original.json, bin), `${fixture.id} BIN=${label}`);
    }
  });
});
