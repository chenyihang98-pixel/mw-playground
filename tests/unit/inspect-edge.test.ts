// 结构检查的边界情况：容器损坏、其他格式、各种不合规的 JSON、缺 min/max、稀疏访问器、data URI 等。

import { describe, expect, it } from 'vitest';
import { GltfBuilder, buildFixture, bytesToBase64, checkerPng, encodeGlb, jpegHeaderOnly } from '../../src/asset/fixtures';
import { CHUNK_TYPE_BIN, CHUNK_TYPE_JSON } from '../../src/asset/gltf/constants';
import { formatInspectReport, inspectGlb, readImageSize, type InspectReport, type Metric } from '../../src/asset/inspect';

const text = (s: string) => new TextEncoder().encode(s);

function ok(bytes: Uint8Array | ArrayBuffer): InspectReport {
  const result = inspectGlb(bytes);
  if (!result.ok) throw new Error(`应该能检查：${result.error.message}`);
  return result.report;
}

function err(bytes: Uint8Array | ArrayBuffer) {
  const result = inspectGlb(bytes);
  if (result.ok) throw new Error('应该检查失败');
  return result.error;
}

function value<T>(m: Metric<T>): T {
  if (m.status !== 'computed') throw new Error(`应为已计算：${m.reason}`);
  return m.value;
}

function firstAnimation(r: InspectReport) {
  const a = r.animations.animations[0];
  if (!a) throw new Error('没有动画');
  return a;
}

function reasonOf(m: Metric<unknown>): string {
  if (m.status !== 'not-computed') throw new Error(`应为未计算，实际值：${JSON.stringify(m.value)}`);
  return m.reason;
}

/** 手工拼 GLB：可以给出任意的块。 */
function rawGlb(chunks: { type: number; data: Uint8Array }[], options: { version?: number; declaredLength?: number } = {}) {
  const body = chunks.reduce((n, c) => n + 8 + c.data.byteLength, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, options.version ?? 2, true);
  view.setUint32(8, options.declaredLength ?? out.byteLength, true);
  let offset = 12;
  for (const c of chunks) {
    view.setUint32(offset, c.data.byteLength, true);
    view.setUint32(offset + 4, c.type, true);
    out.set(c.data, offset + 8);
    offset += 8 + c.data.byteLength;
  }
  return out;
}

function jsonChunk(json: string) {
  const padded = json + ' '.repeat((4 - (text(json).byteLength % 4)) % 4);
  return { type: CHUNK_TYPE_JSON, data: text(padded) };
}

/** 一个最小的三角形网格，可以改访问器定义。 */
function triangleGlb(patch: (json: Record<string, unknown>) => void = () => undefined): Uint8Array {
  const b = new GltfBuilder();
  const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), type: 'VEC3' });
  const mesh = b.addMesh('Tri', [{ attributes: { POSITION: position } }]);
  b.addScene([b.addNode({ name: 'Tri', mesh })]);
  const json = b.json();
  patch(json);
  return encodeGlb(json, b.binary());
}

