// glTF JSON 的宽松结构校验（zod）。只校验本工具会用到的字段的类型，未知字段原样保留。
// 字段类型不对（例如 nodes 不是数组、索引是负数）时，文件不是合法的 glTF，检查以退出码 1 结束。

import { z } from 'zod';

const index = z.number().int().nonnegative();
const name = z.string().optional();
const extensions = z.record(z.string(), z.unknown()).optional();

const bufferSchema = z.looseObject({ byteLength: index, uri: z.string().optional(), name, extensions });

const bufferViewSchema = z.looseObject({
  buffer: index,
  byteOffset: index.optional(),
  byteLength: index,
  byteStride: z.number().int().positive().optional(),
  target: z.number().int().optional(),
  name,
  extensions,
});

const accessorSchema = z.looseObject({
  bufferView: index.optional(),
  byteOffset: index.optional(),
  componentType: z.number().int(),
  normalized: z.boolean().optional(),
  count: index,
  type: z.string(),
  min: z.array(z.number()).optional(),
  max: z.array(z.number()).optional(),
  sparse: z.unknown().optional(),
  name,
});

const primitiveSchema = z.looseObject({
  attributes: z.record(z.string(), index),
  indices: index.optional(),
  material: index.optional(),
  mode: z.number().int().optional(),
  extensions,
});

const meshSchema = z.looseObject({ primitives: z.array(primitiveSchema), name });

const nodeSchema = z.looseObject({
  name,
  children: z.array(index).optional(),
  mesh: index.optional(),
  skin: index.optional(),
  matrix: z.array(z.number()).length(16).optional(),
  translation: z.array(z.number()).length(3).optional(),
  rotation: z.array(z.number()).length(4).optional(),
  scale: z.array(z.number()).length(3).optional(),
});

const sceneSchema = z.looseObject({ nodes: z.array(index).optional(), name });

const skinSchema = z.looseObject({
  joints: z.array(index),
  inverseBindMatrices: index.optional(),
  skeleton: index.optional(),
  name,
});

const imageSchema = z.looseObject({
  uri: z.string().optional(),
  mimeType: z.string().optional(),
  bufferView: index.optional(),
  name,
});

const textureSchema = z.looseObject({ source: index.optional(), sampler: index.optional(), name, extensions });

const animationSchema = z.looseObject({
  name,
  channels: z.array(
    z.looseObject({
      sampler: index,
      target: z.looseObject({ node: index.optional(), path: z.string() }),
    }),
  ),
  samplers: z.array(
    z.looseObject({
      input: index,
      output: index,
      interpolation: z.string().optional(),
    }),
  ),
  // extras 可以是任何 JSON 值；是不是对象由检查逻辑报告，不在这里拒绝。
  extras: z.unknown().optional(),
});

export const gltfSchema = z.looseObject({
  asset: z
    .looseObject({
      version: z.string().optional(),
      generator: z.string().optional(),
      minVersion: z.string().optional(),
    })
    .optional(),
  extensionsUsed: z.array(z.string()).optional(),
  extensionsRequired: z.array(z.string()).optional(),
  scene: index.optional(),
  scenes: z.array(sceneSchema).optional(),
  nodes: z.array(nodeSchema).optional(),
  meshes: z.array(meshSchema).optional(),
  accessors: z.array(accessorSchema).optional(),
  bufferViews: z.array(bufferViewSchema).optional(),
  buffers: z.array(bufferSchema).optional(),
  images: z.array(imageSchema).optional(),
  textures: z.array(textureSchema).optional(),
  skins: z.array(skinSchema).optional(),
  animations: z.array(animationSchema).optional(),
});

export type GltfJson = z.infer<typeof gltfSchema>;
export type GltfAccessor = z.infer<typeof accessorSchema>;
export type GltfNode = z.infer<typeof nodeSchema>;
export type GltfAnimation = z.infer<typeof animationSchema>;

export function formatSchemaIssues(error: z.ZodError, limit = 5): string {
  const lines = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '（根）';
    return `${path}：${issue.message}`;
  });
  const more = error.issues.length > limit ? `；另有 ${error.issues.length - limit} 处` : '';
  return lines.join('；') + more;
}
