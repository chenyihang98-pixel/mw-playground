// 工坊发给模型的内容、返回给玩家的说明（F7）：用固定的输入跑一遍工坊，记下来。
// tests/data/workshop-texts-zh.json 是用 F7 之前的代码（3fc3f93）记下的中文结果；单元测试用现在的代码再记一遍，逐字节比对。
// 记下的有：每次调用模型的全部消息（类型、内容、工具调用）、工具的名字和说明、结构化输出 schema 的摘要；
// 预览和回退里给玩家看的文字（标题、开场白、台词、程序调整、主要差别、修复记录、回退原因）、统计里的原因；
// 以及几个直接调用的函数（假模型的默认说明书、“太远”的说明、程序调整的说法）。消息内容去重后放在 texts 里，按下标引用。

import { createHash } from 'node:crypto';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { Brief } from '../../src/game/level/gen/brief';
import { checkLevel } from '../../src/game/level/gen/checker';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { adjustBrief, produceLevel } from '../../src/game/level/gen/pipeline';
import { deriveSeed } from '../../src/game/level/gen/random';
import { decideTimeLimit } from '../../src/game/level/gen/timing';
import type { GenerateResponse, RosterPersonSnapshot } from '../../src/workshop/protocol';
import { loadConfig, type WorkshopConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider, defaultBrief, type FakeScript } from '../../server/fakeProvider';
import { createLogger } from '../../server/log';
import type { Availability, LlmProvider } from '../../server/providers';
import { MemoryStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';

const ALICE = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const ROSTER: RosterPersonSnapshot[] = [
  { id: ALICE, name: '小兵', roles: ['companion', 'guard'] },
  { id: BOB, name: '星璇', roles: ['companion'] },
];

function brief(overrides: Partial<Brief> = {}): Brief {
  return {
    schemaVersion: 1,
    tier: 'medium',
    density: 'low',
    platforms: 2,
    collectibles: 4,
    distribution: 'elevated',
    guards: 1,
    patrol: 'loop',
    intent: 'normal',
    visual: { theme: 'grass', time: 'night', weather: 'rain' },
    title: '雨夜高台',
    opening: '宝石都在高台上。',
    cast: [],
    ...overrides,
  };
}

const cast = (personId: string, role: 'companion' | 'guard', line: string): Brief['cast'][number] => ({ personId, role, line });

/** 放不下、需要程序调整的说明书（小地图、障碍多、宝石最多）。 */
export const CROWDED = brief({ tier: 'small', density: 'high', collectibles: GEN_CONFIG.tiers.small.collectibles.max, platforms: 2, guards: 1, distribution: 'scattered' });

function config(overrides: Record<string, string> = {}): WorkshopConfig {
  const loaded = loadConfig({ MW_LLM_PROVIDER: 'fake', MW_WORKSHOP_CALL_TIMEOUT_MS: '5000', MW_WORKSHOP_REQUEST_TIMEOUT_MS: '20000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '10000', ...overrides });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  return loaded.config;
}

interface Scenario {
  readonly name: string;
  readonly text: string;
  readonly roster: readonly RosterPersonSnapshot[];
  readonly script: FakeScript;
  readonly seed?: string;
  readonly config?: Record<string, string>;
  /**
   * 换掉 P5 的流水线：defect 做出布局后去掉一个宝石再检查，得到检查器真实的说明（程序缺陷）；
   * no-room 把布局尝试次数设成 0，每次都放不下（程序调整也放不下）。
   */
  readonly produce?: 'defect' | 'no-room';
}

function scenarios(adjustSeed: string): Scenario[] {
  return [
    { name: 'first', text: '雨夜里的高台，宝石不多', roster: [], script: {} },
    {
      name: 'roster',
      text: '让小兵当守卫，星璇跟着我',
      roster: ROSTER,
      script: {
        understand: [{ kind: 'tool' }, { kind: 'text', text: '中地图，小兵当守卫，星璇当同伴。' }],
        briefs: [{ kind: 'json', value: brief({ cast: [cast('r1', 'guard', '别想溜过去。'), cast('r2', 'companion', '我跟着你。')] }) }],
      },
    },
    {
      name: 'repair',
      text: '星璇来当守卫',
      roster: ROSTER,
      script: {
        briefs: [
          { kind: 'raw', text: '{"schemaVersion": 1, "tier": "medium",' },
          { kind: 'json', value: brief({ cast: [cast('r2', 'guard', '站住！')] }) },
          { kind: 'json', value: brief({ cast: [cast('r2', 'companion', '我跟着你。')] }) },
        ],
      },
    },
    {
      name: 'fallback-brief',
      text: '高台上全是宝石',
      roster: ROSTER,
      script: {
        briefs: [
          { kind: 'json', value: brief({ platforms: 9 }) },
          { kind: 'json', value: brief({ platforms: 0, collectibles: 9, guards: 9 }) },
          { kind: 'json', value: brief({ cast: [cast('r9', 'companion', ''), cast('r1', 'guard', ''), cast('r1', 'companion', '')] }) },
        ],
      },
    },
    { name: 'adjusted', text: '小地图，宝石越多越好，障碍也要多', roster: [], seed: adjustSeed, script: { briefs: [{ kind: 'json', value: CROWDED }] } },
    {
      name: 'fallback-fit',
      text: '小地图，宝石越多越好',
      roster: [],
      script: { briefs: [{ kind: 'json', value: CROWDED }, { kind: 'json', value: CROWDED }, { kind: 'json', value: brief({ tier: 'small', collectibles: 4 }) }] },
      produce: 'no-room',
    },
    { name: 'defect', text: '普通的一关', roster: [], script: {}, produce: 'defect' },
    { name: 'call-timeout', text: '雨夜', roster: [], script: { briefs: [{ kind: 'hang' }] }, config: { MW_WORKSHOP_CALL_TIMEOUT_MS: '1000' } },
    {
      name: 'request-timeout',
      text: '雨夜',
      roster: [],
      script: { understand: [{ kind: 'hang' }] },
      config: { MW_WORKSHOP_REQUEST_TIMEOUT_MS: '1000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' },
    },
    { name: 'model-error', text: '雨夜', roster: [], script: { understand: [{ kind: 'error', message: 'boom' }] } },
    { name: 'prepare-failed', text: '雨夜', roster: [], script: { prepare: { fail: 'network' } } },
    {
      name: 'prepare-timeout',
      text: '雨夜',
      roster: [],
      script: { prepare: { hang: true } },
      config: { MW_WORKSHOP_REQUEST_TIMEOUT_MS: '20000', MW_WORKSHOP_PREPARE_TIMEOUT_MS: '1000' },
    },
  ];
}

interface RecordedMessage {
  readonly type: string;
  readonly content: number;
  readonly toolCalls?: unknown;
  readonly toolCallId?: string;
}

interface RecordedCall {
  readonly step: 'chat' | 'structured';
  readonly messages: readonly RecordedMessage[];
  readonly tools?: readonly { readonly name: string; readonly description: number; readonly schema: string }[];
  readonly schema?: string;
}

export interface WorkshopTexts {
  readonly texts: readonly string[];
  readonly scenarios: Readonly<Record<string, { readonly calls: readonly RecordedCall[]; readonly shown: unknown; readonly statsReason: string | null }>>;
  readonly direct: Readonly<Record<string, unknown>>;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** 包住假模型，记下每次调用收到的全部内容。 */
class Recorder implements LlmProvider {
  readonly calls: RecordedCall[] = [];
  constructor(
    private readonly inner: FakeProvider,
    private readonly intern: (text: string) => number,
  ) {}
  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }
  private messages(list: readonly BaseMessage[]): RecordedMessage[] {
    return list.map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const toolCalls = (m as AIMessage).tool_calls;
      const toolCallId = (m as { tool_call_id?: string }).tool_call_id;
      return { type: m.type, content: this.intern(content), ...(toolCalls?.length ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}) };
    });
  }
  chat(messages: readonly BaseMessage[], tools: readonly StructuredToolInterface[], signal: AbortSignal): Promise<AIMessage> {
    this.calls.push({
      step: 'chat',
      messages: this.messages(messages),
      tools: tools.map((tool) => ({ name: tool.name, description: this.intern(tool.description), schema: sha(JSON.stringify(z.toJSONSchema(tool.schema as z.ZodType))) })),
    });
    return this.inner.chat(messages, tools, signal);
  }
  structured(messages: readonly BaseMessage[], schema: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    this.calls.push({ step: 'structured', messages: this.messages(messages), schema: sha(JSON.stringify(schema)) });
    return this.inner.structured(messages, schema, signal);
  }
  availability(signal: AbortSignal): Promise<Availability> {
    return this.inner.availability(signal);
  }
  prepare(signal: AbortSignal): Promise<void> {
    return this.inner.prepare(signal);
  }
}

