// 关卡工坊的请求管理（P8）：同一时间最多处理一个生成；取消、超时；预览会话；按生成标识只定稿一次；每个请求只记一条统计。
//
// - 生成：跑 LangGraph 流程到预览（interrupt）、回退或出错为止。生成和检查都在预览之前完成。
// - 取消：中止这次生成（模型调用一起中止）。取消不算失败，不回退。
// - 超时：单次模型调用和整个请求都有超时。超时算服务错误，回退到内置关卡。
// - 确认：从预览节点恢复，进入保存节点，返回当前预览的那一份关卡（不重新抽种子，不再调用模型）。
//   同一个生成标识只定稿一次：重复确认返回同一份结果。关卡由浏览器保存，服务端不存。
// - 检查点只用内存里的（MemorySaver）：服务重启后，未确认的预览失效。

import { randomBytes, randomUUID } from 'node:crypto';
import { Command, MemorySaver } from '@langchain/langgraph';
import { fallbackPackage } from '../src/game/levels/catalog';
import { FALLBACK_LEVEL_ID } from '../src/game/level/generatedLevels';
import { fallbackDifferences } from '../src/workshop/diff';
import {
  ERROR_CODES,
  type ConfirmRequest,
  type Fallback,
  type FinalizeResponse,
  type GenerateRequest,
  type GenerateResponse,
  type HealthResponse,
  type Outcome,
  type Preview,
} from '../src/workshop/protocol';
import type { WorkshopConfig } from './config';
import { CallTimeout, CancelledByUser, WorkshopError } from './errors';
import { MAX_BRIEF_ATTEMPTS, ModelCallError, buildWorkshopGraph, historyLine, type GraphDeps, type WorkshopGraph, type WorkshopStateType } from './graph';
import type { Logger } from './log';
import type { LlmProvider } from './providers';
import { rosterEntries } from './roster';
import type { StatsSink } from './stats';

export interface WorkshopDeps {
  readonly config: WorkshopConfig;
  readonly provider: LlmProvider;
  readonly stats: StatsSink;
  readonly log: Logger;
  /** 单调时钟（毫秒）。 */
  readonly now?: () => number;
  /** 根种子（默认是密码学随机数）。 */
  readonly newSeed?: () => string;
  readonly serviceId?: string;
  /** P5 的流水线（测试可以替换）。 */
  readonly produce?: GraphDeps['produce'];
}

interface Session {
  readonly id: string;
  readonly version: number;
  readonly preview: Preview;
  finalized: Promise<FinalizeResponse> | null;
}

/** 同时保留的预览会话最多几个（更早的作废）。 */
const MAX_SESSIONS = 16;

export class Workshop {
  readonly serviceId: string;
  private readonly checkpointer = new MemorySaver();
  private readonly graph: WorkshopGraph;
  private readonly now: () => number;
  private readonly newSeed: () => string;
  private running: { readonly id: string; readonly controller: AbortController } | null = null;
  private readonly sessions = new Map<string, Session>();
  /** 已经用过的生成标识（每个请求只处理、只统计一次）。 */
  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, number>();
  private version = 0;

