// 导入流程：类型和大小 → GLB 预检（不经过加载器）→ 加载 → 加载后检查（超限就释放）→ 包围盒 → SHA-256 → 资产。
// 任何一步失败都返回友好的错误；已经加载的几何、材质、贴图在失败时释放。

import { ImportedAsset, sha256Hex } from './asset';
import { computeBindPose } from './bindPose';
import { IMPORT_LIMITS, type ImportLimits } from './limits';
import { loadModel, type LoadedModel } from './load';
import { bindPoseBounds } from './normalize';
import { checkBeforeRead, precheckGlb } from './precheck';
import { disposeObject, loadedStats, postLoadCheck } from './resources';

export interface ImportSource {
  readonly name: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
}

export type ImportStage = 'type' | 'read' | 'precheck' | 'parse' | 'postcheck';

export type ImportOutcome =
  | { readonly ok: true; readonly asset: ImportedAsset; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly stage: ImportStage; readonly error: string; readonly warnings: readonly string[] };

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '未知错误';
}

export async function importModel(source: ImportSource, limits: ImportLimits = IMPORT_LIMITS): Promise<ImportOutcome> {
  const warnings: string[] = [];
  const fail = (stage: ImportStage, error: string): ImportOutcome => ({ ok: false, stage, error, warnings });

  const before = checkBeforeRead(source.name, source.size, limits);
  warnings.push(...before.warnings);
  if (!before.ok) return fail('type', before.error);
  const format = before.value;

  let bytes: Uint8Array;
  try {
    bytes = await source.read();
  } catch (error) {
    return fail('read', `读不了文件：${message(error)}`);
  }

  if (format === 'glb') {
    const pre = precheckGlb(bytes, limits);
    warnings.push(...pre.warnings);
    if (!pre.ok) return fail('precheck', pre.error);
  }

  let loaded: LoadedModel;
  try {
    loaded = await loadModel(format, bytes);
  } catch (error) {
    return fail('parse', `文件损坏或格式不对，无法解析：${message(error)}`);
  }

  // 从这里起 loaded.scene 已经可用：任何一步失败（包括意外的异常）都先释放它
  const scene = loaded.scene;
  const release = (error: string): ImportOutcome => {
    disposeObject(scene);
    return fail('postcheck', error);
  };
  try {
    const stats = loadedStats(scene);
    const post = postLoadCheck(stats, limits);
    for (const w of post.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (!post.ok) return release(post.error);
    // 绑定姿态只算一次：包围盒、“绑定姿态”片段和实例都用同一份
    const bindPose = computeBindPose(scene);
    const bounds = bindPoseBounds(scene, bindPose);
    if (!bounds) return release('文件里没有可显示的几何');
    const asset = new ImportedAsset({
      id: await sha256Hex(bytes),
      fileName: source.name,
      format,
      sizeBytes: source.size,
      scene,
      clips: loaded.clips,
      bindPose,
      bounds,
      stats,
      notices: loaded.notices,
      warnings,
    });
    return { ok: true, asset, warnings };
  } catch (error) {
    return release(`文件损坏或格式不对，加载后的检查失败：${message(error)}`);
  }
}

/** 从保存下来的文件内容（Blob）生成导入源：名册恢复时用，和导入新文件走同一条流程。 */
export function blobSource(name: string, blob: Blob): ImportSource {
  return {
    name,
    size: blob.size,
    read: async () => new Uint8Array(await blob.arrayBuffer()),
  };
}

/** 从浏览器的 File 生成导入源（大小检查在读取之前完成）。 */
export function fileSource(file: File): ImportSource {
  return {
    name: file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

export { IMPORT_LIMITS };
