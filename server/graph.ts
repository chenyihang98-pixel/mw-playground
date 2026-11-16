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
// F7：请求带语言（lang）。发给模型的内容一律中文，只有写说明书的系统提示按语言改两处（prompts.ts）；
// 给玩家看的说明（程序调整、主要差别、修复记录、回退原因）按请求的语言写：同一个检查用中文（交回模型）和请求的语言各说一遍。

import { HumanMessage, SystemMessage, ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { parseBrief, type Brief } from '../src/game/level/gen/brief';
import { produceLevel, type ProduceResult } from '../src/game/level/gen/pipeline';
import { deriveSeed } from '../src/game/level/gen/random';
import { packageOfProduced, type LevelPackage } from '../src/game/levels/package';
import { translator, type Lang, type MessageKey, type Translate } from '../src/i18n';
import { briefDifferences } from '../src/workshop/diff';
import type { Preview, WireLevel } from '../src/workshop/protocol';
import { CallTimeout, ZH, describeCallError, type CallErrorInfo, type Say } from './errors';
import { briefJsonSchema, briefSystemPrompt, briefUserPrompt, understandSystemPrompt } from './prompts';
import type { LlmProvider } from './providers';
import { aliasText, describeRoster, resolveAliases, roleProblems, type RosterEntry } from './roster';

/** 模型写说明书的次数上限：首次 1 次 + 修复 2 次。 */
export const MAX_BRIEF_ATTEMPTS = 3;
/** “理解请求”这一步最多执行几轮工具调用。 */
export const MAX_TOOL_ROUNDS = 1;

export type FailureCategory = 'json' | 'brief' | 'cannot-fit' | 'too-far' | 'rejected';

export const FAILURE_KEYS: Readonly<Record<FailureCategory, MessageKey>> = {
  json: 'graph.failJson',
  brief: 'graph.failBrief',
  'cannot-fit': 'graph.failCannotFit',
  'too-far': 'graph.failTooFar',
  rejected: 'graph.failRejected',
};

export interface AttemptLog {
  readonly attempt: number;
  readonly category: FailureCategory;
  /** 交回模型的原因（中文）。 */
  readonly problems: readonly string[];
  /** 同样的原因，按请求的语言（F7，给玩家看）。 */
  readonly shown: readonly string[];
}

export interface Terminal {
  readonly outcome: 'fallback' | 'error';
  /** 中文（日志和统计用）。 */
  readonly reason: string;
  /** 按请求的语言（F7，给玩家看）。 */
  readonly shown: string;
}

export type Decision = 'confirm' | 'discard';

/** 模型调用出错（已经归好类，消息里不含提供方的原文和密钥）。message 是中文；say 按指定的语言说（F7）。 */
export class ModelCallError extends Error {
  constructor(
    readonly info: CallErrorInfo,
    private readonly text: Say,
  ) {
    super(text(ZH));
    this.name = 'ModelCallError';
  }

  say(tr: Translate): string {
    return this.text(tr);
  }
}

export const WorkshopState = Annotation.Root({
  text: Annotation<string>(),
  roster: Annotation<RosterEntry[]>(),
  /** 这次生成的根种子：每次布局尝试由它派生（确认时不重新抽）。 */
  seed: Annotation<string>(),
  /** 请求的语言（F7）：给玩家看的说明按它写。 */
  lang: Annotation<Lang>({ reducer: (_a, b) => b, default: () => 'zh' }),
  understanding: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  /** 模型已经写了几次说明书。 */
  attempt: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** 模型最近一次的输出（原文，只用来解析和交回模型修改）。 */
  raw: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 最近一次通过校验的说明书（回退时用来说明和请求的差别）。 */
  brief: Annotation<Brief | null>({ reducer: (_a, b) => b, default: () => null }),
  lastValidBrief: Annotation<Brief | null>({ reducer: (_a, b) => b ?? _a, default: () => null }),
  /** problems 交回模型（中文），shown 给玩家看（请求的语言）。 */
  failure: Annotation<{ category: FailureCategory; problems: string[]; shown: string[] } | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 交回模型的原因（修复时用）。 */
  problems: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  history: Annotation<AttemptLog[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  level: Annotation<WireLevel | null>({ reducer: (_a, b) => b, default: () => null }),
  adjustment: Annotation<{ change: string; message: string } | null>({ reducer: (_a, b) => b, default: () => null }),
  differences: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  terminal: Annotation<Terminal | null>({ reducer: (_a, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_a, b) => b, default: () => null }),
  final: Annotation<WireLevel | null>({ reducer: (_a, b) => b, default: () => null }),
});

export type WorkshopStateType = typeof WorkshopState.State;

/** 统计里的阶段。 */
export type Stage = 'understand' | 'brief' | 'validate' | 'produce';

export interface GraphDeps {
  readonly provider: LlmProvider;
  readonly callTimeoutMs: number;
  /** 单调时钟（毫秒）。 */
  readonly now: () => number;
  /** 每次调用模型前通知（统计用）。 */
  readonly onModelCall?: (threadId: string) => void;
  /**
   * 开始写一次说明书时通知（统计用）。在调用模型之前通知：这次调用超时、被取消或出错时也算一次已经开始的尝试。
   * （图的状态只在节点正常返回后才提交，所以统计不依赖状态里的 attempt。）
   */
  readonly onBriefAttempt?: (threadId: string) => void;
  /** 一个阶段花了多少时间（统计用，出错、超时时也会通知）。 */
  readonly onStage?: (threadId: string, stage: Stage, ms: number) => void;
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
  const tr = translator(state.lang);
  return {
    level,
    outcome: state.adjustment ? 'program-adjusted' : repairs > 0 ? 'model-repaired' : 'model-first',
    repairs,
    adjustment: state.adjustment,
    differences: state.differences,
    history: state.history.map((log) => historyLine(log, tr)),
    provider: provider.name,
    model: provider.model,
  };
}

/** 修复记录的一行，按 tr 的语言（用 shown）。 */
export function historyLine(log: AttemptLog, tr: Translate): string {
  return tr('graph.historyLine', { attempt: String(log.attempt), label: tr(FAILURE_KEYS[log.category]), problems: log.shown.join(tr('common.semicolon')) });
}

/** 一次失败的类别和原因，按 tr 的语言。 */
function failureOf(result: Exclude<ProduceResult, { ok: true }>, tr: Translate, roster: readonly RosterEntry[]): { category: FailureCategory; problems: string[] } {
  switch (result.kind) {
    case 'brief':
      return { category: 'brief', problems: result.problems.map((p) => aliasText(tr('common.pathMessage', { path: p.path, message: p.message }), roster)) };
    case 'cannot-fit':
    case 'too-far': {
      const attempts = String(result.attempts);
      const tried = result.adjustment ? tr('graph.triedAdjusted', { attempts, change: result.adjustment.change }) : tr('graph.tried', { attempts });
      return { category: result.kind, problems: [`${result.message}${tried}`] };
    }
    case 'rejected':
      return { category: 'rejected', problems: result.problems.map((p) => p.message) };
  }
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

/** 量一个阶段的耗时：不管成功、出错还是超时都通知。 */
async function timed<T>(deps: GraphDeps, config: LangGraphRunnableConfig, stage: Stage, work: () => T | Promise<T>): Promise<T> {
  const start = deps.now();
  try {
    return await work();
  } finally {
    deps.onStage?.(threadOf(config), stage, deps.now() - start);
  }
}

/** 带超时调用一次模型：超时或取消时中止这次调用（fetch 绑定的 signal 一起中止）。step 是这一步的说法（出错时的说明用）。 */
async function callModel<T>(deps: GraphDeps, config: LangGraphRunnableConfig, stage: Stage, step: Say, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return timed(deps, config, stage, async () => {
    const parent = config.signal;
    parent?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new CallTimeout((tr) => tr('graph.singleCall', { step: step(tr) }), deps.callTimeoutMs));
    }, deps.callTimeoutMs);
    const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
    deps.onModelCall?.(threadOf(config));
    try {
      return await work(signal);
    } catch (error) {
      const reason: unknown = signal.reason;
      throw new ModelCallError(describeCallError(error, reason), (tr) => tr('graph.stepFailed', { step: step(tr), message: describeCallError(error, reason, tr).message }));
    } finally {
      clearTimeout(timer);
    }
  });
}

