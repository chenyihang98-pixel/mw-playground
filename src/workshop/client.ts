// 关卡工坊的浏览器端（P8）：调用本机服务的接口，响应都用 zod 校验。
// - 同一时间只发一个生成请求；每次生成用新的生成标识，只接受当前生成标识的响应，迟到的旧响应直接丢弃。
// - 取消：告诉服务取消（服务同时中止模型调用），并中止这次请求。
// - 确认：同一个生成标识只发一次确认（重复点返回同一个结果）。
// - 连不上服务、正式构建里没有服务、响应不合规：一律按“服务不可用”处理，游戏照常。

import { z } from 'zod';
import {
  ERROR_CODES,
  errorResponseSchema,
  finalizeResponseSchema,
  generateResponseSchema,
  healthResponseSchema,
  okResponseSchema,
  type FinalizeResponse,
  type GenerateResponse,
  type HealthResponse,
  type RosterPersonSnapshot,
} from './protocol';

export type HealthResult = { readonly kind: 'ok'; readonly health: HealthResponse } | { readonly kind: 'unreachable'; readonly reason: string };

export type GenerateResult =
  | { readonly kind: 'response'; readonly response: GenerateResponse }
  /** 这次生成已经不是当前的了（取消过、或者又开始了新的）：响应被丢弃。 */
  | { readonly kind: 'stale' }
  | { readonly kind: 'busy'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly message: string };

export type FinalizeResult =
  | { readonly kind: 'ok'; readonly response: FinalizeResponse }
  | { readonly kind: 'expired'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export const SERVICE_UNREACHABLE = '连不上工坊服务（用 npm run dev:workshop 同时启动游戏和工坊服务）';

type ErrorBody = z.output<typeof errorResponseSchema>;

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export class WorkshopClient {
  private current: { readonly id: string; readonly controller: AbortController } | null = null;
  private readonly confirms = new Map<string, Promise<FinalizeResult>>();

  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly base = '/api/workshop',
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** 这次生成还是不是当前的（异步返回之后可能已经被取消或换成新的）。 */
  private isCurrent(id: string): boolean {
    return this.current?.id === id;
  }

  /** 当前在进行的生成标识。 */
  get running(): string | null {
    return this.current?.id ?? null;
  }

  async health(): Promise<HealthResult> {
    try {
      const res = await this.fetchImpl(`${this.base}/health`, { signal: AbortSignal.timeout(5000) });
      const parsed = healthResponseSchema.safeParse(await readJson(res));
      return parsed.success ? { kind: 'ok', health: parsed.data } : { kind: 'unreachable', reason: SERVICE_UNREACHABLE };
    } catch {
      return { kind: 'unreachable', reason: SERVICE_UNREACHABLE };
    }
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return { status: res.status, body: await readJson(res) };
  }

  private errorOf(body: unknown): ErrorBody['error'] | null {
    const parsed = errorResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.error : null;
  }

  /** 开始生成（同一时间只发一个）。onStart 在发出请求前拿到生成标识。 */
  async generate(text: string, roster: readonly RosterPersonSnapshot[], onStart?: (generationId: string) => void): Promise<GenerateResult> {
    if (this.current) return { kind: 'busy', message: '上一个生成还没结束' };
    const id = this.newId();
    const controller = new AbortController();
    this.current = { id, controller };
    onStart?.(id);
    try {
      const { status, body } = await this.post('generate', { generationId: id, text, roster }, controller.signal);
      if (!this.isCurrent(id)) return { kind: 'stale' };
      if (status === 200) {
        const parsed = generateResponseSchema.safeParse(body);
        if (!parsed.success) return { kind: 'unavailable', reason: SERVICE_UNREACHABLE };
        if (parsed.data.generationId !== id) return { kind: 'stale' };
        return { kind: 'response', response: parsed.data };
      }
      const error = this.errorOf(body);
      if (!error) return { kind: 'unavailable', reason: SERVICE_UNREACHABLE };
      if (error.code === ERROR_CODES.busy) return { kind: 'busy', message: error.message };
      if (error.code === ERROR_CODES.unavailable) return { kind: 'unavailable', reason: error.message };
      return { kind: 'failed', message: error.message };
    } catch {
      if (!this.isCurrent(id)) return { kind: 'stale' };
      return { kind: 'unavailable', reason: SERVICE_UNREACHABLE };
    } finally {
      if (this.isCurrent(id)) this.current = null;
    }
  }

  /** 取消当前的生成：告诉服务取消，并中止这次请求。之后到达的响应会被丢弃。 */
  cancel(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    void this.post('cancel', { generationId: current.id })
      .catch(() => undefined)
      .finally(() => {
        current.controller.abort();
      });
  }

  /** 确认预览。同一个生成标识只发一次，重复调用返回同一个结果。 */
  confirm(generationId: string, version: number, serviceId: string): Promise<FinalizeResult> {
    const existing = this.confirms.get(generationId);
    if (existing) return existing;
    const promise = (async (): Promise<FinalizeResult> => {
      try {
        const { status, body } = await this.post('confirm', { generationId, version, serviceId });
        if (status === 200) {
          const parsed = finalizeResponseSchema.safeParse(body);
          if (parsed.success && parsed.data.generationId === generationId) return { kind: 'ok', response: parsed.data };
          return { kind: 'failed', message: '工坊服务的响应不合规' };
        }
        const error = this.errorOf(body);
        if (error?.code === ERROR_CODES.expired) return { kind: 'expired', message: error.message };
        return { kind: 'failed', message: error?.message ?? SERVICE_UNREACHABLE };
      } catch {
        return { kind: 'failed', message: SERVICE_UNREACHABLE };
      }
    })();
    this.confirms.set(generationId, promise);
    // 失败时允许再试一次
    void promise.then((r) => {
      if (r.kind === 'failed') this.confirms.delete(generationId);
    });
    return promise;
  }

  /** 放弃预览（服务不可用时也照常在界面上放弃）。 */
  async discard(generationId: string): Promise<void> {
    try {
      const { body } = await this.post('discard', { generationId });
      okResponseSchema.safeParse(body);
    } catch {
      // 服务不在也没关系
    }
  }
}
