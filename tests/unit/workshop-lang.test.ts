// 工坊的语言（F7）。
// - zh：发给模型的全部内容、返回给玩家的说明，和 F7 之前（3fc3f93）逐字节相同（tests/data/workshop-texts-zh.json，用起点的代码记下）；
// - ja、en：发给模型的内容只有写说明书的系统提示不同，正好是两处（title 那一行、加的那一行）；
//   给玩家看的说明来自对应的词典，不含中文原文；统计里的原因仍是中文；
// - 请求的 lang：没给时按 zh，无效值被拒绝（bad-request）；
// - 假模型：ja、en 的标题和开场白来自对应的词典（zh 的输出在上面的数据里）；
// - 健康检查里不能用的原因按界面的语言写。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { messagesOf, setLang, translate, translator, type Lang, type MessageKey } from '../../src/i18n';
import { WorkshopClient } from '../../src/workshop/client';
import { generateRequestSchema } from '../../src/workshop/protocol';
import { loadConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider, defaultBrief } from '../../server/fakeProvider';
import { createWorkshopServer, listen } from '../../server/http';
import { createLogger } from '../../server/log';
import { BRIEF_LANG_LINES, briefSystemPrompt } from '../../server/prompts';
import { OffProvider, OllamaProvider } from '../../server/providers';
import { MemoryStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';
import { PROJECT_ROOT } from '../helpers/node';
import { recordWorkshopTexts, type WorkshopTexts } from '../helpers/workshopTexts';

const BASE_TEXT = readFileSync(join(PROJECT_ROOT, 'tests/data/workshop-texts-zh.json'), 'utf8');
const BASE = JSON.parse(BASE_TEXT) as WorkshopTexts;
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const OTHER = ['ja', 'en'] as const;
const records: Partial<Record<Lang, WorkshopTexts>> = {};

beforeAll(async () => {
  for (const lang of OTHER) records[lang] = await recordWorkshopTexts(lang);
}, 60_000);

const serialize = (texts: WorkshopTexts) => `${JSON.stringify(texts, null, 1)}\n`;

/** 调用记录里的下标换成文字。 */
function callsWithText(rec: WorkshopTexts, name: string, replace: (text: string) => string = (s) => s): unknown {
  const calls = rec.scenarios[name]?.calls ?? [];
  return calls.map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({ ...m, content: replace(rec.texts[m.content] ?? '') })),
    tools: c.tools?.map((tool) => ({ ...tool, description: rec.texts[tool.description] })),
  }));
}

interface Shown {
  readonly title?: string;
  readonly opening?: string;
  readonly reason?: string;
  readonly adjustment?: { change: string; message: string } | null;
  readonly levelAdjustment?: { reason: string; change: string; message: string } | null;
  readonly differences?: readonly string[];
  readonly history?: readonly string[];
}

const shownOf = (rec: WorkshopTexts, name: string) => (rec.scenarios[name]?.shown ?? {}) as Shown;

/** 给玩家看的说明（不含模型写的标题、开场白、台词）。 */
function explanations(s: Shown): string[] {
  return [
    ...(s.reason ? [s.reason] : []),
    ...(s.adjustment ? [s.adjustment.change, s.adjustment.message] : []),
    ...(s.levelAdjustment ? [s.levelAdjustment.change, s.levelAdjustment.message] : []),
    ...(s.differences ?? []),
    ...(s.history ?? []),
  ];
}

/** 中文词典里和这种语言不同的文字片段（按占位拆开，只留含汉字、至少两个字、这种语言的词典里也没有的）。 */
function zhOnlyFragments(lang: Lang): string[] {
  const zh = messagesOf('zh');
  const other = messagesOf(lang);
  const otherText = Object.values(other).join('\n');
  const out = new Set<string>();
  for (const key of Object.keys(zh) as MessageKey[]) {
    if (zh[key] === other[key]) continue;
    for (const part of zh[key].split(/\{\w+\}/)) {
      for (const fragment of part.split(/[\s，。、；：（）“”「」·→—…！？,.;:()]+/)) {
        if (fragment.length >= 2 && /[㐀-鿿]/.test(fragment) && !otherText.includes(fragment)) out.add(fragment);
      }
    }
  }
  return [...out];
}

