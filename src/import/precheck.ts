// 读取之前的检查（纯函数）：文件类型和大小；GLB 再用 P1 的 inspect 模块做结构预检，不经过加载器。

import { inspectGlb, type InspectReport } from '../asset/inspect';
import { IMPORT_LIMITS, UNSUPPORTED_COMPRESSION_EXTENSIONS, type ImportLimits } from './limits';

export type ImportFormat = 'glb' | 'obj' | 'stl' | 'ply';

export type CheckResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly warnings: readonly string[] };

const MB = 1024 * 1024;

function formatMb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** 按扩展名判断格式（不区分大小写）。 */
export function detectFormat(fileName: string): ImportFormat | { unsupported: string } {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  switch (ext) {
    case '.glb':
      return 'glb';
    case '.obj':
      return 'obj';
    case '.stl':
      return 'stl';
    case '.ply':
      return 'ply';
    default:
      return { unsupported: ext };
  }
}

/** 读文件之前：类型和大小。 */
export function checkBeforeRead(fileName: string, size: number, limits: ImportLimits = IMPORT_LIMITS): CheckResult<ImportFormat> {
  const format = detectFormat(fileName);
  if (typeof format !== 'string') {
    const error =
      format.unsupported === '.gltf'
        ? '.gltf 会引用外部文件：请导出为自包含的 GLB'
        : `不支持的文件类型${format.unsupported ? `“${format.unsupported}”` : ''}：请选择 .glb、.obj、.stl 或 .ply 文件`;
    return { ok: false, error, warnings: [] };
  }
  if (size > limits.fileRejectBytes) {
    return {
      ok: false,
      error: `文件太大（${formatMb(size)} MB），超过 ${formatMb(limits.fileRejectBytes)} MB 的上限`,
      warnings: [],
    };
  }
  if (size === 0) return { ok: false, error: '文件是空的', warnings: [] };
  const warnings = size > limits.fileWarnBytes ? [`文件较大（${formatMb(size)} MB），读取和加载可能较慢`] : [];
  return { ok: true, value: format, warnings };
}

/** GLB 预检得到的声明值。 */
export interface GlbFacts {
  readonly report: InspectReport;
  /** 声明的三角面数；算不出时为 null（会在加载后再查）。 */
  readonly triangles: number | null;
  /** 所有 skin 的关节去重后的数量。 */
  readonly bones: number;
  readonly clips: number;
  /** 能从文件头读出尺寸的内嵌图片。 */
  readonly imageSizes: readonly { readonly width: number; readonly height: number }[];
}

/** GLB 的结构预检。只用 P1 的 inspect 模块，不经过加载器。 */
export function precheckGlb(bytes: Uint8Array, limits: ImportLimits = IMPORT_LIMITS): CheckResult<GlbFacts> {
  const inspected = inspectGlb(bytes);
  if (!inspected.ok) {
    return { ok: false, error: `文件损坏或不是合法的 GLB：${inspected.error.message}`, warnings: [] };
  }
  const report = inspected.report;
  const warnings: string[] = [];
  const reject = (error: string): CheckResult<GlbFacts> => ({ ok: false, error, warnings });

  if (report.externalResources.length > 0) return reject('文件引用了外部资源，请导出为自包含的 GLB');

  const unsupported = report.extensionsRequired.filter((ext) => UNSUPPORTED_COMPRESSION_EXTENSIONS.includes(ext));
  if (unsupported.length > 0) return reject(`本版不支持这种压缩格式：${unsupported.join('、')}`);

  const triangles = report.meshes.triangles.status === 'computed' ? report.meshes.triangles.value : null;
  if (triangles !== null) {
    if (triangles > limits.trianglesReject) {
      return reject(`三角面太多（${formatCount(triangles)}），超过 ${formatCount(limits.trianglesReject)} 的上限`);
    }
    if (triangles > limits.trianglesWarn) warnings.push(`三角面较多（${formatCount(triangles)}），可能影响帧率`);
  }

  const bones = report.skins.uniqueJointCount;
  if (bones > limits.bonesMax) return reject(`骨骼太多（${formatCount(bones)}），超过 ${formatCount(limits.bonesMax)} 的上限`);

  const clips = report.animations.count;
  if (clips > limits.clipsMax) return reject(`动画片段太多（${formatCount(clips)}），超过 ${formatCount(limits.clipsMax)} 的上限`);

  const imageSizes: { width: number; height: number }[] = [];
  for (const image of report.textures.images) {
    if (image.size.status !== 'computed') continue;
    const { width, height } = image.size.value;
    imageSizes.push({ width, height });
    if (Math.max(width, height) > limits.textureEdgeMax) {
      return reject(`贴图太大（${String(width)}×${String(height)}），边长超过 ${formatCount(limits.textureEdgeMax)} 的上限`);
    }
  }

  return { ok: true, value: { report, triangles, bones, clips, imageSizes }, warnings };
}
