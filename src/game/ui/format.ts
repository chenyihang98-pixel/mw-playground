// 界面上的数字格式（纯函数，不依赖 DOM 和样式表）。

/** 剩余时间的显示格式：m:ss.s，向上取到 0.1 秒，不显示负数。 */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.ceil(seconds * 10 - 1e-6));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${String(minutes)}:${rest.toFixed(1).padStart(4, '0')}`;
}
