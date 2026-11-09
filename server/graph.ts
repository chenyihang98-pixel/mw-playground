// 关卡工坊的 LangGraph 流程（P8）。节点依次是：
//   1. understand    理解请求（可以调用“查名册快照”工具，工具只读这次请求带来的快照）
//   2. writeBrief    写说明书（结构化输出：把说明书的 JSON Schema 交给模型）
//   3. validate      校验 schema 和组合规则（P5 的 parseBrief，加上快照里允许的分工）
//   4. produce       生成布局并做硬检查：直接调用 P5 的流水线 produceLevel（含有限次尝试和一次程序调整）
//   5. handleFailure 失败时按类别处理（类别沿用 P5 流水线的结果分类）：
//      - 说明书错误（JSON 坏了、schema 不合规、组合冲突、不存在的人物、不允许的分工）：把具体原因交回模型；
//      - 放不下或太远（P5 已经尝试过并做过一次程序调整）：把能照着改的原因交回模型；
//      - 程序缺陷（检查器拒绝了生成器做出的布局）：记录为错误，不交给模型，结束。
//      模型写说明书一共最多 3 次（首次 1 次 + 修复 2 次），用完还不行就结束，由调用方回退到内置关卡。
//   6. preview       预览：interrupt 把预览交给浏览器，等确认或放弃。生成和检查都在这之前完成；
//                    这个节点在 interrupt 之前只做纯计算（恢复时会从节点开头重新执行）。
//   7. save          定稿：返回当前预览的那一份关卡（不重新抽种子，不调用模型）。关卡由浏览器保存，服务端不存。