/** 按词条的模板认文字：wild 里的占位可以是任意内容。 */
function shape(lang: Lang, key: MessageKey, params: Record<string, string>, wild: readonly string[]): RegExp {
  const marked = translate(lang, key, { ...params, ...Object.fromEntries(wild.map((w) => [w, '\u0000'])) });
  return new RegExp(`^${marked.split('\u0000').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
}

describe('zh：和 F7 之前逐字节相同', () => {
  it('请求不带 lang、带 lang: zh：发给模型的全部内容和给玩家看的说明都和起点记下的一样', async () => {
    expect(serialize(await recordWorkshopTexts())).toBe(BASE_TEXT);
    expect(serialize(await recordWorkshopTexts('zh'))).toBe(BASE_TEXT);
  }, 60_000);

  it('起点的数据覆盖了几类：没有名册人物、有名册人物并调用工具、修复轮带问题、程序调整、回退、程序缺陷、超时、加载失败', () => {
    expect(Object.keys(BASE.scenarios)).toEqual(['first', 'roster', 'repair', 'fallback-brief', 'adjusted', 'fallback-fit', 'defect', 'call-timeout', 'request-timeout', 'model-error', 'prepare-failed', 'prepare-timeout']);
    expect(BASE.texts).toContain(briefSystemPrompt());
    expect(BASE.texts.some((t) => t.includes('它没有通过，原因如下'))).toBe(true);
    expect(BASE.scenarios.roster?.calls[0]?.tools?.[0]?.name).toBe('lookup_roster');
  });
});

describe('ja、en：发给模型的内容', () => {
  for (const lang of OTHER) {
    it(`${lang}：只有写说明书的系统提示换成 ${lang} 的版本，其余（理解请求的提示、用户消息、修复时的问题、工具说明、schema）和 zh 完全相同`, () => {
      const rec = records[lang];
      if (!rec) throw new Error('没有记录');
      const zhPrompt = briefSystemPrompt('zh');
      const langPrompt = briefSystemPrompt(lang);
      expect(rec.texts).toContain(langPrompt);
      expect(rec.texts).not.toContain(zhPrompt);
      for (const name of Object.keys(BASE.scenarios)) {
        expect(callsWithText(rec, name, (s) => (s === langPrompt ? zhPrompt : s)), name).toEqual(callsWithText(BASE, name));
      }
    });

    it(`${lang}：写说明书的系统提示和 zh 的差别正好是两处：title 那一行、加在 cast 后面的一行`, () => {
      const zh = briefSystemPrompt('zh').split('\n');
      const other = briefSystemPrompt(lang).split('\n');
      const max = String(GEN_CONFIG.brief.titleMaxLength);
      const titleAt = zh.findIndex((l) => l.startsWith('- title：'));
      const castAt = zh.findIndex((l) => l.startsWith('- cast：'));
      expect(zh[titleAt]).toBe(`- title：中文标题，1–${max} 个字。`);
      expect(other[titleAt]).toBe(lang === 'ja' ? `- title：日语标题，1–${max} 个字。` : `- title：英语标题，1–${max} 个字符。`);
      expect(other[castAt + 1]).toBe(BRIEF_LANG_LINES[lang]);
      expect(BRIEF_LANG_LINES[lang]).toBe(`- title、opening 和 cast 里每个 line 都用${lang === 'ja' ? '日语' : '英语'}写。`);
      const rest = other.filter((_l, i) => i !== titleAt && i !== castAt + 1);
      expect(rest).toEqual(zh.filter((_l, i) => i !== titleAt));
    });
  }
});

describe('ja、en：给玩家看的说明', () => {
  for (const lang of OTHER) {
    const tr = translator(lang);
    it(`${lang}：程序调整、主要差别、修复记录、回退原因都来自 ${lang} 的词典`, () => {
      const rec = records[lang];
      if (!rec) throw new Error('没有记录');
      const adjusted = shownOf(rec, 'adjusted');
      const change = tr('pipeline.adjustDensity', { from: 'high', to: 'mid' });
      const message = tr('pipeline.cannotFit', { tier: 'small', size: String(GEN_CONFIG.tiers.small.size), attempts: String(GEN_CONFIG.generator.attempts) });
      expect(adjusted.adjustment).toEqual({ change, message });
      expect(adjusted.levelAdjustment).toEqual({ reason: 'cannot-fit', change, message });
      expect(adjusted.differences).toEqual([tr('diff.change', { label: tr('diff.obstacles'), from: tr('density.high'), to: tr('density.mid') })]);

      const repair = shownOf(rec, 'repair').history ?? [];
      // JSON 解析器的说明（V8 的英文原文）各语言一样，从 zh 的记录里取
      const why = /JSON（(.*)）：只输出/.exec(shownOf(BASE, 'repair').history?.[0] ?? '')?.[1] ?? '';
      expect(why).not.toBe('');
      expect(repair[0]).toBe(tr('graph.historyLine', { attempt: '1', label: tr('graph.failJson'), problems: tr('graph.badJson', { why }) }));
      const role = tr('graph.roleNotAllowed', { id: 'r2', name: '星璇', role: tr('role.guard'), roles: tr('role.companion') });
      expect(repair[1]).toBe(tr('graph.historyLine', { attempt: '2', label: tr('graph.failBrief'), problems: tr('common.pathMessage', { path: 'cast.0.role', message: role }) }));

      const gaveUp = shownOf(rec, 'fallback-brief');
      expect(gaveUp.reason).toMatch(shape(lang, 'graph.gaveUp', { attempts: '3', label: tr('graph.failBrief') }, ['problems']));
      expect(gaveUp.differences).toEqual([tr('diff.noBrief', { title: tr('levelName.gen1') })]);
      expect(gaveUp.history).toHaveLength(3);

      const fit = shownOf(rec, 'fallback-fit');
      expect(fit.reason).toMatch(shape(lang, 'graph.gaveUp', { attempts: '3', label: tr('graph.failCannotFit') }, ['problems']));
      expect(fit.reason).toContain(tr('graph.triedAdjusted', { attempts: '0', change: tr('pipeline.adjustCollectibles', { from: '4', to: '2' }) }));
      expect(fit.differences?.[0]).toBe(tr('diff.notYours', { title: tr('levelName.gen1') }));
      for (const d of fit.differences?.slice(1) ?? []) expect(d).toMatch(shape(lang, 'diff.change', {}, ['label', 'from', 'to']));

      const defect = shownOf(rec, 'defect');
      expect(defect.reason).toMatch(shape(lang, 'graph.defect', {}, ['problems']));
      expect(defect.reason).toContain(tr('checker.notEnoughCollectibles', { count: '7', target: '8' }));
      expect(defect.reason).toContain(tr('common.pathMessage', { path: 'target', message: tr('schema.targetTooLarge', { target: 8, count: 7 }) }));

      const brief1 = tr('graph.stepBrief', { attempt: '1' });
      expect(shownOf(rec, 'call-timeout').reason).toBe(tr('graph.stepFailed', { step: brief1, message: tr('callError.timeout', { what: tr('graph.singleCall', { step: brief1 }), seconds: '1' }) }));
      expect(shownOf(rec, 'request-timeout').reason).toBe(tr('callError.timeout', { what: tr('callError.wholeRequest'), seconds: '1' }));
      expect(shownOf(rec, 'model-error').reason).toBe(tr('graph.stepFailed', { step: tr('graph.stepUnderstand'), message: tr('callError.other') }));
      expect(shownOf(rec, 'prepare-failed').reason).toBe(tr('prepare.failedBecause', { why: tr('callError.network') }));
      expect(shownOf(rec, 'prepare-timeout').reason).toBe(tr('callError.timeout', { what: tr('callError.prepare'), seconds: '1' }));
    });

    it(`${lang}：说明里没有中文原文（${lang === 'en' ? '除了名册里的名字没有汉字和假名' : '没有和日语不同的中文片段'}）；统计里的原因仍是中文`, () => {
      const rec = records[lang];
      if (!rec) throw new Error('没有记录');
      const fragments = zhOnlyFragments(lang);
      expect(fragments.length).toBeGreaterThan(50);
      let count = 0;
      for (const name of Object.keys(BASE.scenarios)) {
        const zh = explanations(shownOf(BASE, name));
        const other = explanations(shownOf(rec, name));
        expect(other.length, name).toBe(zh.length);
        other.forEach((text, i) => {
          count++;
          expect(text, `${name} #${String(i)}`).not.toBe(zh[i]);
          expect(fragments.filter((f) => text.includes(f)), `${name}：${text}`).toEqual([]);
          if (lang === 'en') expect(text.replaceAll('星璇', '').replaceAll('小兵', ''), `${name}：${text}`).not.toMatch(CJK);
        });
        expect(rec.scenarios[name]?.statsReason, name).toBe(BASE.scenarios[name]?.statsReason);
      }
      expect(count).toBeGreaterThan(30);
    });
  }
});

