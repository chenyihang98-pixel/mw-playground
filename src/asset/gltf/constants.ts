// glTF 2.0 / GLB 容器的常量。检查模块和夹具写入器共用。

/** GLB 头的 magic：ASCII "glTF"，小端读作 uint32。 */
export const GLB_MAGIC = 0x46546c67;
export const GLB_VERSION = 2;
export const GLB_HEADER_BYTES = 12;
export const GLB_CHUNK_HEADER_BYTES = 8;
/** 块类型 "JSON"。 */
export const CHUNK_TYPE_JSON = 0x4e4f534a;
/** 块类型 "BIN\0"。 */
export const CHUNK_TYPE_BIN = 0x004e4942;

export const COMPONENT_TYPE = {
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
} as const;

export type ComponentType = (typeof COMPONENT_TYPE)[keyof typeof COMPONENT_TYPE];

export function componentByteSize(componentType: number): number | undefined {
  switch (componentType) {
    case COMPONENT_TYPE.BYTE:
    case COMPONENT_TYPE.UNSIGNED_BYTE:
      return 1;
    case COMPONENT_TYPE.SHORT:
    case COMPONENT_TYPE.UNSIGNED_SHORT:
      return 2;
    case COMPONENT_TYPE.UNSIGNED_INT:
    case COMPONENT_TYPE.FLOAT:
      return 4;
    default:
      return undefined;
  }
}

export type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';

export function accessorComponentCount(type: string): number | undefined {
  switch (type) {
    case 'SCALAR':
      return 1;
    case 'VEC2':
      return 2;
    case 'VEC3':
      return 3;
    case 'VEC4':
    case 'MAT2':
      return 4;
    case 'MAT3':
      return 9;
    case 'MAT4':
      return 16;
    default:
      return undefined;
  }
}

export const PRIMITIVE_MODE = {
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
} as const;

/** 图元级的几何压缩扩展：数据要解码后才能读。 */
export const PRIMITIVE_DECODER_EXTENSIONS = ['KHR_draco_mesh_compression'] as const;
/** bufferView 级的压缩扩展。 */
export const BUFFER_VIEW_DECODER_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_meshopt_compression'] as const;
/** 所有需要额外解码器的扩展（用于在报告里标出）。KHR_texture_basisu 需要 KTX2/Basis 转码器。 */
export const DECODER_EXTENSIONS: readonly string[] = [
  ...PRIMITIVE_DECODER_EXTENSIONS,
  ...BUFFER_VIEW_DECODER_EXTENSIONS,
  'KHR_texture_basisu',
];
