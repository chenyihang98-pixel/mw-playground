// 模型提供方（P8）：Ollama（默认，本机）、OpenAI 兼容接口（可选的外部接口）、fake（测试用）。
// 工坊的流程只通过 LlmProvider 用模型：
// - chat：带工具的普通对话（“理解请求”这一步，可以调用“查名册快照”工具）；
// - structured：结构化输出，把说明书的 JSON Schema 交给模型，返回模型输出的文本，之后由调用方 JSON.parse 再用 zod 校验。
// 每次调用都新建一个模型对象，fetch 绑定这次调用的 AbortSignal：取消或超时时真正中断 HTTP 请求，模型那边随之停止生成。
// 本机失败时不会自动切换到外部接口：提供方只由配置决定。

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { ProviderName } from '../src/workshop/protocol';
import { modelNameOf, type WorkshopConfig } from './config';
import { describeCallError } from './errors';

export interface Availability {
  readonly available: boolean;
  /** 不能用的原因（给浏览器看）。 */
  readonly reason: string | null;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string | null;
  /** 带工具的对话（工具调用由调用方执行）。 */
  chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage>;
  /** 结构化输出：schema 是 JSON Schema。返回模型输出的文本。 */
  structured(messages: readonly BaseMessage[], schema: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /** 模型能不能用。 */
  availability(signal: AbortSignal): Promise<Availability>;
}

/** 调用参数（采样温度、输出长度上限）。 */
export const SAMPLING = {
  understand: { temperature: 0.3, maxTokens: 400 },
  brief: { temperature: 0.4, maxTokens: 900 },
} as const;

/** fetch 绑定一个 AbortSignal（和库自己传的 signal 合并）。 */
export function boundFetch(signal: AbortSignal, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

function textOf(message: AIMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  return content.map((part) => (typeof part === 'string' ? part : part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}

// ---------------------------------------------------------------- Ollama

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly model: string;

  constructor(
    private readonly config: WorkshopConfig['ollama'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }

  private create(signal: AbortSignal, sampling: { temperature: number; maxTokens: number }): ChatOllama {
    return new ChatOllama({
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      // 关闭思考：实测（docs/workshop-notes.md）关闭后响应快得多，结构化输出的通过率不降
      think: false,
      temperature: sampling.temperature,
      numPredict: sampling.maxTokens,
      numCtx: this.config.numCtx,
      // 不检查、不拉取模型
      checkOrPullModel: false,
      maxRetries: 0,
      fetch: boundFetch(signal, this.fetchImpl),
    });
  }

  async chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage> {
    const model = this.create(signal, SAMPLING.understand);
    const runnable = tools.length > 0 ? model.bindTools([...tools]) : model;
    const reply = await runnable.invoke([...messages], { signal });
    return new AIMessage({ content: reply.content, tool_calls: reply.tool_calls ?? [] });
  }

  async structured(messages: readonly BaseMessage[], schema: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const model = this.create(signal, SAMPLING.brief);
    // Ollama 的结构化输出：把 JSON Schema 放进 format（Ollama 按它约束输出）；返回后调用方仍用 zod 再校验一次
    const reply = await model.invoke([...messages], { format: schema, signal });
    return textOf(reply);
  }

  async availability(signal: AbortSignal): Promise<Availability> {
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/tags`, { signal });
      if (!res.ok) return { available: false, reason: `Ollama 返回错误（HTTP ${String(res.status)}）` };
      const body = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
      const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string');
      if (!names.includes(this.config.model)) return { available: false, reason: `Ollama 里没有模型 ${this.config.model}（本服务不会自动拉取模型）` };
      return { available: true, reason: null };
    } catch {
      return { available: false, reason: `连不上 Ollama（${this.config.baseUrl}）` };
    }
  }
}

// ---------------------------------------------------------------- OpenAI 兼容接口

/**
 * OpenAI 兼容接口（可选）。只用 Chat Completions（POST {baseUrl}/chat/completions），用到的能力：
 * - 普通对话和工具调用（tools / tool_calls，function calling）；
 * - 结构化输出：response_format = { type: "json_schema", json_schema: { name, schema, strict: false } }。
 * 不用流式、不用 Responses API、不用其他内置工具。
 *
 * 健康检查：配置齐全之后，再用 GET {baseUrl}/models（带密钥）确认连得上、密钥被接受、列表里有这个模型。
 * 接口不支持列出模型（404）时，按最近一次调用的结果：连不上、鉴权失败或模型不存在时报不可用，调用成功后恢复。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly model: string | null;
  /** 最近一次调用失败的原因（连不上、鉴权失败、没有这个模型）；调用成功后清掉。 */
  private lastFailure: string | null = null;

  constructor(
    private readonly config: WorkshopConfig['openai'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }

  private create(signal: AbortSignal, sampling: { temperature: number; maxTokens: number }): ChatOpenAICompletions {
    const { baseUrl, model, apiKey } = this.config;
    if (!baseUrl || !model || !apiKey) throw new Error('OpenAI 兼容接口的配置不全');
    return new ChatOpenAICompletions({
      model,
      apiKey,
      temperature: sampling.temperature,
      maxTokens: sampling.maxTokens,
      maxRetries: 0,
      streaming: false,
      configuration: { baseURL: baseUrl, fetch: boundFetch(signal, this.fetchImpl), maxRetries: 0 },
    });
  }

  /** 记下调用的结果：连不上、鉴权失败、没有这个模型时记为失败原因；成功时清掉。取消和超时不算。 */
  private async remember<T>(work: Promise<T>): Promise<T> {
    try {
      const value = await work;
      this.lastFailure = null;
      return value;
    } catch (error) {
      const info = describeCallError(error);
      const status = info.kind === 'http' ? /HTTP (\d{3})/.exec(info.message)?.[1] : undefined;
      if (info.kind === 'network') this.lastFailure = '连不上 OpenAI 兼容接口';
      else if (status === '401' || status === '403') this.lastFailure = `OpenAI 兼容接口拒绝了密钥（HTTP ${status}）`;
      else if (status === '404') this.lastFailure = `OpenAI 兼容接口找不到模型 ${this.model ?? ''} 或对话接口（HTTP 404）`;
      throw error;
    }
  }

  chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage> {
    return this.remember(
      (async () => {
        const model = this.create(signal, SAMPLING.understand);
        const runnable = tools.length > 0 ? model.bindTools([...tools]) : model;
        const reply = await runnable.invoke([...messages], { signal });
        return new AIMessage({ content: reply.content, tool_calls: reply.tool_calls ?? [] });
      })(),
    );
  }

  structured(messages: readonly BaseMessage[], schema: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    return this.remember(
      (async () => {
        const model = this.create(signal, SAMPLING.brief);
        const reply = await model.invoke([...messages], {
          signal,
          response_format: { type: 'json_schema', json_schema: { name: 'level_brief', schema, strict: false } },
        });
        return textOf(reply);
      })(),
    );
  }

  async availability(signal: AbortSignal): Promise<Availability> {
    const { baseUrl, model, apiKey } = this.config;
    const missing = [baseUrl ? null : 'MW_OPENAI_BASE_URL', model ? null : 'MW_OPENAI_MODEL', apiKey ? null : 'MW_OPENAI_API_KEY'].filter((m): m is string => m !== null);
    if (missing.length > 0 || !baseUrl || !model || !apiKey) return { available: false, reason: `OpenAI 兼容接口的配置不全：缺少 ${missing.join('、')}` };
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
    } catch {
      return { available: false, reason: '连不上 OpenAI 兼容接口' };
    }
    if (res.status === 401 || res.status === 403) return { available: false, reason: `OpenAI 兼容接口拒绝了密钥（HTTP ${String(res.status)}）` };
    if (res.status === 404) {
      // 不支持列出模型：按最近一次调用的结果
      return this.lastFailure ? { available: false, reason: this.lastFailure } : { available: true, reason: null };
    }
    if (!res.ok) return { available: false, reason: `OpenAI 兼容接口返回错误（HTTP ${String(res.status)}）` };
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const ids = Array.isArray(body?.data) ? body.data.map((m: unknown) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : null)).filter((id): id is string => typeof id === 'string') : null;
    if (ids && !ids.includes(model)) return { available: false, reason: `OpenAI 兼容接口里没有模型 ${model}` };
    return { available: true, reason: null };
  }
}

// ---------------------------------------------------------------- off

export class OffProvider implements LlmProvider {
  readonly name = 'off' as const;
  readonly model = null;

  chat(): Promise<AIMessage> {
    return Promise.reject(new Error('工坊没有启用模型'));
  }

  structured(): Promise<string> {
    return Promise.reject(new Error('工坊没有启用模型'));
  }

  availability(): Promise<Availability> {
    return Promise.resolve({ available: false, reason: '工坊没有启用模型（MW_LLM_PROVIDER=off）' });
  }
}

/** 按配置建提供方（fake 由调用方另外建，见 fakeProvider.ts）。 */
export function createProvider(config: WorkshopConfig, fetchImpl: typeof fetch = fetch): LlmProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider(config.ollama, fetchImpl);
    case 'openai':
      return new OpenAiCompatibleProvider(config.openai, fetchImpl);
    case 'off':
    case 'fake':
      return new OffProvider();
  }
}

export { modelNameOf };