import { HumanMessage, SystemMessage, ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { parseBrief, type Brief } from '../src/game/level/gen/brief';
import { produceLevel } from '../src/game/level/gen/pipeline';
import { deriveSeed } from '../src/game/level/gen/random';
import { packageOfProduced, type LevelPackage } from '../src/game/levels/package';
import { briefDifferences } from '../src/workshop/diff';
import type { Preview, WireLevel } from '../src/workshop/protocol';
import { CallTimeout, describeCallError, type CallErrorInfo } from './errors';
import { briefJsonSchema, briefSystemPrompt, briefUserPrompt, understandSystemPrompt } from './prompts';
import type { LlmProvider } from './providers';
import { aliasText, describeRoster, resolveAliases, roleProblems, type RosterEntry } from './roster';

/** 模型写说明书的次数上限：首次 1 次 + 修复 2 次。 */
export const MAX_BRIEF_ATTEMPTS = 3;
/** “理解请求”这一步最多执行几轮工具调用。 */
export const MAX_TOOL_ROUNDS = 1;

export type FailureCategory = 'json' | 'brief' | 'cannot-fit' | 'too-far' | 'rejected';

export const FAILURE_LABELS: Readonly<Record<FailureCategory, string>> = {
  json: '输出不是合法的 JSON',
  brief: '说明书错误',
  'cannot-fit': '放不下',
  'too-far': '太远',
  rejected: '程序缺陷',
};

export interface AttemptLog {
  readonly attempt: number;
  readonly category: FailureCategory;
  readonly problems: readonly string[];
}

export interface Terminal {
  readonly outcome: 'fallback' | 'error';
  readonly reason: string;
}

export type Decision = 'confirm' | 'discard';

/** 模型调用出错（已经归好类，消息里不含提供方的原文和密钥）。 */
export class ModelCallError extends Error {
  constructor(
    readonly info: CallErrorInfo,
    readonly step: string,
  ) {
    super(`${step}：${info.message}`);
    this.name = 'ModelCallError';
  }
}

const sumTimings = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

export const WorkshopState = Annotation.Root({
  text: Annotation<string>(),
  roster: Annotation<RosterEntry[]>(),
  /** 这次生成的根种子：每次布局尝试由它派生（确认时不重新抽）。 */
  seed: Annotation<string>(),
  understanding: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  /** 模型已经写了几次说明书。 */
  attempt: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** 模型最近一次的输出（原文，只用来解析和交回模型修改）。 */
  raw: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 最近一次通过校验的说明书（回退时用来说明和请求的差别）。 */
  brief: Annotation<Brief | null>({ reducer: (_a, b) => b, default: () => null }),
  lastValidBrief: Annotation<Brief | null>({ reducer: (_a, b) => b ?? _a, default: () => null }),
  failure: Annotation<{ category: FailureCategory; problems: string[] } | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 交回模型的原因（修复时用）。 */
  problems: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  history: Annotation<AttemptLog[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  level: Annotation<WireLevel | null>({ reducer: (_a, b) => b, default: () => null }),
  adjustment: Annotation<{ change: string; message: string } | null>({ reducer: (_a, b) => b, default: () => null }),
  differences: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  terminal: Annotation<Terminal | null>({ reducer: (_a, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_a, b) => b, default: () => null }),
  final: Annotation<WireLevel | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 各阶段耗时（毫秒，累加）。 */
  timings: Annotation<Record<string, number>>({ reducer: sumTimings, default: () => ({}) }),
});

export type WorkshopStateType = typeof WorkshopState.State;

export interface GraphDeps {
  readonly provider: LlmProvider;
  readonly callTimeoutMs: number;
  /** 单调时钟（毫秒）。 */
  readonly now: () => number;
  /** 每次调用模型前通知（统计用）。 */
  readonly onModelCall?: (threadId: string) => void;
  /** 程序缺陷等需要记下来的错误。 */
  readonly onDefect?: (threadId: string, problems: readonly string[]) => void;
  /** P5 的流水线（测试可以替换，用来模拟程序缺陷）。 */
  readonly produce?: typeof produceLevel;
}

/** 关卡包 → 接口里的关卡（来源记为 model）。 */
export function wireOf(pkg: LevelPackage): WireLevel {
  if (!pkg.brief || pkg.seed === null || pkg.schemaVersion === null || pkg.generatorVersion === null) throw new Error('不是由说明书生成的关卡');
  return {
    source: 'model',
    title: pkg.title,
    layout: pkg.layout,
    layoutHash: pkg.layoutHash,
    visual: pkg.visual,
    rules: { ...pkg.rules },
    brief: pkg.brief,
    seed: pkg.seed,
    schemaVersion: pkg.schemaVersion,
    generatorVersion: pkg.generatorVersion,
    adjustment: pkg.adjustment,
  };
}

/** 预览的内容：只由状态算出来（纯函数）。 */
export function previewOf(state: WorkshopStateType, provider: LlmProvider): Preview {
  const level = state.level;
  if (!level) throw new Error('没有可以预览的关卡');
  const repairs = Math.max(0, state.attempt - 1);
  return {
    level,
    outcome: state.adjustment ? 'program-adjusted' : repairs > 0 ? 'model-repaired' : 'model-first',
    repairs,
    adjustment: state.adjustment,
    differences: state.differences,
    history: state.history.map(historyLine),
    provider: provider.name,
    model: provider.model,
  };
}

export function historyLine(log: AttemptLog): string {
  return `第 ${String(log.attempt)} 次（${FAILURE_LABELS[log.category]}）：${log.problems.join('；')}`;
}

function textOf(message: AIMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  return content.map((part) => (typeof part === 'string' ? part : part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}

function threadOf(config: LangGraphRunnableConfig): string {
  const id = (config.configurable as { thread_id?: unknown } | undefined)?.thread_id;
  return typeof id === 'string' ? id : '';
}

/** 带超时调用一次模型：超时或取消时中止这次调用（fetch 绑定的 signal 一起中止）。 */
async function callModel<T>(deps: GraphDeps, config: LangGraphRunnableConfig, step: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const parent = config.signal;
  parent?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new CallTimeout(`${step}（单次模型调用）`, deps.callTimeoutMs));
  }, deps.callTimeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
  deps.onModelCall?.(threadOf(config));
  try {
    return await work(signal);
  } catch (error) {
    throw new ModelCallError(describeCallError(error, signal.reason), step);
  } finally {
    clearTimeout(timer);
  }
}

export function buildWorkshopGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const schema = briefJsonSchema();

  const understand = async (state: WorkshopStateType, config: LangGraphRunnableConfig) => {
    const start = deps.now();
    const roster = state.roster;
    // 工具只读这次请求带来的名册快照
    const lookupRoster = tool(() => describeRoster(roster), {
      name: 'lookup_roster',
      description: '查名册快照：返回这次可以出场的人物（代号、显示名、允许的分工）。',
      schema: z.object({ query: z.string().optional().describe('想找的人物（可以不填）') }),
    });
    const messages: BaseMessage[] = [new SystemMessage(understandSystemPrompt()), new HumanMessage(`玩家的一句话：${state.text}`)];
    let reply = await callModel(deps, config, '理解请求', (signal) => deps.provider.chat(messages, [lookupRoster], signal));
    for (let round = 0; round < MAX_TOOL_ROUNDS && (reply.tool_calls?.length ?? 0) > 0; round++) {
      const calls = reply.tool_calls ?? [];
      messages.push(reply);
      calls.forEach((call, i) => {
        // 只执行“查名册快照”这一个只读工具；模型要求的其他工具一律不执行
        const content = call.name === 'lookup_roster' ? describeRoster(roster) : `没有工具 ${call.name}，只能用 lookup_roster`;
        messages.push(new ToolMessage({ content, tool_call_id: call.id ?? `call-${String(i)}` }));
      });
      reply = await callModel(deps, config, '理解请求', (signal) => deps.provider.chat(messages, [lookupRoster], signal));
    }
    const understanding = textOf(reply).trim().slice(0, 800);
    return { understanding, timings: { understand: deps.now() - start } };
  };

  const writeBrief = async (state: WorkshopStateType, config: LangGraphRunnableConfig) => {
    const start = deps.now();
    const attempt = state.attempt + 1;
    const messages = [
      new SystemMessage(briefSystemPrompt()),
      new HumanMessage(
        briefUserPrompt({ text: state.text, understanding: state.understanding, roster: state.roster, previous: state.raw, problems: state.problems }),
      ),
    ];
    const raw = await callModel(deps, config, `写说明书（第 ${String(attempt)} 次）`, (signal) => deps.provider.structured(messages, schema, signal));
    return { attempt, raw, timings: { brief: deps.now() - start } };
  };

  const validate = (state: WorkshopStateType) => {
    const start = deps.now();
    const done = (update: Partial<WorkshopStateType>) => ({ ...update, timings: { validate: deps.now() - start } });
    let json: unknown;
    try {
      json = JSON.parse(state.raw ?? '');
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return done({ brief: null, failure: { category: 'json', problems: [`输出不是合法的 JSON（${why.slice(0, 120)}）：只输出说明书 JSON 本身`] } });
    }
    const resolved = resolveAliases(json, state.roster);
    const parsed = parseBrief(resolved, new Set(state.roster.map((p) => p.id)));
    const problems = parsed.ok ? roleProblems(parsed.brief, state.roster) : parsed.problems;
    if (!parsed.ok || problems.length > 0) {
      return done({ brief: null, failure: { category: 'brief', problems: problems.map((p) => aliasText(`${p.path}：${p.message}`, state.roster)) } });
    }
    return done({ brief: parsed.brief, lastValidBrief: parsed.brief, failure: null });
  };

  const produce = (state: WorkshopStateType, config: LangGraphRunnableConfig) => {
    const start = deps.now();
    const brief = state.brief;
    if (!brief) throw new Error('没有说明书');
    // 每次（模型写的）说明书用由根种子派生的种子：同一次生成里确定，确认时不重新抽
    const result = (deps.produce ?? produceLevel)(brief, deriveSeed(state.seed, `brief-${String(state.attempt)}`), { rosterIds: new Set(state.roster.map((p) => p.id)) });
    const timings = { produce: deps.now() - start };
    if (result.ok) {
      const pkg = packageOfProduced(result.level);
      const adjustment = result.level.adjustment;
      return {
        level: wireOf(pkg),
        adjustment: adjustment ? { change: adjustment.change, message: adjustment.message } : null,
        differences: adjustment ? briefDifferences(adjustment.from, adjustment.to) : [],
        failure: null,
        timings,
      };
    }
    switch (result.kind) {
      case 'brief':
        return { failure: { category: 'brief' as const, problems: result.problems.map((p) => aliasText(`${p.path}：${p.message}`, state.roster)) }, timings };
      case 'cannot-fit':
      case 'too-far': {
        const tried = result.adjustment ? `（程序已经试过 ${String(result.attempts)} 次布局，并调整过一次：${result.adjustment.change}）` : `（程序已经试过 ${String(result.attempts)} 次布局）`;
        return { failure: { category: result.kind, problems: [`${result.message}${tried}`] }, timings };
      }
      case 'rejected': {
        const problems = result.problems.map((p) => p.message);
        deps.onDefect?.(threadOf(config), problems);
        return { failure: { category: 'rejected' as const, problems }, timings };
      }
    }
  };

  const handleFailure = (state: WorkshopStateType) => {
    const failure = state.failure;
    if (!failure) throw new Error('没有失败原因');
    const log: AttemptLog = { attempt: state.attempt, category: failure.category, problems: failure.problems };
    if (failure.category === 'rejected') {
      // 程序缺陷：记录为错误，不交给模型
      return { history: [log], problems: [], terminal: { outcome: 'error' as const, reason: `程序缺陷：检查器拒绝了生成器做出的布局（${failure.problems.join('；')}）` } };
    }
    if (state.attempt >= MAX_BRIEF_ATTEMPTS) {
      return {
        history: [log],
        problems: [],
        terminal: { outcome: 'fallback' as const, reason: `模型写了 ${String(state.attempt)} 次说明书都没有得到可用的关卡；最后一次：${FAILURE_LABELS[failure.category]}（${failure.problems.join('；')}）` },
      };
    }
    // 把能照着改的原因交回模型
    return { history: [log], problems: failure.problems, terminal: null };
  };

  const preview = (state: WorkshopStateType) => {
    // 恢复时这个节点会从头重新执行：interrupt 之前只有纯计算，没有副作用
    const decision = interrupt<Preview, { action: Decision }>(previewOf(state, deps.provider));
    return { decision: decision.action };
  };

  const save = (state: WorkshopStateType) => ({ final: state.level });

  return new StateGraph(WorkshopState)
    .addNode('understand', understand)
    .addNode('writeBrief', writeBrief)
    .addNode('validate', validate)
    .addNode('produce', produce)
    .addNode('handleFailure', handleFailure)
    .addNode('preview', preview)
    .addNode('save', save)
    .addEdge(START, 'understand')
    .addEdge('understand', 'writeBrief')
    .addEdge('writeBrief', 'validate')
    .addConditionalEdges('validate', (s: WorkshopStateType) => (s.brief ? 'produce' : 'handleFailure'), ['produce', 'handleFailure'])
    .addConditionalEdges('produce', (s: WorkshopStateType) => (s.level ? 'preview' : 'handleFailure'), ['preview', 'handleFailure'])
    .addConditionalEdges('handleFailure', (s: WorkshopStateType) => (s.terminal ? END : 'writeBrief'), ['writeBrief', END])
    .addConditionalEdges('preview', (s: WorkshopStateType) => (s.decision === 'confirm' ? 'save' : END), ['save', END])
    .addEdge('save', END)
    .compile({ checkpointer });
}

export type WorkshopGraph = ReturnType<typeof buildWorkshopGraph>;
