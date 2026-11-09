// 把检查报告排版成给人看的文本。声明值和实际计算值分开写；算不出的写“未计算”和原因。

import { decoderExtensionsIn } from './inspect';
import type {
  AnimationReport,
  Box3,
  ExtrasReport,
  ImageReport,
  InspectReport,
  LoopReport,
  Metric,
} from './types';

export const LOOP_NOTE =
  'extras.loop 一栏是 GLB 原始 JSON 里 animation.extras.loop 的值（不是加载后的值）；加载后对应 clip.userData.loop（three r187 GLTFLoader）。';
export const BOUNDS_NOTE = '按 POSITION 访问器和节点静态变换计算，不含蒙皮姿态（骨骼动画造成的形变）';

/** 文本里的数字：保留 6 位有效数字，极小的浮点误差显示为 0。JSON 输出保留原值。 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-9) return '0';
  return String(Number.parseFloat(n.toPrecision(6)));
}

function metric<T>(m: Metric<T>, show: (value: T) => string): string {
  return m.status === 'computed' ? show(m.value) : `未计算（${m.reason}）`;
}

function vec(v: readonly number[]): string {
  return `(${v.map(formatNumber).join(', ')})`;
}

function box(b: Box3): string {
  return `min ${vec(b.min)}，max ${vec(b.max)}，尺寸 ${b.size.map(formatNumber).join(' × ')} m`;
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.join('，') : '（无）';
}

function quote(name: string): string {
  return JSON.stringify(name);
}

export function describeLoop(loop: LoopReport): string {
  switch (loop.kind) {
    case 'true':
      return 'true（boolean）';
    case 'false':
      return 'false（boolean）';
    case 'missing':
      return loop.reason === 'no-extras'
        ? '缺失（没有 extras）'
        : loop.reason === 'extras-not-object'
          ? '缺失（extras 不是对象）'
          : '缺失（extras 里没有 loop）';
    case 'other':
      return `其他类型：${loop.valueType}，原值 ${JSON.stringify(loop.value)}`;
  }
}

export function describeExtras(extras: ExtrasReport): string {
  switch (extras.kind) {
    case 'missing':
      return '缺失';
    case 'object':
      return '对象';
    case 'not-object':
      return `不是对象（${extras.valueType}：${JSON.stringify(extras.value)}）`;
  }
}

export function describeAnimationName(a: AnimationReport): string {
  if (!a.unnamed) return quote(a.loaderName);
  const prefix = a.rawName === '' ? '无名（name 是空字符串）' : '无名';
  return `${prefix}；GLTFLoader 加载后为 ${a.loaderName}`;
}

function imageLine(image: ImageReport): string {
  const source =
    image.source === 'bufferView'
      ? 'bufferView'
      : image.source === 'data-uri'
        ? 'data URI'
        : image.source === 'external-uri'
          ? '外部 uri'
          : '无数据';
  const parts = [
    source,
    `声明 mimeType：${image.declaredMimeType ?? '无'}`,
    `识别格式：${image.detectedFormat === null ? '未识别' : image.detectedFormat.toUpperCase()}`,
    `尺寸：${metric(image.size, (s) => `${s.width}×${s.height}`)}`,
  ];
  return `  images[${image.index}]${image.name !== null ? ` ${quote(image.name)}` : ''}：${parts.join('；')}`;
}

function animationLines(a: AnimationReport): string[] {
  const lines: string[] = [];
  const dup = a.duplicateOf.length > 0 ? `  ⚠ 重名：与 ${a.duplicateOf.map((i) => `#${i}`).join('、')} 加载后同名` : '';
  lines.push(`  #${a.index} ${describeAnimationName(a)}${dup}`);
  const paths = Object.entries(a.targetPaths)
    .map(([path, n]) => `${path} ${n}`)
    .join('，');
  lines.push(`     通道数：${a.channelCount}${paths ? `（${paths}）` : ''}；采样器数：${a.samplerCount}`);
  lines.push(`     时长（声明，输入访问器 max）：${metric(a.duration.declared, (s) => `${formatNumber(s)} s`)}`);
  lines.push(`     时长（实际，从 BIN 读出的最大时间）：${metric(a.duration.actual, (s) => `${formatNumber(s)} s`)}`);
  lines.push(`     extras：${describeExtras(a.extras)}`);
  lines.push(`     extras.loop（原始）：${describeLoop(a.loop)}`);
  for (const m of a.horizontalMotion) {
    const node = `nodes[${m.node}]${m.nodeName !== null ? ` ${quote(m.nodeName)}` : ''}`;
    lines.push(
      `     水平位移（translation，XZ 平面，首末关键帧，从 BIN 读出）：${node} ${metric(
        m.displacement,
        (d) => `从 ${vec(d.from)} 到 ${vec(d.to)}，${formatNumber(d.distance)} m`,
      )}`,
    );
  }
  return lines;
}

export interface FormatOptions {
  /** 报告标题里显示的文件名（命令行传入的路径原样显示）。 */
  readonly label?: string;
}