describe('不是 GLB 的文件', () => {
  it.each([
    ['OBJ 文本', '# exported\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'OBJ'],
    ['.gltf JSON', '{"asset":{"version":"2.0"}}', 'JSON'],
    ['ASCII STL', 'solid cube\n facet normal 0 0 1\nendsolid cube\n', 'ASCII STL'],
    ['PLY', 'ply\nformat ascii 1.0\nend_header\n', 'PLY'],
  ])('%s：not-glb，并指出看起来是什么', (_name, content, hint) => {
    const error = err(text(content));
    expect(error.code).toBe('not-glb');
    expect(error.message).toContain(hint);
  });

  it('二进制 STL：not-glb', () => {
    const stl = new Uint8Array(84 + 50);
    new DataView(stl.buffer).setUint32(80, 1, true);
    const error = err(stl);
    expect(error.code).toBe('not-glb');
    expect(error.message).toContain('二进制 STL');
  });

  it('空文件', () => {
    expect(err(new Uint8Array(0)).code).toBe('empty');
  });

  it('只有 magic，头不完整：truncated', () => {
    expect(err(text('glTF')).code).toBe('truncated');
  });
});

describe('损坏或不合规的容器', () => {
  it('容器版本 1：unsupported-version', () => {
    const error = err(rawGlb([jsonChunk('{}')], { version: 1 }));
    expect(error.code).toBe('unsupported-version');
    expect(error.message).toContain('版本是 1');
  });

  it('声明长度大于实际长度：truncated', () => {
    const bytes = rawGlb([jsonChunk('{"asset":{"version":"2.0"}}')]);
    new DataView(bytes.buffer).setUint32(8, bytes.byteLength + 100, true);
    expect(err(bytes).code).toBe('truncated');
  });

  it('块长度超出文件：bad-chunks', () => {
    const bytes = rawGlb([jsonChunk('{"asset":{"version":"2.0"}}')]);
    new DataView(bytes.buffer).setUint32(12, 9999, true);
    const error = err(bytes);
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('9999');
  });

  it('没有任何块：bad-chunks', () => {
    expect(err(rawGlb([])).code).toBe('bad-chunks');
  });

  it('第一个块不是 JSON：bad-chunks', () => {
    expect(err(rawGlb([{ type: CHUNK_TYPE_BIN, data: new Uint8Array(4) }])).code).toBe('bad-chunks');
  });

  it('JSON 无法解析：invalid-json', () => {
    expect(err(rawGlb([jsonChunk('{"asset": ')])).code).toBe('invalid-json');
  });

  it('JSON 顶层不是对象：invalid-gltf', () => {
    expect(err(rawGlb([jsonChunk('[1,2]')])).code).toBe('invalid-gltf');
  });

  it('字段类型不对：invalid-gltf，并写出位置', () => {
    const error = err(rawGlb([jsonChunk('{"asset":{"version":"2.0"},"animations":[{"channels":{},"samplers":[]}]}')]));
    expect(error.code).toBe('invalid-gltf');
    expect(error.message).toContain('animations.0.channels');
  });

  it('文件末尾有多余字节（声明长度小于实际长度）：length-mismatch，写出两个长度', () => {
    const glb = buildFixture('static-mesh');
    const padded = new Uint8Array(glb.byteLength + 8);
    padded.set(glb);
    const error = err(padded);
    expect(error.code).toBe('length-mismatch');
    expect(error.message).toContain(`声明长度 ${glb.byteLength} 字节`);
    expect(error.message).toContain(`实际长度 ${glb.byteLength + 8} 字节`);
  });

  it('两个 JSON 块：bad-chunks', () => {
    const json = jsonChunk(MINIMAL_JSON);
    const error = err(rawGlb([json, json]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('又是 JSON 块');
  });

  it('两个 BIN 块：bad-chunks', () => {
    const bin = { type: CHUNK_TYPE_BIN, data: new Uint8Array(4) };
    const error = err(rawGlb([jsonChunk(MINIMAL_JSON), bin, bin]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('第 2 个块是 BIN 块');
  });

  it('BIN 块不是第二个块：bad-chunks', () => {
    const unknown = { type: 0x12345678, data: new Uint8Array(4) };
    const error = err(rawGlb([jsonChunk(MINIMAL_JSON), unknown, { type: CHUNK_TYPE_BIN, data: new Uint8Array(4) }]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('必须是第二个块');
  });

  it('块长度不是 4 的倍数：bad-chunks', () => {
    const error = err(rawGlb([jsonChunk(MINIMAL_JSON), { type: CHUNK_TYPE_BIN, data: new Uint8Array(5) }]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('不是 4 的倍数');
  });

  it('BIN 块后面的未知类型块：规范要求忽略，照常检查并记在问题里', () => {
    const r = ok(rawGlb([jsonChunk(MINIMAL_JSON), { type: CHUNK_TYPE_BIN, data: new Uint8Array(4) }, { type: 0x12345678, data: new Uint8Array(4) }]));
    expect(r.container.chunks.map((c) => c.type)).toEqual(['JSON', 'BIN', 'unknown']);
    expect(r.issues.join('\n')).toContain('类型未知');
  });

  it('JSON 块用 0 字节补齐：invalid-json', () => {
    const json = text(MINIMAL_JSON);
    const data = new Uint8Array(Math.ceil((json.byteLength + 1) / 4) * 4); // 至少补 1 个 0 字节，并保持 4 字节对齐
    data.set(json);
    const error = err(rawGlb([{ type: CHUNK_TYPE_JSON, data }]));
    expect(error.code).toBe('invalid-json');
    expect(error.message).toContain('0 字节');
  });

  it('JSON 块以 BOM 开头：invalid-json', () => {
    const error = err(rawGlb([jsonChunk(`﻿${MINIMAL_JSON}`)]));
    expect(error.code).toBe('invalid-json');
    expect(error.message).toContain('BOM');
  });

  it.each([
    ['{}', '缺少必需的 asset 对象'],
    ['{"asset":{}}', '缺少必需的 asset.version'],
    ['{"asset":{"version":"1.0"}}', '只支持 glTF 2.x'],
  ])('asset 不合法（%s）：invalid-gltf', (json, message) => {
    const error = err(rawGlb([jsonChunk(json)]));
    expect(error.code).toBe('invalid-gltf');
    expect(error.message).toContain(message);
  });

  it('BIN 块比 buffers[0].byteLength 短：bad-chunks', () => {
    const json = '{"asset":{"version":"2.0"},"buffers":[{"byteLength":64}]}';
    const error = err(rawGlb([jsonChunk(json), { type: CHUNK_TYPE_BIN, data: new Uint8Array(16) }]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('小于 buffers[0].byteLength（64）');
  });

  it('BIN 块比 buffers[0].byteLength 长 3 字节以上：bad-chunks', () => {
    const json = '{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}]}';
    const error = err(rawGlb([jsonChunk(json), { type: CHUNK_TYPE_BIN, data: new Uint8Array(16) }]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('多出 12 字节');
  });

  it('buffers[0] 指向 BIN 块但文件没有 BIN 块：bad-chunks', () => {
    const error = err(rawGlb([jsonChunk('{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}]}')]));
    expect(error.code).toBe('bad-chunks');
    expect(error.message).toContain('没有 BIN 块');
  });
});

const MINIMAL_JSON = '{"asset":{"version":"2.0"}}';

describe('输入形式', () => {
  it('ArrayBuffer 和带偏移的 Uint8Array 都能用', () => {
    const glb = buildFixture('loop-false');
    expect(ok(glb.buffer).animations.count).toBe(1);
    const shifted = new Uint8Array(glb.byteLength + 3);
    shifted.set(glb, 3);
    expect(ok(shifted.subarray(3)).animations.count).toBe(1);
  });
});

describe('extras 和 loop 的各种原始值', () => {
  function withExtras(extras: unknown) {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    b.addAnimation({ name: 'a', extras, channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 1, 0] }] });
    return firstAnimation(ok(b.toGlb()));
  }

  it.each([
    [null, 'null'],
    [[1, 2], 'array'],
    ['looping', 'string'],
    [true, 'boolean'],
  ])('extras = %j：不是对象（%s）', (extras, type) => {
    const a = withExtras(extras);
    expect(a.extras).toEqual({ kind: 'not-object', valueType: type, value: extras });
    expect(a.loop).toEqual({ kind: 'missing', reason: 'extras-not-object' });
  });

  it('没有 extras：loop 缺失（没有 extras）', () => {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    b.addAnimation({ name: 'a', channels: [{ node, path: 'scale', times: [0, 1], values: [1, 1, 1, 2, 2, 2] }] });
    const a = firstAnimation(ok(b.toGlb()));
    expect(a.extras).toEqual({ kind: 'missing' });
    expect(a.loop).toEqual({ kind: 'missing', reason: 'no-extras' });
  });

  it.each([
    [null, 'null'],
    [1, 'number'],
    [{ count: 2 }, 'object'],
  ])('loop = %j：其他类型（%s），列出原值', (loop, type) => {
    expect(withExtras({ loop }).loop).toEqual({ kind: 'other', valueType: type, value: loop });
  });
});

describe('算不出的指标写“未计算”和原因', () => {
  it('POSITION 缺 min/max：声明包围盒未计算，实际包围盒照常计算', () => {
    const r = ok(
      triangleGlb((json) => {
        const accessors = json.accessors as Record<string, unknown>[];
        delete accessors[0]?.min;
        delete accessors[0]?.max;
      }),
    );
    expect(reasonOf(r.bounds.declared)).toContain('缺 min/max');
    expect(value(r.bounds.actual).max).toEqual([1, 1, 0]);
    expect(formatInspectReport(r)).toContain('声明值（POSITION 访问器 min/max + 节点静态变换）：未计算（');
  });

  it('动画输入访问器缺 max：声明时长未计算，实际时长照常计算', () => {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    b.addAnimation({ name: 'a', channels: [{ node, path: 'translation', times: [0, 1.5], values: [0, 0, 0, 1, 0, 0] }] });
    const json = b.json();
    const accessors = json.accessors as Record<string, unknown>[];
    delete accessors[0]?.max;
    const a = firstAnimation(ok(encodeGlb(json, b.binary())));
    expect(reasonOf(a.duration.declared)).toContain('缺 max');
    expect(value(a.duration.actual)).toBe(1.5);
  });

  it('声明与实际不一致时分开报告（声明 max 写错）', () => {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N' });
    b.addScene([node]);
    b.addAnimation({ name: 'a', channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] });
    const json = b.json();
    (json.accessors as Record<string, unknown>[])[0] = { ...(json.accessors as Record<string, unknown>[])[0], max: [5] };
    const a = firstAnimation(ok(encodeGlb(json, b.binary())));
    expect(value(a.duration.declared)).toBe(5);
    expect(value(a.duration.actual)).toBe(1);
  });

  it('稀疏访问器：实际包围盒未计算（未实现读取）', () => {
    const r = ok(
      triangleGlb((json) => {
        const accessors = json.accessors as Record<string, unknown>[];
        accessors[0] = { ...accessors[0], sparse: { count: 1, indices: {}, values: {} } };
      }),
    );
    expect(reasonOf(r.bounds.actual)).toContain('sparse');
  });

  it('访问器越界：实际值未计算', () => {
    const r = ok(
      triangleGlb((json) => {
        const accessors = json.accessors as Record<string, unknown>[];
        accessors[0] = { ...accessors[0], count: 100 };
      }),
    );
    expect(reasonOf(r.bounds.actual)).toContain('超出');
  });

  it('引用的访问器不存在：三角面数未计算', () => {
    const r = ok(
      triangleGlb((json) => {
        const meshes = json.meshes as { primitives: { attributes: Record<string, number> }[] }[];
        const prim = meshes[0]?.primitives[0];
        if (prim) prim.attributes.POSITION = 9;
      }),
    );
    expect(reasonOf(r.meshes.triangles)).toContain('accessors[9] 不存在');
  });

  it('场景里没有网格：包围盒未计算', () => {
    const b = new GltfBuilder();
    b.addScene([b.addNode({ name: 'Empty' })]);
    const r = ok(b.toGlb());
    expect(reasonOf(r.bounds.declared)).toContain('没有引用网格的节点');
    expect(reasonOf(r.bounds.actual)).toContain('没有引用网格的节点');
    expect(value(r.meshes.triangles)).toBe(0); // 没有图元，三角面确实是 0
  });

  it('量化的 POSITION（SHORT + normalized）：声明值和实际值都按规范换算', () => {
    const b = new GltfBuilder();
    const position = b.addAccessor({
      array: new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, -32767]),
      type: 'VEC3',
      normalized: true,
    });
    b.addScene([b.addNode({ mesh: b.addMesh('Quantized', [{ attributes: { POSITION: position } }]) })]);
    const r = ok(b.toGlb());
    for (const box of [value(r.bounds.declared), value(r.bounds.actual)]) {
      expect(box.min).toEqual([0, 0, -1]);
      expect(box.max).toEqual([1, 1, 0]);
    }
  });

  it('点图元：三角面数是确实的 0（已计算），不是未计算', () => {
    const r = ok(
      triangleGlb((json) => {
        const meshes = json.meshes as { primitives: Record<string, unknown>[] }[];
        const prim = meshes[0]?.primitives[0];
        if (prim) prim.mode = 0;
      }),
    );
    expect(r.meshes.triangles).toEqual({ status: 'computed', value: 0 });
  });
});

describe('buffer 和图片的来源', () => {
  it('buffer 是 data URI：可以读，不算外部资源', () => {
    const b = new GltfBuilder();
    const position = b.addAccessor({ array: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), type: 'VEC3' });
    b.addScene([b.addNode({ mesh: b.addMesh('Tri', [{ attributes: { POSITION: position } }]) })]);
    const json = b.json();
    const buffers = json.buffers as Record<string, unknown>[];
    buffers[0] = { ...buffers[0], uri: `data:application/octet-stream;base64,${bytesToBase64(b.binary())}` };
    const r = ok(encodeGlb(json));
    expect(r.externalResources).toEqual([]);
    expect(value(r.bounds.actual).max).toEqual([2, 3, 0]);
  });

  it('没有场景时，用所有根节点计算包围盒', () => {
    const r = ok(
      triangleGlb((json) => {
        delete json.scene;
        delete json.scenes;
      }),
    );
    expect(r.bounds.basis).toContain('所有根节点');
    expect(value(r.bounds.actual).max).toEqual([1, 1, 0]);
  });

  it('readImageSize：PNG、JPEG、其他格式', () => {
    expect(readImageSize(checkerPng(7, 3))).toEqual({ ok: true, format: 'png', size: { width: 7, height: 3 } });
    expect(readImageSize(jpegHeaderOnly(640, 480))).toEqual({ ok: true, format: 'jpeg', size: { width: 640, height: 480 } });
    expect(readImageSize(text('RIFF....WEBP'))).toMatchObject({ ok: false, format: null });
  });
});
