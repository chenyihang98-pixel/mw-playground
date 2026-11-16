// 读取之前的检查（纯函数）：文件类型和大小；GLB 再用 P1 的 inspect 模块做结构预检，不经过加载器。

import { inspectGlb, type InspectReport } from '../asset/inspect';
import type { InspectError, InspectErrorCode } from '../asset/inspect/types';
import { IMPORT_LIMITS, UNSUPPORTED_COMPRESSION_EXTENSIONS, type ImportLimits } from './limits';
import { currentLang, t, type MessageKey } from '../i18n';

/** GLB 结构预检的错误（P1 的 inspect 模块，命令行也用它，说明是中文）按错误码翻译（F6）。 */
const INSPECT_ERROR_KEYS: Readonly<Record<InspectErrorCode, MessageKey>> = {
  empty: 'inspectError.empty',
  'not-glb': 'inspectError.notGlb',
  'unsupported-version': 'inspectError.unsupportedVersion',
  truncated: 'inspectError.truncated',
  'length-mismatch': 'inspectError.lengthMismatch',
  'bad-chunks': 'inspectError.badChunks',
  'invalid-json': 'inspectError.invalidJson',
  'invalid-gltf': 'inspectError.invalidGltf',
};

/** 中文界面照旧用 inspect 模块的原文（带具体数字）；日语和英语按错误码给出对应的说明。 */
export function inspectErrorText(error: InspectError): string {
  return currentLang() === 'zh' ? error.message : t(INSPECT_ERROR_KEYS[error.code]);
}

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
        ? t('import.gltfExternal')
        : t('import.unsupportedType', { type: format.unsupported ? t('import.quotedType', { type: format.unsupported }) : '' });
    return { ok: false, error, warnings: [] };
  }
  if (size > limits.fileRejectBytes) {
    return {
      ok: false,
      error: t('import.tooLarge', { size: formatMb(size), limit: formatMb(limits.fileRejectBytes) }),
      warnings: [],
    };
  }
  if (size === 0) return { ok: false, error: t('import.emptyFile'), warnings: [] };
  const warnings = size > limits.fileWarnBytes ? [t('import.largeFile', { size: formatMb(size) })] : [];
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
    return { ok: false, error: t('import.corruptGlb', { detail: inspectErrorText(inspected.error) }), warnings: [] };
  }
  const report = inspected.report;
  const warnings: string[] = [];
  const reject = (error: string): CheckResult<GlbFacts> => ({ ok: false, error, warnings });

  if (report.externalResources.length > 0) return reject(t('import.externalResources'));

  const unsupported = report.extensionsRequired.filter((ext) => UNSUPPORTED_COMPRESSION_EXTENSIONS.includes(ext));
  if (unsupported.length > 0) return reject(t('import.unsupportedCompression', { names: unsupported.join(t('common.listSep')) }));

  const triangles = report.meshes.triangles.status === 'computed' ? report.meshes.triangles.value : null;
  if (triangles !== null) {
    if (triangles > limits.trianglesReject) {
      return reject(t('import.tooManyTriangles', { count: formatCount(triangles), limit: formatCount(limits.trianglesReject) }));
    }
    if (triangles > limits.trianglesWarn) warnings.push(t('import.manyTriangles', { count: formatCount(triangles) }));
  }

  const bones = report.skins.uniqueJointCount;
  if (bones > limits.bonesMax) return reject(t('import.tooManyBones', { count: formatCount(bones), limit: formatCount(limits.bonesMax) }));

  const clips = report.animations.count;
  if (clips > limits.clipsMax) return reject(t('import.tooManyClips', { count: formatCount(clips), limit: formatCount(limits.clipsMax) }));

  const imageSizes: { width: number; height: number }[] = [];
  for (const image of report.textures.images) {
    if (image.size.status !== 'computed') continue;
    const { width, height } = image.size.value;
    imageSizes.push({ width, height });
    if (Math.max(width, height) > limits.textureEdgeMax) {
      return reject(t('import.textureTooLarge', { width: String(width), height: String(height), limit: formatCount(limits.textureEdgeMax) }));
    }
  }

  return { ok: true, value: { report, triangles, bones, clips, imageSizes }, warnings };
}
