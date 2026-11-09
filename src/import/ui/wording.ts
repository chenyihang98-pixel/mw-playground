// 导入卡片上的说法（P6，M3）。不引入界面代码和样式，单元测试可以直接用。

/** 没有骨骼的模型没有绑定姿态：界面上把兜底的“绑定姿态”说成“静止姿态”（只改说法，兜底规则不变）。 */
export function poseWording(text: string, skinned: boolean): string {
  return skinned ? text : text.replaceAll('绑定姿态', '静止姿态');
}
