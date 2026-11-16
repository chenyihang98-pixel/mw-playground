// 界面固定文字的多语言（F6）：词典、语言的决定顺序、内置关卡的名字、随机一关的文字、服务端错误码、按说法判断的几处逻辑。
// 不用浏览器：语言的决定和存储读写都是纯函数（存储用假的对象，可以让它抛错）。

import { afterEach, describe, expect, it } from 'vitest';
import { assignLevelCast, isStandInNotice, type CastMember } from '../../src/roster/cast';
import { parseBrief } from '../../src/game/level/gen/brief';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import { BUILTIN_LEVEL_DATA } from '../../src/game/level/builtin';
import { GENERATED_LEVELS } from '../../src/game/level/generatedLevels';
import { builtinEntries, builtinPackage } from '../../src/game/levels/catalog';
import { BUILTIN_OPENING_KEYS, BUILTIN_TITLE_KEYS, displayOpening, displayTitle } from '../../src/game/levels/titles';
import { currentLang, messagesOf, setLang, t, type MessageKey } from '../../src/i18n';
import { LANGS, LANG_STORAGE_KEY, langFromBrowser, readStoredLang, resolveLang, storeLang, type Lang } from '../../src/i18n/lang';
import { poseWording } from '../../src/import/ui/wording';
import { SERVER_ERROR_KEYS, serverErrorText } from '../../src/workshop/client';
import { ERROR_CODES } from '../../src/workshop/protocol';

