// 假模型（P8，测试用）：按固定顺序返回预设的回复，并记下调用次数。
// - understand：“理解请求”这一步的回复（一段文字，或者一次工具调用）；
// - briefs：“写说明书”这一步的回复（一个 JSON 值、一段原样的文字（可以是坏 JSON）、一直不返回直到被中止、或抛错）。
// 预设的回复用完以后：理解请求返回一句固定的话，写说明书返回一份由请求文字决定的合法说明书（端到端测试的假模型模式用它）。
// delayMs：每次调用前等待（可以被中止），用来测取消。
// F2：prepare（加载模型）默认直接完成；可以设延迟、出错、一直不返回直到被中止。availabilityDelayMs：检查可用性前等待。

import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Brief } from '../src/game/level/gen/brief';
import { hash64 } from '../src/game/level/gen/random';
import { randomBrief } from '../src/game/level/gen/randomBrief';
import { PrepareError, type PrepareFailureKind } from './errors';
import type { Availability, LlmProvider } from './providers';

export type FakeUnderstandReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name?: string; readonly args?: Record<string, unknown> }
  | { readonly kind: 'hang' }
  | { readonly kind: 'error'; readonly message: string };

export type FakeBriefReply =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'raw'; readonly text: string }
  | { readonly kind: 'hang' }
  | { readonly kind: 'error'; readonly message: string };

/** 假的加载模型（F2）。 */
export interface FakePrepare {
  /** 完成（或出错）前等多久（可以被中止）。 */
  readonly delayMs?: number;
  /** 出错：抛这一类的 PrepareError。 */
  readonly fail?: PrepareFailureKind;
  /** 一直不返回，直到被中止。 */
  readonly hang?: boolean;
}

export interface FakeScript {
  readonly understand?: readonly FakeUnderstandReply[];
  readonly briefs?: readonly FakeBriefReply[];
  readonly delayMs?: number;
  readonly prepare?: FakePrepare;
  /** 检查可用性前等多久（可以被中止；被中止时报不可用，和真的提供方一样）。 */
  readonly availabilityDelayMs?: number;
}

const FAKE_PREPARE_FAILURES: Readonly<Record<PrepareFailureKind, string>> = {
  network: '加载模型失败：连不上模型服务',
  http: '加载模型失败：模型服务返回错误（HTTP 500）',
  response: '加载模型失败：模型服务返回的内容不对',
};

/** 一份合法的说明书（由请求文字决定，不含出场人物）。 */
export function defaultBrief(text: string): Brief {
  return randomBrief(`fake:${hash64(text)}`, []);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

function textOf(messages: readonly BaseMessage[]): string {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  readonly model = 'fake-scripted';
  /** 调用次数：理解请求（chat）和写说明书（structured）。 */
  readonly calls = { chat: 0, structured: 0 };
  /** 每次结构化输出调用收到的 schema（测试核对用）。 */
  readonly schemas: Record<string, unknown>[] = [];
  /** 每次调用收到的消息（测试核对用）。 */
  readonly prompts: string[] = [];
  /** prepare（加载模型）的调用次数。 */
  prepareCalls = 0;
  /** 调用的先后（prepare、chat、structured），测试核对 prepare 在第一次模型调用之前。 */
  readonly sequence: ('prepare' | 'chat' | 'structured')[] = [];
  private understandIndex = 0;
  private briefIndex = 0;

  constructor(private readonly script: FakeScript = {}) {}

  async chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage> {
    this.calls.chat++;
    this.sequence.push('chat');
    this.prompts.push(textOf(messages));
    await wait(this.script.delayMs ?? 0, signal);
    const reply = this.script.understand?.[this.understandIndex];
    this.understandIndex++;
    if (!reply) return new AIMessage('按玩家的一句话做一关：地图大小、宝石和守卫都按描述来。');
    switch (reply.kind) {
      case 'text':
        return new AIMessage(reply.text);
      case 'tool': {
        const name = reply.name ?? tools[0]?.name ?? 'lookup_roster';
        return new AIMessage({ content: '', tool_calls: [{ id: `call-${String(this.calls.chat)}`, name, args: reply.args ?? {} }] });
      }
      case 'hang':
        await wait(24 * 3600 * 1000, signal);
        throw new Error('unreachable');
      case 'error':
        throw new Error(reply.message);
    }
  }

  async structured(messages: readonly BaseMessage[], schema: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    this.calls.structured++;
    this.sequence.push('structured');
    this.schemas.push(schema);
    const prompt = textOf(messages);
    this.prompts.push(prompt);
    await wait(this.script.delayMs ?? 0, signal);
    const reply = this.script.briefs?.[this.briefIndex];
    this.briefIndex++;
    if (!reply) {
      const request = /玩家的一句话：(.*)/.exec(prompt)?.[1] ?? prompt;
      return JSON.stringify(defaultBrief(request));
    }
    switch (reply.kind) {
      case 'json':
        return JSON.stringify(reply.value);
      case 'raw':
        return reply.text;
      case 'hang':
        await wait(24 * 3600 * 1000, signal);
        throw new Error('unreachable');
      case 'error':
        throw new Error(reply.message);
    }
  }

  async availability(signal?: AbortSignal): Promise<Availability> {
    const delay = this.script.availabilityDelayMs ?? 0;
    if (delay > 0) {
      try {
        await wait(delay, signal ?? new AbortController().signal);
      } catch {
        return { available: false, reason: '检查被中止' };
      }
    }
    return { available: true, reason: null };
  }

  async prepare(signal: AbortSignal): Promise<void> {
    this.prepareCalls++;
    this.sequence.push('prepare');
    const script = this.script.prepare ?? {};
    if (script.hang) await wait(24 * 3600 * 1000, signal);
    if ((script.delayMs ?? 0) > 0) await wait(script.delayMs ?? 0, signal);
    if (script.fail) throw new PrepareError(script.fail, FAKE_PREPARE_FAILURES[script.fail], script.fail === 'http' ? 500 : null);
  }
}
