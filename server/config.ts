// 关卡工坊本机服务的配置（P8）：只从环境变量读取（可以用 node 的 --env-file-if-exists=.env，.env 不进仓库）。
// 密钥（MW_OPENAI_API_KEY）只在服务进程里使用：不写日志、不进错误信息、不返回给浏览器、不进统计。

import { z } from 'zod';
import { PROVIDER_NAMES, type ProviderName } from '../src/workshop/protocol';
import { DEFAULT_PORT } from './port';

/** 只监听这个地址（不能配置）。 */
export const HOST = '127.0.0.1';

/** 加载模型时限的默认值（毫秒）。没设 MW_WORKSHOP_PREPARE_TIMEOUT_MS 时，取它和整个请求时限中较小的（F5）。 */
export const DEFAULT_PREPARE_TIMEOUT_MS = 150_000;
export { DEFAULT_PORT };

export interface WorkshopConfig {
  readonly port: number;
  /** ollama（默认）、openai（OpenAI 兼容接口）、off（不用模型）；fake 只给测试用（按预设顺序返回固定回复）。 */
  readonly provider: ProviderName;
  readonly ollama: {
    readonly baseUrl: string;
    readonly model: string;
    /** 上下文长度（随请求传给 Ollama，不改 Ollama 的配置）。 */
    readonly numCtx: number;
  };
  readonly openai: {
    readonly baseUrl: string | null;
    readonly model: string | null;
    /** 密钥：只用来调用接口。 */
    readonly apiKey: string | null;
  };
  readonly limits: {
    /** 玩家的一句话最多几个字符。 */
    readonly maxRequestChars: number;
    /** 请求体最多多少字节。 */
    readonly maxBodyBytes: number;
    /** 单次模型调用的超时（毫秒）。 */
    readonly callTimeoutMs: number;
    /** 整个生成请求的超时（毫秒）。 */
    readonly requestTimeoutMs: number;
    /**
     * 加载模型的超时（毫秒，F2）。设了 MW_WORKSHOP_PREPARE_TIMEOUT_MS 时：不小于 1000，不大于整个生成请求的超时。
     * 没设时（F5）：取 DEFAULT_PREPARE_TIMEOUT_MS 和整个生成请求的超时中较小的，这个推出来的值可以小于 1000。
     */
    readonly prepareTimeoutMs: number;
  };
  /** 统计文件（JSONL，每个请求一行）。 */
  readonly statsPath: string;
  /** fake 提供方：每次模型调用前等待多久（毫秒；测试用，用来测取消）。 */
  readonly fakeDelayMs: number;
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envObject = z.object({
  MW_LLM_PROVIDER: z.enum(PROVIDER_NAMES).default('ollama'),
  MW_OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  MW_OLLAMA_MODEL: z.string().min(1).default('qwen3.5:9b-q4_K_M'),
  MW_OLLAMA_NUM_CTX: int(2048, 262144).default(8192),
  MW_OPENAI_BASE_URL: z.url().optional(),
  MW_OPENAI_MODEL: z.string().min(1).optional(),
  MW_OPENAI_API_KEY: z.string().min(1).optional(),
  MW_WORKSHOP_PORT: int(0, 65535).default(DEFAULT_PORT),
  MW_WORKSHOP_MAX_REQUEST_CHARS: int(10, 2000).default(200),
  MW_WORKSHOP_MAX_BODY_BYTES: int(1024, 1_000_000).default(32 * 1024),
  MW_WORKSHOP_CALL_TIMEOUT_MS: int(100, 600_000).default(60_000),
  MW_WORKSHOP_REQUEST_TIMEOUT_MS: int(200, 1_800_000).default(180_000),
  // 没设时的值在 loadConfig 里按整个请求时限推出来（F5），所以这里不给默认值
  MW_WORKSHOP_PREPARE_TIMEOUT_MS: int(1000, 1_800_000).optional(),
  MW_WORKSHOP_STATS: z.string().min(1).default('.local/workshop-stats.jsonl'),
  MW_FAKE_DELAY_MS: int(0, 600_000).default(0),
});

// 加载模型算在整个生成请求里，所以设了的加载时限不能比整个请求的超时还长
const envSchema = envObject.superRefine((e, ctx) => {
  if (e.MW_WORKSHOP_PREPARE_TIMEOUT_MS !== undefined && e.MW_WORKSHOP_PREPARE_TIMEOUT_MS > e.MW_WORKSHOP_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom', path: ['MW_WORKSHOP_PREPARE_TIMEOUT_MS'], message: '不能大于 MW_WORKSHOP_REQUEST_TIMEOUT_MS' });
  }
});

export type ConfigResult = { readonly ok: true; readonly config: WorkshopConfig } | { readonly ok: false; readonly problems: readonly string[] };

/** 从环境变量读配置。出错时只说哪个变量不对，不回显变量的值（避免把密钥写进错误信息）。 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(envObject.shape)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') cleaned[key] = value.trim();
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    // 自定义规则的说明是固定的文字（不含变量的值），其他问题只给出类别
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `环境变量 ${issue.path.map(String).join('.')} 不对：${issue.code === 'custom' ? issue.message : issue.code}`),
    };
  }
  const e = parsed.data;
  return {
    ok: true,
    config: {
      port: e.MW_WORKSHOP_PORT,
      provider: e.MW_LLM_PROVIDER,
      ollama: { baseUrl: e.MW_OLLAMA_BASE_URL.replace(/\/+$/, ''), model: e.MW_OLLAMA_MODEL, numCtx: e.MW_OLLAMA_NUM_CTX },
      openai: { baseUrl: e.MW_OPENAI_BASE_URL?.replace(/\/+$/, '') ?? null, model: e.MW_OPENAI_MODEL ?? null, apiKey: e.MW_OPENAI_API_KEY ?? null },
      limits: {
        maxRequestChars: e.MW_WORKSHOP_MAX_REQUEST_CHARS,
        maxBodyBytes: e.MW_WORKSHOP_MAX_BODY_BYTES,
        callTimeoutMs: e.MW_WORKSHOP_CALL_TIMEOUT_MS,
        requestTimeoutMs: e.MW_WORKSHOP_REQUEST_TIMEOUT_MS,
        // 没设（未定义或空白）时取默认值和整个请求时限中较小的（F5）：只调小整个请求时限时服务照常启动
        prepareTimeoutMs: e.MW_WORKSHOP_PREPARE_TIMEOUT_MS ?? Math.min(DEFAULT_PREPARE_TIMEOUT_MS, e.MW_WORKSHOP_REQUEST_TIMEOUT_MS),
      },
      statsPath: e.MW_WORKSHOP_STATS,
      fakeDelayMs: e.MW_FAKE_DELAY_MS,
    },
  };
}

/** 当前提供方的模型名（给浏览器和统计用；不含密钥）。 */
export function modelNameOf(config: WorkshopConfig): string | null {
  switch (config.provider) {
    case 'ollama':
      return config.ollama.model;
    case 'openai':
      return config.openai.model;
    case 'fake':
      return 'fake-scripted';
    case 'off':
      return null;
  }
}