afterEach(() => {
  setLang('zh');
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;

describe('词典', () => {
  it('三种语言的键完全相同、没有空值，每个键的占位名一致', () => {
    const zh = messagesOf('zh');
    const keys = Object.keys(zh).sort();
    expect(keys.length).toBeGreaterThan(400);
    for (const lang of LANGS) {
      const dict = messagesOf(lang);
      expect(Object.keys(dict).sort(), lang).toEqual(keys);
      for (const key of keys) {
        const value = dict[key as MessageKey];
        expect(value.trim(), `${lang} ${key}`).not.toBe('');
        expect(placeholders(value), `${lang} ${key}`).toEqual(placeholders(zh[key as MessageKey]));
      }
    }
  });

  it('英语词典里没有汉字和假名', () => {
    const en = messagesOf('en');
    expect(Object.entries(en).filter(([, v]) => CJK.test(v))).toEqual([]);
  });

  it('t() 按当前语言取文字，填进同名的占位；Node 里默认是中文', () => {
    expect(currentLang()).toBe('zh');
    expect(t('hud.timeLeft', { time: '0:30.0' })).toBe('剩余 0:30.0');
    setLang('en');
    expect(t('hud.timeLeft', { time: '0:30.0' })).toBe('0:30.0 left');
    setLang('ja');
    expect(t('common.seconds', { seconds: 5 })).toBe('5 秒');
  });

  it('用词：关卡工坊、名册、主角、同伴、守卫、确认在日语和英语里的说法', () => {
    const expected: [MessageKey, string, string][] = [
      ['levels.workshop', 'レベル工房', 'Level Workshop'],
      ['common.roster', '名簿', 'Roster'],
      ['role.player', '主人公', 'Player character'],
      ['role.companion', '仲間', 'Companion'],
      ['role.guard', '守衛', 'Guard'],
      ['workshop.confirm', '確定', 'Confirm'],
      ['import.preview', 'プレビュー', 'Preview'],
      ['preview.gems', '宝石', 'Gems'],
    ];
    for (const [key, ja, en] of expected) {
      expect(messagesOf('ja')[key], key).toBe(ja);
      expect(messagesOf('en')[key], key).toBe(en);
    }
    expect(messagesOf('ja')['random.reasonBrief']).toContain('ステージ仕様書');
    expect(messagesOf('en')['random.reasonBrief']).toMatch(/level brief/i);
  });
});

describe('语言的决定顺序', () => {
  const sources = (search: string, stored: string | null, languages: string[]) => ({ search, stored, languages });

  it('?lang= 优先；其次是保存的选择；再次是浏览器语言', () => {
    expect(resolveLang(sources('?lang=ja', 'en', ['zh-CN']))).toBe('ja');
    expect(resolveLang(sources('?level=test-a&lang=en', 'ja', ['zh-CN']))).toBe('en');
    expect(resolveLang(sources('', 'en', ['zh-CN']))).toBe('en');
    expect(resolveLang(sources('', null, ['ja-JP', 'en-US']))).toBe('ja');
  });

  it('浏览器语言：zh-CN、zh-TW 取 zh，ja-JP 取 ja，fr、空列表取 en；按列表顺序取第一个能用的', () => {
    expect(langFromBrowser(['zh-CN'])).toBe('zh');
    expect(langFromBrowser(['zh-TW'])).toBe('zh');
    expect(langFromBrowser(['ja-JP'])).toBe('ja');
    expect(langFromBrowser(['fr'])).toBe('en');
    expect(langFromBrowser([])).toBe('en');
    expect(langFromBrowser(['fr-FR', 'ja', 'zh-CN'])).toBe('ja');
    expect(langFromBrowser(['en-US', 'zh-Hans-CN'])).toBe('zh');
  });

  it('无效的 ?lang= 和无效的保存值都被忽略', () => {
    expect(resolveLang(sources('?lang=fr', 'ja', ['zh-CN']))).toBe('ja');
    expect(resolveLang(sources('?lang=', null, ['ja-JP']))).toBe('ja');
    expect(resolveLang(sources('?lang=ZH', 'de', ['fr']))).toBe('en');
    expect(resolveLang(sources('', 'japanese', ['zh-TW']))).toBe('zh');
  });

  it('localStorage 抛错时按没有保存过处理，不报错；写失败返回 false', () => {
    const throwing = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(readStoredLang(throwing)).toBeNull();
    expect(storeLang(throwing, 'ja')).toBe(false);
    const getItemThrows = () => ({
      getItem: () => {
        throw new Error('getItem failed');
      },
    });
    expect(readStoredLang(getItemThrows)).toBeNull();
    expect(resolveLang({ search: '', stored: readStoredLang(throwing), languages: ['ja-JP'] })).toBe('ja');
  });

  it('保存和读回用同一个键', () => {
    const map = new Map<string, string>();
    const storage = () => ({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    });
    expect(storeLang(storage, 'en')).toBe(true);
    expect(map.get(LANG_STORAGE_KEY)).toBe('en');
    expect(readStoredLang(storage)).toBe('en');
  });
});

describe('内置关卡的名字', () => {
  it('翻译表覆盖所有内置关卡 id；中文词条和数据里的名字、开场白完全一样', () => {
    const ids = builtinEntries().map((e) => e.id);
    expect(ids.length).toBe(6);
    for (const id of ids) expect(BUILTIN_TITLE_KEYS[id], id).toBeDefined();
    for (const id of Object.keys(BUILTIN_LEVEL_DATA)) expect(t(BUILTIN_TITLE_KEYS[id] ?? 'app.title'), id).toBe(BUILTIN_LEVEL_DATA[id]?.name);
    for (const level of GENERATED_LEVELS) {
      expect(t(BUILTIN_TITLE_KEYS[level.id] ?? 'app.title'), level.id).toBe(level.layout.name);
      expect(t(BUILTIN_OPENING_KEYS[level.id] ?? 'app.title'), level.id).toBe(level.brief.opening);
    }
  });

  it('内置关卡按 id 显示当前语言的名字（不是原样）；冻结的数据不变', () => {
    const pkg = builtinPackage('gen-1');
    if (!pkg) throw new Error('没有 gen-1');
    const hash = pkg.layoutHash;
    setLang('en');
    expect(displayTitle(pkg)).toEqual({ text: 'Morning Meadow', raw: false });
    expect(displayOpening(pkg).raw).toBe(false);
    expect(displayOpening(pkg).text).not.toMatch(CJK);
    setLang('ja');
    expect(displayTitle(pkg)).toEqual({ text: '朝の草原', raw: false });
    expect(pkg.title).toBe('晨光草地');
    expect(builtinPackage('gen-1')?.layoutHash).toBe(hash);
  });
});

describe('随机一关的文字', () => {
  const people = [
    { id: 'a'.repeat(64), name: 'A' },
    { id: 'b'.repeat(64), name: 'B' },
    { id: 'c'.repeat(64), name: 'C' },
  ];

  // F6 之前的 randomBrief（提交 ace3bec）对这些种子生成的标题、开场白和台词
  const BEFORE_F6: { seed: string; title: string; opening: string; lines: string[] }[] = [
    { seed: 'f6-seed-1', title: '雪地小镇', opening: '这片地方的路有些曲折，看清方向再出发。', lines: ['前面好像有东西。', '我在后面看着呢。', '一起去找宝石吧！'] },
    { seed: 'f6-seed-2', title: '石阶之间', opening: '这片地方的路有些曲折，看清方向再出发。', lines: ['一起去找宝石吧！', '前面好像有东西。', '前面好像有东西。'] },
    { seed: 'f6-seed-3', title: '迷雾庭院', opening: '高处也许藏着宝石，找找坡道在哪里。', lines: ['我跟着你，别走太快。', '一起去找宝石吧！', '我跟着你，别走太快。'] },
    { seed: 'f6-seed-4', title: '箱子迷宫', opening: '', lines: ['我在后面看着呢。', '一起去找宝石吧！', '一起去找宝石吧！'] },
    { seed: 'f6-seed-5', title: '黄昏集市', opening: '', lines: ['我会一直盯着你。'] },
    { seed: 'f6-seed-6', title: '宝石小径', opening: '宝石散落在各处，赶在时间用完之前把它们都找回来。', lines: ['我跟着你，别走太快。', '一起去找宝石吧！'] },
  ];

  it('中文下固定种子的标题、开场白、台词和 F6 之前逐字一致', () => {
    for (const row of BEFORE_F6) {
      const brief = randomBrief(row.seed, people);
      expect({ seed: row.seed, title: brief.title, opening: brief.opening, lines: brief.cast.map((c) => c.line) }).toEqual(row);
    }
  });

  it('日语、英语下生成的文字来自对应语言的词典；同一个种子的数值和组合与中文相同；都通过说明书的校验', () => {
    const textKeys = (lang: Lang, prefix: string) =>
      Object.entries(messagesOf(lang))
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    for (const lang of ['ja', 'en'] as const) {
      for (let i = 0; i < 200; i++) {
        const seed = `f6-lang-${String(i)}`;
        setLang('zh');
        const zhBrief = randomBrief(seed, people);
        setLang(lang);
        const brief = randomBrief(seed, people);
        expect({ ...brief, title: '', opening: '', cast: brief.cast.map((c) => ({ ...c, line: '' })) }).toEqual({
          ...zhBrief,
          title: '',
          opening: '',
          cast: zhBrief.cast.map((c) => ({ ...c, line: '' })),
        });
        expect(textKeys(lang, 'randomText.title')).toContain(brief.title);
        if (brief.opening !== '') expect(textKeys(lang, 'randomText.opening')).toContain(brief.opening);
        for (const c of brief.cast) expect(textKeys(lang, c.role === 'guard' ? 'randomText.guardLine' : 'randomText.companionLine')).toContain(c.line);
        if (lang === 'en') expect(`${brief.title}${brief.opening}${brief.cast.map((c) => c.line).join('')}`).not.toMatch(CJK);
        expect(parseBrief(brief, new Set(people.map((p) => p.id))).ok, `${lang} ${seed}`).toBe(true);
      }
    }
  });
});

describe('服务端错误码', () => {
  it('protocol.ts 的每个错误码在三种语言里都有翻译；中文照旧显示服务端的原文，日语和英语按错误码', () => {
    const codes = Object.values(ERROR_CODES);
    expect(Object.keys(SERVER_ERROR_KEYS).sort()).toEqual([...codes].sort());
    for (const lang of LANGS) {
      for (const code of codes) expect(messagesOf(lang)[SERVER_ERROR_KEYS[code]].trim(), `${lang} ${code}`).not.toBe('');
    }
    const error = { code: ERROR_CODES.expired, message: '工坊服务重启过，未确认的预览已失效' };
    expect(serverErrorText(error)).toBe('工坊服务重启过，未确认的预览已失效');
    setLang('en');
    expect(serverErrorText(error)).toBe(messagesOf('en')['serverError.expired']);
    expect(serverErrorText(error)).not.toMatch(CJK);
    setLang('ja');
    expect(serverErrorText(error)).toBe(messagesOf('ja')['serverError.expired']);
  });
});

describe('按说法判断的几处逻辑（各语言都成立）', () => {
  const member = (id: string, role: CastMember['role']): CastMember => ({ id, name: id, role, available: true });

  it('“用默认替身代替”的提示在各语言里都含 cast.standInMarker，isStandInNotice 认得出；其他提示不会被认成它', () => {
    for (const lang of LANGS) {
      setLang(lang);
      const cast = assignLevelCast([member('p', 'player'), { ...member('u', 'none'), available: false }], [
        { personId: 'gone', role: 'companion' },
        { personId: 'u', role: 'guard' },
      ], 1, 12);
      expect(cast.notices, lang).toHaveLength(2);
      expect(cast.notices.every((n) => isStandInNotice(n)), lang).toBe(true);
      const other = assignLevelCast([member('p', 'player'), member('q', 'player')], [], 0, 12);
      expect(other.notices.some((n) => isStandInNotice(n)), lang).toBe(false);
    }
  });

  it('没有骨骼的模型把“绑定姿态”说成“静止姿态”：各语言里用到它的提示都含 pose.bind 的原词', () => {
    for (const lang of LANGS) {
      setLang(lang);
      const notice = t('clip.noIdleBind');
      expect(notice, lang).toContain(t('pose.bind'));
      expect(poseWording(notice, false), lang).toContain(t('pose.static'));
      expect(poseWording(notice, false), lang).not.toContain(t('pose.bind'));
      expect(poseWording(notice, true), lang).toBe(notice);
    }
  });
});
