// 导入卡片上的说法（P6，M3）。不引入界面代码和样式，单元测试可以直接用。

import { t } from '../../i18n';

/**
 * 没有骨骼的模型没有绑定姿态：界面上把兜底的“绑定姿态”说成“静止姿态”（只改说法，兜底规则不变）。
 * F6：按当前语言的说法替换（各语言里用到“绑定姿态”的提示都包含 pose.bind 的原词，单元测试核对）。
 */
export function poseWording(text: string, skinned: boolean): string {
  return skinned ? text : text.replaceAll(t('pose.bind'), t('pose.static'));
}
