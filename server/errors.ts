// 工坊服务的错误和脱敏（P8）。
// - WorkshopError：带错误码和 HTTP 状态的错误，消息是给浏览器看的、已经确认不含密钥的固定说法。
// - describeCallError：把模型调用的异常归成几类（取消、超时、HTTP 错误、连不上、其他），只给出安全的说明，
//   不把提供方返回的原文交给浏览器。
// - Redactor：日志和统计里的任何文字都先经过它，把密钥替换掉。

import { ERROR_CODES, type ErrorCode } from '../src/workshop/protocol';

const STATUS: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODES.busy]: 409,
  [ERROR_CODES.badRequest]: 400,
  [ERROR_CODES.tooLarge]: 413,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.expired]: 410,
  [ERROR_CODES.stale]: 409,
  [ERROR_CODES.unavailable]: 503,
  [ERROR_CODES.internal]: 500,
};

export class WorkshopError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkshopError';
    this.status = STATUS[code];
  }
}

/** 取消的原因（AbortController.abort 的参数），用来区分“用户取消”和“超时”。 */
export class CancelledByUser extends Error {
  constructor() {
    super('用户取消');
    this.name = 'CancelledByUser';
  }
}

export class CallTimeout extends Error {
  constructor(readonly what: string, readonly ms: number) {
    super(`${what}超时（${String(Math.round(ms / 1000))} 秒）`);
    this.name = 'CallTimeout';
  }
}

export type CallErrorKind = 'cancelled' | 'timeout' | 'http' | 'network' | 'other';

export interface CallErrorInfo {
  readonly kind: CallErrorKind;
  /** 安全的说明（不含提供方返回的原文和密钥）。 */
  readonly message: string;
}

function chain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current !== undefined && current !== null; i++) {
    out.push(current);
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/** 把模型调用的异常归类。signalReason 是这次调用的 AbortSignal 的原因（取消或超时）。 */
export function describeCallError(error: unknown, signalReason?: unknown): CallErrorInfo {
  const reasons = [signalReason, ...chain(error)];
  for (const r of reasons) {
    if (r instanceof CancelledByUser) return { kind: 'cancelled', message: '已取消' };
    if (r instanceof CallTimeout) return { kind: 'timeout', message: r.message };
  }
  for (const r of chain(error)) {
    if (typeof r !== 'object' || r === null) continue;
    // openai 的错误带 status，ollama 的 ResponseError 带 status_code
    const status = (r as { status?: unknown }).status ?? (r as { status_code?: unknown }).status_code;
    if (typeof status === 'number' && status >= 400) return { kind: 'http', message: `模型服务返回错误（HTTP ${String(status)}）` };
    const name = (r as { name?: unknown }).name;
    const code = (r as { code?: unknown }).code;
    if (name === 'TimeoutError') return { kind: 'timeout', message: '模型调用超时' };
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { kind: 'network', message: '连不上模型服务' };
    }
    const message = (r as { message?: unknown }).message;
    if (typeof message === 'string' && /fetch failed|ECONNREFUSED|connect/i.test(message)) return { kind: 'network', message: '连不上模型服务' };
    const statusInMessage = typeof message === 'string' ? /\b([45]\d\d)\b/.exec(message) : null;
    if (statusInMessage) return { kind: 'http', message: `模型服务返回错误（HTTP ${statusInMessage[1] ?? ''}）` };
  }
  return { kind: 'other', message: '模型调用出错' };
}

/** 脱敏：把密钥（以及它的常见变形）从文字里去掉。 */
export class Redactor {
  private readonly secrets: readonly string[];

  constructor(secrets: readonly (string | null | undefined)[]) {
    this.secrets = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) {
      out = out.split(s).join('[已隐藏]');
      out = out.split(encodeURIComponent(s)).join('[已隐藏]');
    }
    return out;
  }
}
