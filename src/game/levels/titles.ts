// 关卡在界面上的名字和开场白（F6）。
// - 内置关卡（P2 的手工地图和 P5 冻结的生成关卡）按关卡 id 查翻译表；冻结的布局数据、种子和 layoutHash 都不改，
//   中文词条和数据里的原文完全一样（单元测试核对）。
// - 其他关卡（随机、已保存、工坊生成）的标题和开场白是保存或生成的文字，原样显示（raw）。

import { t, type MessageKey } from '../../i18n';
import type { LevelPackage } from './package';

/** 内置关卡 id → 名字的词条。 */
export const BUILTIN_TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  meadow: 'levelName.meadow',
  'test-a': 'levelName.testA',
  'test-b': 'levelName.testB',
  'gen-1': 'levelName.gen1',
  'gen-2': 'levelName.gen2',
  'gen-3': 'levelName.gen3',
};

/** 冻结的生成关卡 id → 开场白的词条（P2 的手工地图没有开场白）。 */
export const BUILTIN_OPENING_KEYS: Readonly<Record<string, MessageKey>> = {
  'gen-1': 'levelOpening.gen1',
  'gen-2': 'levelOpening.gen2',
  'gen-3': 'levelOpening.gen3',
};

export interface DisplayText {
  readonly text: string;
  /** 原样显示（用户数据或生成的文字，不翻译）。 */
  readonly raw: boolean;
}

/** 内置关卡的 id（关卡包的 key 是 builtin:<id>）；不是内置关卡时为 null。 */
function builtinIdOf(pkg: LevelPackage): string | null {
  return pkg.source === 'builtin' && pkg.key.startsWith('builtin:') ? pkg.key.slice('builtin:'.length) : null;
}

/** 内置关卡在当前语言里的名字；不在翻译表里时为 null。 */
export function builtinTitle(id: string): string | null {
  const key = BUILTIN_TITLE_KEYS[id];
  return key ? t(key) : null;
}

/** 关卡在界面上的名字。 */
export function displayTitle(pkg: LevelPackage): DisplayText {
  const id = builtinIdOf(pkg);
  const title = id === null ? null : builtinTitle(id);
  return title === null ? { text: pkg.title, raw: true } : { text: title, raw: false };
}

/** 关卡的开场白（没有时为空字符串）。 */
export function displayOpening(pkg: LevelPackage): DisplayText {
  const id = builtinIdOf(pkg);
  const key = id === null ? undefined : BUILTIN_OPENING_KEYS[id];
  if (key && pkg.brief?.opening) return { text: t(key), raw: false };
  return { text: pkg.brief?.opening ?? '', raw: true };
}
