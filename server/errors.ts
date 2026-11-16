// 工坊服务的错误和脱敏（P8）。
// - WorkshopError：带错误码和 HTTP 状态的错误，消息是给浏览器看的、已经确认不含密钥的固定说法。
// - describeCallError：把模型调用的异常归成几类（取消、超时、HTTP 错误、连不上、其他），只给出安全的说明，
//   不把提供方返回的原文交给浏览器。
// - Redactor：日志和统计里的任何文字都先经过它，把密钥替换掉。
// - F7：给玩家看的说明（超时、模型调用出错、加载失败）按请求的语言写：这些错误带 say(tr)，按指定的语言说；
//   message 一直是中文（日志、统计、错误响应用它）。

import { translator, type Translate } from '../src/i18n';
import { ERROR_CODES, type ErrorCode } from '../src/workshop/protocol';

/** 一句可以按语言说出来的话。 */
export type Say = (tr: Translate) => string;

/** 中文：发给模型的内容、日志和统计都用它（不靠全局的当前语言）。 */
export const ZH: Translate = translator('zh');

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

function timeoutText(tr: Translate, what: Say, ms: number): string {
  return tr('callError.timeout', { what: what(tr), seconds: String(Math.round(ms / 1000)) });
}

export class CallTimeout extends Error {
  constructor(
    private readonly what: Say,
    readonly ms: number,
  ) {
    super(timeoutText(ZH, what, ms));
    this.name = 'CallTimeout';
  }

  say(tr: Translate): string {
    return timeoutText(tr, this.what, this.ms);
  }
}

/** 加载模型失败的类别（F2）：连不上、HTTP 状态码不对、返回的内容不对。 */
export type PrepareFailureKind = 'network' | 'http' | 'response';

/** 加载模型失败（F2）。消息是固定的说法，不含请求体和提供方返回的原文。 */
export class PrepareError extends Error {
  constructor(
    readonly kind: PrepareFailureKind,
    private readonly text: Say,
    /** HTTP 状态码（kind 为 http 时）。 */
    readonly status: number | null = null,
  ) {
    super(text(ZH));
    this.name = 'PrepareError';
  }

  say(tr: Translate): string {
    return this.text(tr);
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

/** 把模型调用的异常归类。signalReason 是这次调用的 AbortSignal 的原因（取消或超时）。tr：说明用的语言（默认中文）。 */
export function describeCallError(error: unknown, signalReason?: unknown, tr: Translate = ZH): CallErrorInfo {
  const reasons = [signalReason, ...chain(error)];
  for (const r of reasons) {
    if (r instanceof CancelledByUser) return { kind: 'cancelled', message: tr('callError.cancelled') };
    if (r instanceof CallTimeout) return { kind: 'timeout', message: r.say(tr) };
  }
  for (const r of chain(error)) {
    if (typeof r !== 'object' || r === null) continue;
    // openai 的错误带 status，ollama 的 ResponseError 带 status_code
    const status = (r as { status?: unknown }).status ?? (r as { status_code?: unknown }).status_code;
    if (typeof status === 'number' && status >= 400) return { kind: 'http', message: tr('callError.http', { status: String(status) }) };
    const name = (r as { name?: unknown }).name;
    const code = (r as { code?: unknown }).code;
    if (name === 'TimeoutError') return { kind: 'timeout', message: tr('callError.timedOut') };
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { kind: 'network', message: tr('callError.network') };
    }
    const message = (r as { message?: unknown }).message;
    if (typeof message === 'string' && /fetch failed|ECONNREFUSED|connect/i.test(message)) return { kind: 'network', message: tr('callError.network') };
    const statusInMessage = typeof message === 'string' ? /\b([45]\d\d)\b/.exec(message) : null;
    if (statusInMessage) return { kind: 'http', message: tr('callError.http', { status: statusInMessage[1] ?? '' }) };
  }
  return { kind: 'other', message: tr('callError.other') };
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
