// 工坊返回的关卡 → 游戏里的关卡包（P8）。浏览器收到后再校验一遍：布局按 schema 解析，哈希必须和服务给的一致。纯模块。

import { parseLevel } from '../game/level/schema';
import { layoutHash, type LevelPackage } from '../game/levels/package';
import type { WireLevel } from './protocol';
import { t } from '../i18n';

export type WireResult = { readonly ok: true; readonly pkg: LevelPackage } | { readonly ok: false; readonly error: string };

export function packageOfWire(wire: WireLevel): WireResult {
  let layout;
  try {
    layout = parseLevel(wire.layout);
  } catch (error) {
    return { ok: false, error: t('workshop.badLayout', { message: error instanceof Error ? error.message : String(error) }) };
  }
  const hash = layoutHash(layout);
  if (hash !== wire.layoutHash) return { ok: false, error: t('workshop.hashMismatch') };
  if (layout.timeLimit !== wire.rules.timeLimit || layout.target !== wire.rules.target) return { ok: false, error: t('workshop.rulesMismatch') };
  return {
    ok: true,
    pkg: {
      key: `preview:${hash}`,
      source: 'model',
      title: wire.title,
      layout,
      visual: wire.visual,
      rules: wire.rules,
      brief: wire.brief,
      seed: wire.seed,
      schemaVersion: wire.schemaVersion,
      generatorVersion: wire.generatorVersion,
      adjustment: wire.adjustment,
      layoutHash: hash,
    },
  };
}
