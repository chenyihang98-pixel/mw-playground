// GLB 结构检查报告的类型。报告是纯 JSON 数据，命令行和以后浏览器里的导入预检都用它。

/** 一个指标：要么算出来了，要么写明为什么没算。算不出的指标绝不填 0。 */
export type Metric<T> =
  | { readonly status: 'computed'; readonly value: T }
  | { readonly status: 'not-computed'; readonly reason: string };

export function computed<T>(value: T): Metric<T> {
  return { status: 'computed', value };
}

export function notComputed<T>(reason: string): Metric<T> {
  return { status: 'not-computed', reason };
}

export type Vec3 = [number, number, number];

export interface Box3 {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly size: Vec3;
}

export interface ChunkReport {
  readonly index: number;
  readonly type: 'JSON' | 'BIN' | 'unknown';
  readonly typeCode: number;
  /** 块数据在文件里的起始位置（块头之后）。 */
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface ContainerReport {
  /** 文件实际大小（字节）。声明长度与实际长度不一致的文件按容器损坏处理，不会生成报告。 */
  readonly fileSize: number;
  readonly version: number;
  /** GLB 头里声明的总长度。 */
  readonly declaredLength: number;
  /** 实际读到的字节数。 */
  readonly actualLength: number;
  readonly lengthMatches: boolean;
  readonly chunks: readonly ChunkReport[];
}

export interface AssetInfo {
  readonly generator: string | null;
  /** 必需字段；缺失或不是 2.x 时检查以 invalid-gltf 结束。 */
  readonly version: string;
  readonly minVersion: string | null;
}

export interface ExternalResource {
  readonly kind: 'buffer' | 'image';
  readonly index: number;
  readonly uri: string;
}

export interface PrimitiveReport {
  readonly mesh: number;
  readonly primitive: number;
  readonly mode: number;
  /** 使用的图元级压缩扩展（例如 KHR_draco_mesh_compression），没有则为 null。 */
  readonly compression: string | null;
  readonly triangles: Metric<number>;
}

export interface MeshesReport {
  readonly meshCount: number;
  readonly primitiveCount: number;
  /** 按 indices（没有则 POSITION）的 count 和图元 mode 计算。 */
  readonly triangles: Metric<number>;
  readonly primitives: readonly PrimitiveReport[];
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface ImageReport {
  readonly index: number;
  readonly name: string | null;
  readonly source: 'bufferView' | 'data-uri' | 'external-uri' | 'none';
  readonly declaredMimeType: string | null;
  readonly detectedFormat: 'png' | 'jpeg' | null;
  readonly size: Metric<ImageSize>;
}

export interface TexturesReport {
  readonly textureCount: number;
  readonly imageCount: number;
  readonly images: readonly ImageReport[];
}

export interface SkinReport {
  readonly index: number;
  readonly name: string | null;
  readonly jointCount: number;
  readonly skeleton: number | null;
}

export interface SkinsReport {
  readonly count: number;
  readonly skins: readonly SkinReport[];
  /** 所有 skin 的关节去重后的数量（同一个节点被多个 skin 引用只算一次）。 */
  readonly uniqueJointCount: number;
}

/** 原始 JSON 里 animation.extras 的情况。 */
export type ExtrasReport =
  | { readonly kind: 'missing' }
  | { readonly kind: 'object' }
  | { readonly kind: 'not-object'; readonly valueType: string; readonly value: unknown };

/**
 * 原始 JSON 里 animation.extras.loop 的值（不是加载后的值）。
 * missing.reason：'no-extras'（没有 extras）、'extras-not-object'（extras 不是对象）、'no-loop-key'（extras 里没有 loop）。
 */
export type LoopReport =
  | { readonly kind: 'true' }
  | { readonly kind: 'false' }
  | { readonly kind: 'missing'; readonly reason: 'no-extras' | 'extras-not-object' | 'no-loop-key' }
  | { readonly kind: 'other'; readonly valueType: string; readonly value: unknown };

export interface HorizontalMotionReport {
  readonly channel: number;
  readonly node: number;
  readonly nodeName: string | null;
  /** 采样器的插值方式（没写时为 LINEAR）。CUBICSPLINE 只看关键帧的值，不含关键帧之间的插值。 */
  readonly interpolation: string;
  /**
   * 模型空间，XZ 平面，各关键帧相对首帧的最大水平距离（从 BIN 读出，关键帧之间不插值）。
   * 节点的父链（到场景根为止）用文件里的静态变换换到模型空间；父链上其他节点的 translation 动画不计入。
   * 父链在同一个动画里有 rotation 或 scale 通道时坐标系不确定，写“未计算”和原因，不填数字。
   */
  readonly displacement: Metric<{
    /** 各关键帧相对首帧的最大水平距离（模型空间）。 */
    readonly maxDistance: number;
    /** 距离最大的关键帧序号（从 0 开始；只有一个关键帧或一直不动时为 0）。 */
    readonly atKeyframe: number;
    readonly keyframes: number;
    /** 首帧在模型空间里的 XZ。 */
    readonly first: [number, number];
  }>;
}

export interface AnimationReport {
  readonly index: number;
  /** 原始 name 字段；没有 name 字段时为 null。 */
  readonly rawName: string | null;
  /** 没有 name 字段或 name 为空字符串。 */
  readonly unnamed: boolean;
  /** three r187 GLTFLoader 加载后的片段名：有名字用原名，否则 animation_<序号>。 */
  readonly loaderName: string;
  readonly channelCount: number;
  readonly samplerCount: number;
  /** 各个 target.path 的通道数。 */
  readonly targetPaths: Readonly<Record<string, number>>;
  readonly duration: {
    /** 输入（时间）访问器声明的 max 中的最大值。 */
    readonly declared: Metric<number>;
    /** 从 BIN 读出的时间值中的最大值。 */
    readonly actual: Metric<number>;
  };
  readonly extras: ExtrasReport;
  readonly loop: LoopReport;
  /** 与本片段加载后同名的其他片段序号；不重名时为空数组。 */
  readonly duplicateOf: readonly number[];
  readonly horizontalMotion: readonly HorizontalMotionReport[];
}

export interface AnimationsReport {
  readonly count: number;
  readonly animations: readonly AnimationReport[];
  /** 加载后名字相同的片段组。 */
  readonly duplicateNames: readonly { readonly name: string; readonly indices: readonly number[] }[];
}

export interface BoundsReport {
  /** 计算用的场景范围，例如 "scenes[0]"。 */
  readonly basis: string;
  /** POSITION 访问器 min/max + 节点静态变换。 */
  readonly declared: Metric<Box3>;
  /** 从 BIN 读出的顶点 + 节点静态变换。 */
  readonly actual: Metric<Box3>;
}

export interface InspectReport {
  readonly reportVersion: 1;
  readonly container: ContainerReport;
  readonly asset: AssetInfo;
  readonly extensionsUsed: readonly string[];
  readonly extensionsRequired: readonly string[];
  readonly externalResources: readonly ExternalResource[];
  readonly meshes: MeshesReport;
  readonly textures: TexturesReport;
  readonly skins: SkinsReport;
  readonly animations: AnimationsReport;
  readonly bounds: BoundsReport;
  /** 不影响完成检查的问题（不符合规范但能继续解析的地方）。 */
  readonly issues: readonly string[];
}

export type InspectErrorCode =
  | 'empty'
  | 'not-glb'
  | 'unsupported-version'
  | 'truncated'
  | 'length-mismatch'
  | 'bad-chunks'
  | 'invalid-json'
  | 'invalid-gltf';

export interface InspectError {
  readonly code: InspectErrorCode;
  readonly message: string;
}

export type InspectResult =
  | { readonly ok: true; readonly report: InspectReport }
  | { readonly ok: false; readonly error: InspectError };
