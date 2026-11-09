// GLB 结构检查的公共入口。纯模块：命令行（scripts/inspect-asset.ts）和以后浏览器里的导入预检共用。
export { inspectGlb, valueType, decoderExtensionsIn } from './inspect';
export {
  formatInspectReport,
  formatNumber,
  describeLoop,
  describeExtras,
  describeAnimationName,
  LOOP_NOTE,
  BOUNDS_NOTE,
} from './format';
export { parseGlbContainer, sniffNonGlb } from './container';
export { readImageSize, sniffImageFormat } from './images';
export * from './types';