  constructor(private readonly deps: WorkshopDeps) {
    this.serviceId = deps.serviceId ?? randomUUID();
    this.now = deps.now ?? (() => performance.now());
    this.newSeed = deps.newSeed ?? (() => randomBytes(8).toString('hex'));
    this.graph = buildWorkshopGraph(
      {
        provider: deps.provider,
        callTimeoutMs: deps.config.limits.callTimeoutMs,
        now: this.now,
        onModelCall: (id) => {
          this.calls.set(id, (this.calls.get(id) ?? 0) + 1);
        },
        onDefect: (id, problems) => {
          deps.log.error('程序缺陷：检查器拒绝了生成器做出的布局', { generationId: id, problems });
        },
        produce: deps.produce,
      },
      this.checkpointer,
    );
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async health(): Promise<HealthResponse> {
    const availability = await this.deps.provider.availability(AbortSignal.timeout(3000));
    return {
      ok: true,
      serviceId: this.serviceId,
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
      available: availability.available,
      reason: availability.reason,
      maxRequestChars: this.deps.config.limits.maxRequestChars,
      busy: this.busy,
    };
  }

  /** 生成到预览、回退或取消为止。 */
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { config, provider, log } = this.deps;
    if (this.running) throw new WorkshopError(ERROR_CODES.busy, '工坊正在生成另一关，请稍后再试');
    if (request.text.length > config.limits.maxRequestChars) {
      throw new WorkshopError(ERROR_CODES.badRequest, `一句话最多 ${String(config.limits.maxRequestChars)} 个字`);
    }
    if (this.seen.has(request.generationId)) throw new WorkshopError(ERROR_CODES.badRequest, '这个生成标识已经用过了');
    const controller = new AbortController();
    this.running = { id: request.generationId, controller };
    this.seen.add(request.generationId);
    const id = request.generationId;
    const start = this.now();
    const thread = { configurable: { thread_id: id } };
    const timer = setTimeout(() => {
      controller.abort(new CallTimeout('整个生成请求', config.limits.requestTimeoutMs));
    }, config.limits.requestTimeoutMs);
    try {
      const availability = await provider.availability(AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
      if (!availability.available) {
        // 模型不可用不算一个生成请求（不统计）：浏览器按原因提示，并提供“随机一关”
        this.seen.delete(id);
        throw new WorkshopError(ERROR_CODES.unavailable, availability.reason ?? '模型不可用');
      }
      log.info('开始生成', { generationId: id, textChars: request.text.length, rosterSize: request.roster.length });
      let failure: unknown = null;
      try {
        await this.graph.invoke(
          { text: request.text, roster: rosterEntries(request.roster), seed: this.newSeed() },
          { ...thread, signal: controller.signal, recursionLimit: 40 },
        );
      } catch (error) {
        failure = error;
      }
      const snapshot = await this.graph.getState(thread);
      const state = snapshot.values as WorkshopStateType;
      const total = this.now() - start;
      if (failure !== null) return await this.finishFailure(request, state, failure, controller.signal.reason, total);
      const interrupts = snapshot.tasks.flatMap((t) => t.interrupts);
      const preview = interrupts[0]?.value as Preview | undefined;
      if (preview) {
        const version = ++this.version;
        this.remember({ id, version, preview, finalized: null });
        await this.record(request, state, preview.outcome, null, total);
        log.info('出预览', { generationId: id, outcome: preview.outcome, repairs: preview.repairs });
        return { ok: true, status: 'preview', generationId: id, version, serviceId: this.serviceId, preview };
      }
      const terminal = state.terminal ?? { outcome: 'error' as const, reason: '流程没有给出结果' };
      await this.dropThread(id);
      return await this.fallback(request, state, terminal.outcome, terminal.reason, total);
    } finally {
      clearTimeout(timer);
      this.running = null;
      this.calls.delete(id);
    }
  }

  private async finishFailure(request: GenerateRequest, state: WorkshopStateType, error: unknown, signalReason: unknown, total: number): Promise<GenerateResponse> {
    const id = request.generationId;
    await this.dropThread(id);
    if (signalReason instanceof CancelledByUser || (error instanceof ModelCallError && error.info.kind === 'cancelled')) {
      // 取消不算失败，也不回退
      await this.record(request, state, 'cancelled', '用户取消', total);
      this.deps.log.info('已取消', { generationId: id });
      return { ok: true, status: 'cancelled', generationId: id, serviceId: this.serviceId };
    }
    let reason: string;
    if (signalReason instanceof CallTimeout) reason = signalReason.message;
    else if (error instanceof ModelCallError) reason = error.message;
    else reason = '工坊服务内部错误';
    this.deps.log.warn('生成出错，回退到内置关卡', { generationId: id, reason, error: error instanceof ModelCallError ? error.info.kind : error instanceof Error ? error.name : 'unknown' });
    return this.fallback(request, state, 'error', reason, total);
  }

  /** 回退到内置关卡（P5 的第 1 关），说明来源、原因和与请求的主要差别。 */
  private async fallback(request: GenerateRequest, state: WorkshopStateType, outcome: 'fallback' | 'error', reason: string, total: number): Promise<GenerateResponse> {
    const pkg = fallbackPackage();
    if (!pkg.brief) throw new Error('回退关卡没有说明书');
    const fallback: Fallback = {
      outcome,
      reason,
      history: state.history.map(historyLine),
      differences: fallbackDifferences(state.lastValidBrief, pkg.brief, pkg.title),
      fallbackId: FALLBACK_LEVEL_ID,
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
    };
    await this.record(request, state, outcome, reason, total);
    return { ok: true, status: 'fallback', generationId: request.generationId, serviceId: this.serviceId, fallback };
  }

  /** 每个请求只记一条。 */
  private async record(request: GenerateRequest, state: WorkshopStateType, outcome: Outcome, reason: string | null, total: number): Promise<void> {
    const attempts = Math.min(state.attempt, MAX_BRIEF_ATTEMPTS);
    try {
      await this.deps.stats.record({
        id: request.generationId,
        at: new Date().toISOString(),
        outcome,
        reason,
        provider: this.deps.provider.name,
        model: this.deps.provider.model,
        repairs: Math.max(0, attempts - 1),
        briefAttempts: attempts,
        modelCalls: this.calls.get(request.generationId) ?? 0,
        timingsMs: { ...roundTimings(state.timings), total: Math.round(total) },
        textChars: request.text.length,
        rosterSize: request.roster.length,
      });
    } catch {
      this.deps.log.warn('统计没有写进去', { generationId: request.generationId });
    }
  }

  /** 取消正在进行的生成（同时中止模型调用）。返回有没有取消到。 */
  cancel(generationId: string): boolean {
    if (this.running?.id !== generationId) return false;
    this.running.controller.abort(new CancelledByUser());
    return true;
  }

  /** 确认预览：定稿并返回当前预览的那一份关卡。同一个生成标识只定稿一次。 */
  async confirm(request: ConfirmRequest): Promise<FinalizeResponse> {
    const session = this.sessionFor(request.generationId, request.serviceId);
    if (session.version !== request.version) throw new WorkshopError(ERROR_CODES.stale, '预览的版本对不上：请用最新的预览');
    if (session.finalized) return { ...(await session.finalized), duplicate: true };
    session.finalized = this.finalize(session);
    try {
      return await session.finalized;
    } catch (error) {
      session.finalized = null;
      throw error;
    }
  }

  private async finalize(session: Session): Promise<FinalizeResponse> {
    const thread = { configurable: { thread_id: session.id } };
    // 从预览节点恢复（interrupt 返回 confirm），进入保存节点；之前的节点不会重新执行
    await this.graph.invoke(new Command({ resume: { action: 'confirm' } }), { ...thread, recursionLimit: 10 });
    const state = (await this.graph.getState(thread)).values as WorkshopStateType;
    const level = state.final;
    if (level?.layoutHash !== session.preview.level.layoutHash) throw new WorkshopError(ERROR_CODES.internal, '定稿和预览不一致');
    await this.dropThread(session.id);
    this.deps.log.info('已定稿', { generationId: session.id, layoutHash: level.layoutHash });
    return { ok: true, generationId: session.id, duplicate: false, level, provider: session.preview.provider, model: session.preview.model };
  }

  /** 放弃预览。 */
  async discard(generationId: string): Promise<void> {
    const session = this.sessions.get(generationId);
    if (!session) return;
    this.sessions.delete(generationId);
    if (session.finalized) return;
    try {
      await this.graph.invoke(new Command({ resume: { action: 'discard' } }), { configurable: { thread_id: generationId }, recursionLimit: 10 });
    } finally {
      await this.dropThread(generationId);
    }
  }

  private sessionFor(generationId: string, serviceId: string): Session {
    if (serviceId !== this.serviceId) throw new WorkshopError(ERROR_CODES.expired, '工坊服务重启过，未确认的预览已失效');
    const session = this.sessions.get(generationId);
    if (!session) throw new WorkshopError(ERROR_CODES.expired, '这次预览已经失效（放弃过，或者过了太久）');
    return session;
  }

  private remember(session: Session): void {
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      void this.dropThread(oldest);
    }
  }

  private async dropThread(id: string): Promise<void> {
    try {
      await this.checkpointer.deleteThread(id);
    } catch {
      // 删不掉检查点只是多占一点内存
    }
  }
}

function roundTimings(timings: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)]));
}