export function buildWorkshopGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const schema = briefJsonSchema();

  const understand = async (state: WorkshopStateType, config: LangGraphRunnableConfig) => {
    const roster = state.roster;
    // 工具只读这次请求带来的名册快照
    const lookupRoster = tool(() => describeRoster(roster), {
      name: 'lookup_roster',
      description: '查名册快照：返回这次可以出场的人物（代号、显示名、允许的分工）。',
      schema: z.object({ query: z.string().optional().describe('想找的人物（可以不填）') }),
    });
    const messages: BaseMessage[] = [new SystemMessage(understandSystemPrompt()), new HumanMessage(`玩家的一句话：${state.text}`)];
    const step: Say = (tr) => tr('graph.stepUnderstand');
    let reply = await callModel(deps, config, 'understand', step, (signal) => deps.provider.chat(messages, [lookupRoster], signal));
    for (let round = 0; round < MAX_TOOL_ROUNDS && (reply.tool_calls?.length ?? 0) > 0; round++) {
      const calls = reply.tool_calls ?? [];
      messages.push(reply);
      calls.forEach((call, i) => {
        // 只执行“查名册快照”这一个只读工具；模型要求的其他工具一律不执行
        const content = call.name === 'lookup_roster' ? describeRoster(roster) : `没有工具 ${call.name}，只能用 lookup_roster`;
        messages.push(new ToolMessage({ content, tool_call_id: call.id ?? `call-${String(i)}` }));
      });
      reply = await callModel(deps, config, 'understand', step, (signal) => deps.provider.chat(messages, [lookupRoster], signal));
    }
    const understanding = textOf(reply).trim().slice(0, 800);
    return { understanding };
  };

  const writeBrief = async (state: WorkshopStateType, config: LangGraphRunnableConfig) => {
    const attempt = state.attempt + 1;
    const messages = [
      new SystemMessage(briefSystemPrompt(state.lang)),
      new HumanMessage(
        briefUserPrompt({ text: state.text, understanding: state.understanding, roster: state.roster, previous: state.raw, problems: state.problems }),
      ),
    ];
    // 先记下“开始了一次尝试”：这次调用超时或被取消时，统计里也算上
    deps.onBriefAttempt?.(threadOf(config));
    const step: Say = (tr) => tr('graph.stepBrief', { attempt: String(attempt) });
    const raw = await callModel(deps, config, 'brief', step, (signal) => deps.provider.structured(messages, schema, signal));
    return { attempt, raw };
  };

  const validate = (state: WorkshopStateType, config: LangGraphRunnableConfig) => timed(deps, config, 'validate', () => validateBrief(state));

  const validateBrief = (state: WorkshopStateType): Partial<WorkshopStateType> => {
    const done = (update: Partial<WorkshopStateType>) => update;
    // 请求的语言（给玩家看）；中文时和交回模型的是同一份
    const shownIn = <T>(zh: T, work: (tr: Translate) => T): T => (state.lang === 'zh' ? zh : work(translator(state.lang)));
    let json: unknown;
    try {
      json = JSON.parse(state.raw ?? '');
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).slice(0, 120);
      const say = (tr: Translate) => [tr('graph.badJson', { why })];
      return done({ brief: null, failure: { category: 'json', problems: say(ZH), shown: shownIn(say(ZH), say) } });
    }
    const resolved = resolveAliases(json, state.roster);
    const ids = new Set(state.roster.map((p) => p.id));
    const check = (tr: Translate) => {
      const parsed = parseBrief(resolved, ids, tr);
      const problems = parsed.ok ? roleProblems(parsed.brief, state.roster, tr) : parsed.problems;
      return { parsed, problems: problems.map((p) => aliasText(tr('common.pathMessage', { path: p.path, message: p.message }), state.roster)) };
    };
    const zh = check(ZH);
    if (!zh.parsed.ok || zh.problems.length > 0) {
      return done({ brief: null, failure: { category: 'brief', problems: zh.problems, shown: shownIn(zh.problems, (tr) => check(tr).problems) } });
    }
    return done({ brief: zh.parsed.brief, lastValidBrief: zh.parsed.brief, failure: null });
  };

  const produce = (state: WorkshopStateType, config: LangGraphRunnableConfig) => timed(deps, config, 'produce', () => produceFrom(state, config));

  const produceFrom = (state: WorkshopStateType, config: LangGraphRunnableConfig): Partial<WorkshopStateType> => {
    const brief = state.brief;
    if (!brief) throw new Error('没有说明书');
    // 每次（模型写的）说明书用由根种子派生的种子：同一次生成里确定，确认时不重新抽
    const seed = deriveSeed(state.seed, `brief-${String(state.attempt)}`);
    const rosterIds = new Set(state.roster.map((p) => p.id));
    const run = (tr: Translate) => (deps.produce ?? produceLevel)(brief, seed, { rosterIds, tr });
    const tr = state.lang === 'zh' ? ZH : translator(state.lang);
    // 程序调整的说明和主要差别按请求的语言写（给玩家看，也存进关卡数据）
    const result = run(tr);
    if (result.ok) {
      const pkg = packageOfProduced(result.level);
      const adjustment = result.level.adjustment;
      return {
        level: wireOf(pkg),
        adjustment: adjustment ? { change: adjustment.change, message: adjustment.message } : null,
        differences: adjustment ? briefDifferences(adjustment.from, adjustment.to, tr) : [],
        failure: null,
      };
    }
    // 失败时交回模型的原因用中文：流水线是确定的，用中文再做一遍得到同样的结果
    const zhResult = state.lang === 'zh' ? result : run(ZH);
    if (zhResult.ok) throw new Error('同一份说明书和种子的结果不一致');
    const zh = failureOf(zhResult, ZH, state.roster);
    const shown = zhResult.kind === result.kind ? failureOf(result, tr, state.roster).problems : zh.problems;
    if (zh.category === 'rejected') deps.onDefect?.(threadOf(config), zh.problems);
    return { failure: { ...zh, shown } };
  };

  const handleFailure = (state: WorkshopStateType) => {
    const failure = state.failure;
    if (!failure) throw new Error('没有失败原因');
    const log: AttemptLog = { attempt: state.attempt, category: failure.category, problems: failure.problems, shown: failure.shown };
    const tr = translator(state.lang);
    const join = (tr: Translate, problems: readonly string[]) => problems.join(tr('common.semicolon'));
    if (failure.category === 'rejected') {
      // 程序缺陷：记录为错误，不交给模型
      const say = (tr: Translate, problems: readonly string[]) => tr('graph.defect', { problems: join(tr, problems) });
      return { history: [log], problems: [], terminal: { outcome: 'error' as const, reason: say(ZH, failure.problems), shown: say(tr, failure.shown) } };
    }
    if (state.attempt >= MAX_BRIEF_ATTEMPTS) {
      const say = (tr: Translate, problems: readonly string[]) =>
        tr('graph.gaveUp', { attempts: String(state.attempt), label: tr(FAILURE_KEYS[failure.category]), problems: join(tr, problems) });
      return { history: [log], problems: [], terminal: { outcome: 'fallback' as const, reason: say(ZH, failure.problems), shown: say(tr, failure.shown) } };
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