describe('假模型', () => {
  for (const lang of OTHER) {
    it(`${lang}：默认说明书的标题和开场白来自 ${lang} 的词典，和 zh 选的是同一条`, () => {
      const zh = messagesOf('zh');
      const other = messagesOf(lang);
      const keyOf = (text: string) => (Object.keys(zh) as MessageKey[]).find((k) => k.startsWith('randomText.') && zh[k] === text);
      for (const text of ['雨夜里的高台', '小地图', 'a quiet night', 'A rainy night with gems on the platforms']) {
        const zhBrief = defaultBrief(text);
        const brief = defaultBrief(text, lang);
        const titleKey = keyOf(zhBrief.title);
        expect(titleKey).toBeDefined();
        if (titleKey) expect(brief.title).toBe(other[titleKey]);
        const openingKey = keyOf(zhBrief.opening);
        expect(brief.opening).toBe(openingKey ? other[openingKey] : '');
        expect({ ...brief, title: '', opening: '' }).toEqual({ ...zhBrief, title: '', opening: '' });
        if (lang === 'en') expect(`${brief.title}${brief.opening}`).not.toMatch(CJK);
      }
      // 工坊里：假模型从系统提示认出语言
      const first = shownOf(records[lang] ?? BASE, 'first');
      expect(first.title).toBe(defaultBrief('雨夜里的高台，宝石不多', lang).title);
      expect(first.opening).toBe(defaultBrief('雨夜里的高台，宝石不多', lang).opening);
    });
  }
});