export function formatInspectReport(report: InspectReport, options: FormatOptions = {}): string {
  const out: string[] = [];
  const c = report.container;
  out.push(`GLB 结构检查${options.label !== undefined ? `：${options.label}` : ''}`);
  out.push('');
  out.push('[容器]');
  out.push(`  文件大小：${c.fileSize} 字节`);
  out.push(`  容器版本：${c.version}`);
  out.push(
    `  长度：头部声明 ${c.declaredLength} 字节；实际 ${c.actualLength} 字节（${c.lengthMatches ? '一致' : '不一致'}）`,
  );
  out.push(`  块：${c.chunks.map((ch) => `#${ch.index} ${ch.type} ${ch.byteLength} 字节`).join('；')}`);
  out.push('');

  out.push('[资产]');
  out.push(`  asset.generator：${report.asset.generator ?? '（无）'}`);
  out.push(`  asset.version：${report.asset.version}`);
  if (report.asset.minVersion !== null) out.push(`  asset.minVersion：${report.asset.minVersion}`);
  out.push(`  extensionsUsed：${list(report.extensionsUsed)}`);
  const decoders = decoderExtensionsIn(report.extensionsRequired);
  out.push(
    `  extensionsRequired：${list(report.extensionsRequired)}${decoders.length > 0 ? `（需要解码器：${decoders.join('，')}）` : ''}`,
  );
  out.push('');

  out.push('[外部资源引用]（只列出，不读取）');
  if (report.externalResources.length === 0) out.push('  （无）');
  for (const r of report.externalResources) out.push(`  ${r.kind === 'buffer' ? 'buffers' : 'images'}[${r.index}].uri：${r.uri}`);
  out.push('');

  out.push('[网格]');
  out.push(`  网格数：${report.meshes.meshCount}`);
  out.push(`  图元数：${report.meshes.primitiveCount}`);
  out.push(`  三角面数（按 indices 或 POSITION 的 count 和图元 mode 计算）：${metric(report.meshes.triangles, String)}`);
  out.push('');

  out.push('[贴图]');
  out.push(`  贴图数：${report.textures.textureCount}`);
  out.push(`  图片数：${report.textures.imageCount}`);
  for (const image of report.textures.images) out.push(imageLine(image));
  out.push('');

  out.push('[蒙皮]');
  out.push(`  skins 数：${report.skins.count}`);
  for (const s of report.skins.skins) {
    out.push(`  skins[${s.index}]${s.name !== null ? ` ${quote(s.name)}` : ''}：关节数 ${s.jointCount}`);
  }
  out.push('');

  out.push(`[动画]（${report.animations.count} 个）`);
  if (report.animations.count > 0) out.push(`  说明：${LOOP_NOTE}`);
  for (const a of report.animations.animations) out.push(...animationLines(a));
  if (report.animations.duplicateNames.length > 0) {
    out.push('  重名片段（按加载后的名字）：');
    for (const d of report.animations.duplicateNames) {
      out.push(`    ${quote(d.name)}：${d.indices.map((i) => `#${i}`).join('、')}`);
    }
  }
  out.push('');

  out.push(`[包围盒]（${BOUNDS_NOTE}）`);
  out.push(`  范围：${report.bounds.basis}`);
  out.push(`  声明值（POSITION 访问器 min/max + 节点静态变换）：${metric(report.bounds.declared, box)}`);
  out.push(`  实际值（从 BIN 读出的顶点 + 节点静态变换）：${metric(report.bounds.actual, box)}`);
  out.push('');

  out.push('[问题]');
  if (report.issues.length === 0) out.push('  （无）');
  for (const issue of report.issues) out.push(`  - ${issue}`);
  return out.join('\n') + '\n';
}
