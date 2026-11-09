// 导入的各项上限和阈值：都放在这里，文档（docs/status.md 的 P3 一节）列出同样的值。
// 这些是导入检查和显示用的参数，不是玩法规格；玩法胶囊仍只用 src/game/spec.ts。

const MB = 1024 * 1024;

export const IMPORT_LIMITS = Object.freeze({
  /** 文件超过这个大小时提示“文件较大”。 */
  fileWarnBytes: 50 * MB,
  /** 文件超过这个大小时拒绝（读取之前就拒绝）。 */
  fileRejectBytes: 150 * MB,
  /** 三角面超过这个数时提示。 */
  trianglesWarn: 300_000,
  /** 三角面超过这个数时拒绝。 */
  trianglesReject: 1_000_000,
  /** 骨骼（所有 skin 的关节去重后）超过这个数时拒绝。 */
  bonesMax: 256,
  /** 动画片段超过这个数时拒绝。 */
  clipsMax: 64,
  /** 贴图边长超过这个数时拒绝。 */
  textureEdgeMax: 8192,
  /** 游戏场景里同时存在的导入实例上限（导入卡片里的预览不算）。 */
  instancesMax: 12,
});

/** 上限的结构（数值放宽成 number，测试可以传入更小的上限）。 */
export type ImportLimits = { readonly [K in keyof typeof IMPORT_LIMITS]: number };

export const DISPLAY = Object.freeze({
  /** 默认显示身高（米）。只影响显示，玩法胶囊不变。 */
  defaultHeight: 1.75,
  minHeight: 1.2,
  maxHeight: 2.4,
});

export const CLIP_RULES = Object.freeze({
  /** 时长短于这个值（秒）的片段算“极短”（例如只有一帧的姿势片段），不作为待机、走、跑的自动建议。 */
  shortClipSeconds: 0.1,
  /** 承担整体位移的节点在片段内相对起点的水平位移超过这个值（模型空间，米）时标为“带位移”。 */
  rootMotionThreshold: 0.2,
  /** 动作切换的淡入淡出时长（秒）。 */
  fadeSeconds: 0.2,
  /** 落地后过渡回移动 / 待机的淡入时长（秒）。 */
  landFadeSeconds: 0.1,
  /** 落地状态持续的时长（秒）。 */
  landHoldSeconds: 0.15,
});

/** 本版没有接解码器的压缩扩展：出现在 extensionsRequired 里就拒绝。 */
export const UNSUPPORTED_COMPRESSION_EXTENSIONS: readonly string[] = Object.freeze([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_texture_basisu',
]);

export const SUPPORTED_EXTENSIONS = Object.freeze(['.glb', '.obj', '.stl', '.ply'] as const);