describe('请求的 lang', () => {
  const servers: ReturnType<typeof createWorkshopServer>[] = [];
  afterAll(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  async function start(provider: 'fake' | 'off') {
    const loaded = loadConfig({ MW_LLM_PROVIDER: provider });
    if (!loaded.ok) throw new Error(loaded.problems.join('；'));
    const fake = new FakeProvider();
    const log = createLogger(new Redactor([]), () => undefined);
    const workshop = new Workshop({ config: loaded.config, provider: provider === 'fake' ? fake : new OffProvider(), stats: new MemoryStats(), log });
    const server = createWorkshopServer(workshop, { maxBodyBytes: loaded.config.limits.maxBodyBytes }, log);
    servers.push(server);
    const base = `http://127.0.0.1:${String(await listen(server, 0))}/api/workshop`;
    return { fake, base };
  }

  it('schema：没给时没有 lang（按 zh）；zh、ja、en 可以；其他值不行', () => {
    const body = { generationId: 'lang-0000001', text: '雨夜', roster: [] };
    expect(generateRequestSchema.parse(body).lang).toBeUndefined();
    for (const lang of ['zh', 'ja', 'en']) expect(generateRequestSchema.parse({ ...body, lang }).lang).toBe(lang);
    for (const lang of ['fr', 'ZH', '', 1, null]) expect(generateRequestSchema.safeParse({ ...body, lang }).success, String(lang)).toBe(false);
  });

  it('接口：无效的 lang 和其他无效字段一样返回 400（bad-request），不调用模型；en 的请求按英语出预览', async () => {
    const s = await start('fake');
    const post = (body: unknown) => fetch(`${s.base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await post({ generationId: 'lang-0000002', text: '雨夜', roster: [], lang: 'fr' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(s.fake.calls).toEqual({ chat: 0, structured: 0 });
    const ok = await post({ generationId: 'lang-0000003', text: 'A rainy night', roster: [], lang: 'en' });
    const body = (await ok.json()) as { status: string; preview: { level: { title: string } } };
    expect(body.status).toBe('preview');
    expect(body.preview.level.title).toBe(defaultBrief('A rainy night', 'en').title);
  });

  it('健康检查：不能用的原因按 ?lang= 的语言写；没给或不认识时是中文（和起点一样）', async () => {
    const s = await start('off');
    const reason = async (query: string) => ((await (await fetch(`${s.base}/health${query}`)).json()) as { reason: string | null }).reason;
    expect(await reason('')).toBe('工坊没有启用模型（MW_LLM_PROVIDER=off）');
    expect(await reason('?lang=xx')).toBe('工坊没有启用模型（MW_LLM_PROVIDER=off）');
    expect(await reason('?lang=ja')).toBe(translate('ja', 'health.off'));
    expect(await reason('?lang=en')).toBe(translate('en', 'health.off'));
    const down = new OllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: 'test-model', numCtx: 8192 });
    expect((await down.availability(AbortSignal.timeout(2000))).reason).toBe('连不上 Ollama（http://127.0.0.1:9）');
    expect((await down.availability(AbortSignal.timeout(2000), translator('en'))).reason).toBe(translate('en', 'health.ollamaNetwork', { url: 'http://127.0.0.1:9' }));
  });

  it('浏览器：生成请求带上界面的语言；健康检查在界面不是中文时带上 ?lang=', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: 'internal', message: 'x' } }), { status: 500 }));
    };
    try {
      const client = new WorkshopClient(fetchImpl, '/api/workshop', () => 'lang-0000004');
      await client.health();
      setLang('ja');
      await client.health();
      await client.generate('雨の夜', []);
      expect(urls).toEqual(['/api/workshop/health', '/api/workshop/health?lang=ja', '/api/workshop/generate']);
      expect(bodies).toEqual([{ generationId: 'lang-0000004', text: '雨の夜', roster: [], lang: 'ja' }]);
    } finally {
      setLang('zh');
    }
  });
});