function shown(res: GenerateResponse): unknown {
  if (res.status === 'preview') {
    const { level, ...preview } = res.preview;
    return {
      status: res.status,
      outcome: preview.outcome,
      repairs: preview.repairs,
      title: level.title,
      opening: level.brief.opening,
      lines: level.brief.cast.map((c) => c.line),
      adjustment: preview.adjustment,
      levelAdjustment: level.adjustment ? { reason: level.adjustment.reason, change: level.adjustment.change, message: level.adjustment.message } : null,
      differences: preview.differences,
      history: preview.history,
    };
  }
  if (res.status === 'fallback') {
    const f = res.fallback;
    return { status: res.status, outcome: f.outcome, reason: f.reason, history: f.history, differences: f.differences, fallbackId: f.fallbackId };
  }
  return { status: res.status };
}

/** 程序调整用的根种子：它派生出的第 1 次种子需要调整，调整后能生成。 */
export function adjustSeed(): string {
  const seed = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].find((s) => {
    const r = produceLevel(CROWDED, deriveSeed(s, 'brief-1'));
    return r.ok && r.level.adjustment !== null;
  });
  if (!seed) throw new Error('没有找到需要调整的种子');
  return seed;
}

/** 用固定的输入跑一遍。lang 不给时，请求里不带语言（和 F7 之前一样）。 */
export async function recordWorkshopTexts(lang?: string): Promise<WorkshopTexts> {
  const texts: string[] = [];
  const index = new Map<string, number>();
  const intern = (text: string) => {
    const found = index.get(text);
    if (found !== undefined) return found;
    texts.push(text);
    index.set(text, texts.length - 1);
    return texts.length - 1;
  };
  const out: Record<string, { calls: readonly RecordedCall[]; shown: unknown; statsReason: string | null }> = {};
  let n = 0;
  for (const s of scenarios(adjustSeed())) {
    const provider = new Recorder(new FakeProvider(s.script), intern);
    const stats = new MemoryStats();
    const defect: typeof produceLevel = (input, seed, options) => {
      const r = produceLevel(input, seed, options);
      if (!r.ok) return r;
      const layout = { ...r.level.layout, collectibles: r.level.layout.collectibles.slice(1) };
      const report = checkLevel(layout, { brief: r.level.brief, grid: GEN_CONFIG.check.grid, spawnGuardDistance: GEN_CONFIG.check.spawnGuardDistance, tr: options?.tr });
      return { ok: false, kind: 'rejected', problems: report.problems, attempts: 1, adjustment: null };
    };
    const noRoom: typeof produceLevel = (input, seed, options) =>
      produceLevel(input, seed, { ...options, config: { ...GEN_CONFIG, generator: { ...GEN_CONFIG.generator, attempts: 0 } } });
    const produce = s.produce === 'defect' ? defect : s.produce === 'no-room' ? noRoom : undefined;
    const workshop = new Workshop({
      config: config(s.config),
      provider,
      stats,
      log: createLogger(new Redactor([]), () => undefined),
      newSeed: () => s.seed ?? 'seed-1',
      serviceId: 'service-1',
      produce,
    });
    n++;
    const request = { generationId: `texts-${String(n).padStart(4, '0')}`, text: s.text, roster: [...s.roster], ...(lang === undefined ? {} : { lang }) };
    const res = await workshop.generate(request as Parameters<Workshop['generate']>[0]);
    out[s.name] = { calls: provider.calls, shown: shown(res), statsReason: stats.records[0]?.reason ?? null };
  }
  const direct = {
    defaultBriefs: ['雨夜里的高台', '小地图', 'a quiet night'].map((text) => {
      const b = defaultBrief(text);
      return { title: b.title, opening: b.opening };
    }),
    tooFar: (() => {
      const d = decideTimeLimit(10_000, 'tense', 'small');
      return d.ok ? null : d.message;
    })(),
    adjustCollectibles: adjustBrief(brief({ density: 'low', collectibles: 6 }), 'too-far')?.change ?? null,
    adjustDensity: adjustBrief(brief({ density: 'high' }), 'cannot-fit')?.change ?? null,
  };
  return { texts, scenarios: out, direct };
}
