// 关卡工坊（P8）浏览器和本机服务之间的接口：请求和响应都用这里的 zod schema 校验（两边共用）。纯模块，只依赖 zod。
//
// 接口（都在 /api/workshop 下，JSON）：
// - GET  health   → HealthResponse：模型能不能用，提供方和模型名（不含密钥）。
// - POST generate → GenerateResponse：生成到预览（或回退、取消）为止。同一时间只处理一个，已有一个在进行时返回 busy。
// - POST cancel   → OkResponse：取消正在进行的生成（同时中止模型调用）。
// - POST confirm  → FinalizeResponse：确认预览，定稿。按生成标识只定稿一次，重复确认返回同一份结果。
// - POST discard  → OkResponse：放弃预览。
// 出错时一律返回 ErrorResponse（错误码见 ERROR_CODES）。

import { z } from 'zod';
import { briefSchema, visualPresetSchema } from '../game/level/gen/brief';
import { t } from '../i18n';
import { LANGS } from '../i18n/lang';

/** 错误码。 */
export const ERROR_CODES = {
  /** 已经有一个生成在进行（HTTP 409）。 */
  busy: 'busy',
  /** 请求不合规：JSON、字段或长度不对（HTTP 400）。 */
  badRequest: 'bad-request',
  /** 请求体超过上限（HTTP 413）。 */
  tooLarge: 'too-large',
  /** 没有这个接口（HTTP 404）。 */
  notFound: 'not-found',
  /** 找不到这次生成的预览：服务重启过，或者已经放弃、过期（HTTP 410）。 */
  expired: 'expired',
  /** 预览的版本号对不上（HTTP 409）。 */
  stale: 'stale',
  /** 模型不可用（提供方是 off，或者连不上）（HTTP 503）。 */
  unavailable: 'unavailable',
  /** 服务内部错误（HTTP 500）。 */
  internal: 'internal',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 请求里的字符串长度的硬上限（服务端还有可配置的、更小的上限）。 */
export const HARD_LIMITS = { requestText: 2000, roster: 20, personId: 128, personName: 64 } as const;

/** 生成标识：浏览器生成（UUID），开始生成时就知道，取消时用它。 */
export const generationIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

export const PERSON_ROLES = ['companion', 'guard'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

/** 名册快照里的一个人物：只有元数据（不含模型文件）。 */
export const rosterPersonSchema = z.strictObject({
  id: z.string().min(1).max(HARD_LIMITS.personId),
  name: z.string().min(1).max(HARD_LIMITS.personName),
  /** 允许的分工（至少一种，不重复）。 */
  roles: z
    .array(z.enum(PERSON_ROLES))
    .min(1)
    .max(PERSON_ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, t('protocol.dupRoles')),
});
export type RosterPersonSnapshot = z.output<typeof rosterPersonSchema>;

export const generateRequestSchema = z.strictObject({
  generationId: generationIdSchema,
  /** 玩家的一句话。 */
  text: z.string().trim().min(1).max(HARD_LIMITS.requestText),
  /** 选中人物的快照。 */
  roster: z
    .array(rosterPersonSchema)
    .max(HARD_LIMITS.roster)
    .refine((list) => new Set(list.map((p) => p.id)).size === list.length, t('protocol.dupPeople')),
  /** 界面的语言（F7）：给玩家看的说明和模型写的文字用它。没给时按 zh。 */
  lang: z.enum(LANGS).optional(),
});
export type GenerateRequest = z.output<typeof generateRequestSchema>;

export const generationRefSchema = z.strictObject({ generationId: generationIdSchema });

export const confirmRequestSchema = z.strictObject({
  generationId: generationIdSchema,
  /** 预览的版本号。 */
  version: z.number().int().positive(),
  /** 出预览的那个服务进程的标识（服务重启后不同）。 */
  serviceId: z.string().min(1).max(64),
});
export type ConfirmRequest = z.output<typeof confirmRequestSchema>;

export const PROVIDER_NAMES = ['ollama', 'openai', 'off', 'fake'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const healthResponseSchema = z.strictObject({
  ok: z.literal(true),
  serviceId: z.string(),
  provider: z.enum(PROVIDER_NAMES),
  /** 模型名（不含密钥）；off 时为 null。 */
  model: z.string().nullable(),
  /** 模型现在能不能用。 */
  available: z.boolean(),
  /** 不能用的原因。 */
  reason: z.string().nullable(),
  /** 一句话的长度上限（字符）。 */
  maxRequestChars: z.number().int().positive(),
  /** 是否有生成在进行。 */
  busy: z.boolean(),
});
export type HealthResponse = z.output<typeof healthResponseSchema>;

/** 定稿或预览的关卡（来源记为 model）。浏览器收到后再用 parseLevel 校验布局、核对哈希。 */
export const wireLevelSchema = z.strictObject({
  source: z.literal('model'),
  title: z.string().min(1),
  layout: z.unknown(),
  layoutHash: z.string().regex(/^[0-9a-f]{16}$/),
  visual: visualPresetSchema,
  rules: z.strictObject({
    timeLimit: z.number().positive(),
    target: z.number().int().positive(),
    penaltySeconds: z.number().nonnegative(),
    cooldownSeconds: z.number().nonnegative(),
  }),
  brief: briefSchema,
  seed: z.string(),
  schemaVersion: z.number().int().positive(),
  generatorVersion: z.number().int().positive(),
  adjustment: z
    .strictObject({ reason: z.enum(['cannot-fit', 'too-far']), change: z.string(), message: z.string(), requestedBrief: briefSchema })
    .nullable(),
});
export type WireLevel = z.output<typeof wireLevelSchema>;

/** 生成的最终结果（统计的六类，见 docs/status.md 的 P8 一节）。 */
export const OUTCOMES = ['model-first', 'model-repaired', 'program-adjusted', 'fallback', 'cancelled', 'error'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Readonly<Record<Outcome, string>> = {
  'model-first': t('outcome.modelFirst'),
  'model-repaired': t('outcome.modelRepaired'),
  'program-adjusted': t('outcome.programAdjusted'),
  fallback: t('outcome.fallback'),
  cancelled: t('outcome.cancelled'),
  error: t('outcome.error'),
};

const modelInfo = { provider: z.enum(PROVIDER_NAMES), model: z.string().nullable() };

export const previewSchema = z.strictObject({
  level: wireLevelSchema,
  outcome: z.enum(['model-first', 'model-repaired', 'program-adjusted']),
  /** 模型修复了几次（0–2）。 */
  repairs: z.number().int().min(0),
  /** 程序调整：改了什么、为什么。 */
  adjustment: z.strictObject({ change: z.string(), message: z.string() }).nullable(),
  /** 和请求的主要差别（程序调整造成的）。 */
  differences: z.array(z.string()),
  /** 修复前各次的问题（给玩家看的简短说明）。 */
  history: z.array(z.string()),
  ...modelInfo,
});
export type Preview = z.output<typeof previewSchema>;

export const fallbackSchema = z.strictObject({
  /** 回退的原因类别：模型三次都没成功（fallback），或服务错误、超时（error）。 */
  outcome: z.enum(['fallback', 'error']),
  /** 原因（给玩家看）。 */
  reason: z.string(),
  /** 各次尝试的问题。 */
  history: z.array(z.string()),
  /** 回退关卡和请求的主要差别。 */
  differences: z.array(z.string()),
  /** 回退到的内置关卡。 */
  fallbackId: z.string(),
  ...modelInfo,
});
export type Fallback = z.output<typeof fallbackSchema>;

export const generateResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ok: z.literal(true), status: z.literal('preview'), generationId: generationIdSchema, version: z.number().int().positive(), serviceId: z.string(), preview: previewSchema }),
  z.strictObject({ ok: z.literal(true), status: z.literal('fallback'), generationId: generationIdSchema, serviceId: z.string(), fallback: fallbackSchema }),
  z.strictObject({ ok: z.literal(true), status: z.literal('cancelled'), generationId: generationIdSchema, serviceId: z.string() }),
]);
export type GenerateResponse = z.output<typeof generateResponseSchema>;

export const finalizeResponseSchema = z.strictObject({
  ok: z.literal(true),
  generationId: generationIdSchema,
  /** 这次生成已经定稿过：返回的是同一份结果。 */
  duplicate: z.boolean(),
  level: wireLevelSchema,
  ...modelInfo,
});
export type FinalizeResponse = z.output<typeof finalizeResponseSchema>;

export const okResponseSchema = z.strictObject({ ok: z.literal(true) });

export const errorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: z.enum(Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]), message: z.string() }),
});
export type ErrorResponse = z.output<typeof errorResponseSchema>;
