// 假模型（P8，测试用）：按固定顺序返回预设的回复，并记下调用次数。
// - understand：“理解请求”这一步的回复（一段文字，或者一次工具调用）；
// - briefs：“写说明书”这一步的回复（一个 JSON 值、一段原样的文字（可以是坏 JSON）、一直不返回直到被中止、或抛错）。
// 预设的回复用完以后：理解请求返回一句固定的话，写说明书返回一份由请求文字决定的合法说明书（端到端测试的假模型模式用它）。
// delayMs：每次调用前等待（可以被中止），用来测取消。

import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Brief } from '../src/game/level/gen/brief';
import { hash64 } from '../src/game/level/gen/random';
import { randomBrief } from '../src/game/level/gen/randomBrief';
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

export interface FakeScript {
  readonly understand?: readonly FakeUnderstandReply[];
  readonly briefs?: readonly FakeBriefReply[];
  readonly delayMs?: number;
}

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
  private understandIndex = 0;
  private briefIndex = 0;

  constructor(private readonly script: FakeScript = {}) {}

  async chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage> {
    this.calls.chat++;
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

  availability(): Promise<Availability> {
    return Promise.resolve({ available: true, reason: null });
  }
}
