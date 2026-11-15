// 已保存的关卡（P5）：保存和重玩（不重新生成、不重算时间）、版本号、认不出和损坏的记录、存储失败；
// 内置关卡（P2 原样保留，新增的冻结关卡通过硬检查）；关卡的出场人物；视觉预设；关卡生效的规则。

import { readFileSync } from 'node:fs';
import { Scene, DirectionalLight, HemisphereLight, Color, Mesh, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { levelList, resolveLevelPackage } from '../../src/game/boot';
import { loadBuiltinLevel } from '../../src/game/level/builtin';
import { checkLevel } from '../../src/game/level/gen/checker';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { produceLevel } from '../../src/game/level/gen/pipeline';
import { decideTimeLimit } from '../../src/game/level/gen/timing';
import { FALLBACK_LEVEL_ID, GENERATED_LEVELS } from '../../src/game/level/generatedLevels';
import { builtinEntries, builtinPackage, fallbackPackage } from '../../src/game/levels/catalog';
import { packageOfProduced, type LevelPackage } from '../../src/game/levels/package';
import { SAVED_FORMAT, SavedLevels, decodeSavedLevel } from '../../src/game/levels/saved';
import { Environment } from '../../src/game/render/environment';
import { LevelView, THEME_COLORS } from '../../src/game/render/levelView';
import { createInitialState, startGame, stepGame, NO_INPUT } from '../../src/game/sim';
import { assignLevelCast, type CastMember } from '../../src/roster/cast';
import { MemoryRosterStore } from '../../src/roster/store';
import { brief } from '../helpers/levels';

/** 源文件里 import 的模块路径。 */
function importsOf(path: string): string[] {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  return [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
}

function produced(seed = 'saved-1', overrides = {}): LevelPackage {
  const result = produceLevel(brief({ tier: 'small', collectibles: 3, guards: 1, platforms: 1, ...overrides }), seed);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return packageOfProduced(result.level);
}

describe('保存和重玩', () => {
  it('保存规范化后的说明书和种子、版本、最终布局和视觉预设、生效的规则、来源；读回来完全一样', async () => {
    const store = new MemoryRosterStore();
    const saved = new SavedLevels(store);
    const pkg = produced();
    const result = saved.save(pkg);
    expect(result).toEqual({ ok: true, id: pkg.layoutHash, duplicate: false });
    await saved.whenIdle();
    const record = store.data.get(pkg.layoutHash) as Record<string, unknown>;
    expect(record).toMatchObject({
      format: SAVED_FORMAT,
      version: 1,
      source: 'random',
      seed: pkg.seed,
      schemaVersion: 1,
      generatorVersion: GEN_CONFIG.generator.version,
      visual: pkg.visual,
      rules: { timeLimit: pkg.layout.timeLimit, target: pkg.layout.target, penaltySeconds: 10, cooldownSeconds: 2 },
    });
    const again = new SavedLevels(store);
    await again.load();
    const loaded = again.get(pkg.layoutHash);
    expect(loaded).toEqual({ ...pkg, key: `saved:${pkg.layoutHash}` });
    // 同一份布局再保存：不重复
    expect(again.save(pkg)).toEqual({ ok: true, id: pkg.layoutHash, duplicate: true });
  });

  it('generatorVersion 变了以后，已保存关卡加载出来的布局和 timeLimit 不变（加载不调用生成器）', async () => {
    const store = new MemoryRosterStore();
    const pkg = produced('ver');
    const first = new SavedLevels(store);
    first.save(pkg);
    await first.whenIdle();
    const record = store.data.get(pkg.layoutHash) as Record<string, unknown>;
    store.data.set(pkg.layoutHash, { ...record, generatorVersion: GEN_CONFIG.generator.version + 41 });
    const later = new SavedLevels(store);
    await later.load();
    const loaded = later.get(pkg.layoutHash);
    expect(loaded?.layout).toEqual(pkg.layout);
    expect(loaded?.rules.timeLimit).toBe(pkg.rules.timeLimit);
    expect(loaded?.generatorVersion).toBe(GEN_CONFIG.generator.version + 41);
    // 加载模块不引用生成器、生成流程和时间推算
    expect(importsOf('../../src/game/levels/saved.ts').filter((i) => /\/(generator|pipeline|timing)$/.test(i))).toEqual([]);
  });

  it('保存之后改动系数配置，已保存关卡的 timeLimit 不变', async () => {
    const store = new MemoryRosterStore();
    const pkg = produced('coef', { intent: 'normal' });
    const first = new SavedLevels(store);
    first.save(pkg);
    await first.whenIdle();
    // 换一份系数，同一条路线算出的时间限制不同了
    const changed = structuredClone<typeof GEN_CONFIG>(GEN_CONFIG);
    (changed.timing as { margin: number }).margin = 60;
    const route = produceLevel(pkg.brief, pkg.seed ?? '', { config: changed });
    expect(route.ok && route.level.timeLimit).not.toBe(pkg.rules.timeLimit);
    expect(decideTimeLimit(10, 'normal', 'small', changed)).not.toEqual(decideTimeLimit(10, 'normal', 'small'));
    const later = new SavedLevels(store);
    await later.load();
    expect(later.get(pkg.layoutHash)?.rules.timeLimit).toBe(pkg.rules.timeLimit);
    expect(later.get(pkg.layoutHash)?.layout.timeLimit).toBe(pkg.rules.timeLimit);
  });

  it('认不出的版本和损坏的记录：提示后跳过（列表里标为失败，可以删除），其余照常', async () => {
    const store = new MemoryRosterStore();
    const pkg = produced('ok');
    const first = new SavedLevels(store);
    first.save(pkg);
    await first.whenIdle();
    const record = store.data.get(pkg.layoutHash) as Record<string, unknown>;
    store.data.set('aaaaaaaaaaaaaaaa', { ...record, version: 7 });
    store.data.set('bbbbbbbbbbbbbbbb', { ...record, id: 'bbbbbbbbbbbbbbbb', layout: { broken: true } });
    store.data.set('cccccccccccccccc', { ...record, rules: { ...(record.rules as object), timeLimit: 999 } });
    const later = new SavedLevels(store);
    await later.load();
    const list = later.list();
    expect(list.map((e) => [e.id, e.status])).toEqual([
      [pkg.layoutHash, 'ready'],
      ['aaaaaaaaaaaaaaaa', 'failed'],
      ['bbbbbbbbbbbbbbbb', 'failed'],
      ['cccccccccccccccc', 'failed'],
    ]);
    expect(list[1]?.error).toContain('认不出的存储版本（7）');
    expect(list[2]?.error).toMatch(/^记录损坏/);
    expect(list[3]?.error).toContain('不一致');
    expect(later.notices.filter((n) => n.includes('已跳过'))).toHaveLength(3);
    await later.remove('aaaaaaaaaaaaaaaa');
    expect(store.data.has('aaaaaaaaaaaaaaaa')).toBe(false);
    expect(decodeSavedLevel(null)).toEqual({ ok: false, error: '记录损坏：不是已保存的关卡' });
  });

  it('存储失败：给出提示，本次会话里的列表照常可用', async () => {
    const store = new MemoryRosterStore();
    store.failures = { load: new Error('禁止'), put: new Error('禁止') };
    const saved = new SavedLevels(store);
    await saved.load();
    expect(saved.storageProblem).toContain('读不了浏览器里保存的关卡（禁止）');
    const pkg = produced('mem');
    expect(saved.save(pkg).ok).toBe(true);
    await saved.whenIdle();
    expect(saved.get(pkg.layoutHash)?.layout).toEqual(pkg.layout);
    expect(store.data.size).toBe(0);
  });

  it('内置关卡不能另存（只有由说明书生成的关卡才保存）', () => {
    const saved = new SavedLevels(new MemoryRosterStore());
    const meadow = builtinPackage('meadow');
    expect(meadow && saved.save(meadow)).toEqual({ ok: false, error: '只有由说明书生成的关卡才能保存' });
  });
});

describe('内置关卡', () => {
  it('P2 的三张地图原样保留，视觉预设 grass / day / clear；默认仍进入 meadow；测试钩子的关卡列表不变', () => {
    for (const id of ['meadow', 'test-a', 'test-b']) {
      const pkg = builtinPackage(id);
      expect(pkg?.layout).toEqual(loadBuiltinLevel(id));
      expect(pkg?.visual).toEqual({ theme: 'grass', time: 'day', weather: 'clear' });
      expect(pkg?.rules.timeLimit).toBe(loadBuiltinLevel(id)?.timeLimit);
    }
    expect(resolveLevelPackage(null).key).toBe('builtin:meadow');
    expect(resolveLevelPackage('test-a').key).toBe('builtin:test-a');
    expect(levelList().map((l) => l.id)).toEqual(['meadow', 'test-a', 'test-b']);
  });

  it('新增至少 3 关由生成器做出的冻结关卡：都通过硬检查，第 1 关是回退关卡', () => {
    expect(GENERATED_LEVELS.length).toBeGreaterThanOrEqual(3);
    expect(builtinEntries().filter((e) => e.kind === 'generated').map((e) => e.id)).toEqual(GENERATED_LEVELS.map((l) => l.id));
    for (const frozen of GENERATED_LEVELS) {
      const pkg = builtinPackage(frozen.id);
      if (!pkg?.brief) throw new Error(frozen.id);
      const report = checkLevel(pkg.layout, { brief: pkg.brief });
      expect(report.problems, frozen.id).toEqual([]);
      expect(pkg.rules.timeLimit).toBe(pkg.layout.timeLimit);
      expect(pkg.visual).toEqual(pkg.brief.visual);
    }
    expect(FALLBACK_LEVEL_ID).toBe(GENERATED_LEVELS[0]?.id);
    expect(fallbackPackage().key).toBe(`builtin:${FALLBACK_LEVEL_ID}`);
    expect(new Set(GENERATED_LEVELS.map((l) => `${l.brief.visual.theme}/${l.brief.visual.time}/${l.brief.visual.weather}`)).size).toBe(3);
  });

  it('以冻结的布局为准：加载内置关卡不调用生成器', () => {
    expect(importsOf('../../src/game/levels/catalog.ts').filter((i) => /\/(generator|pipeline|timing)$/.test(i))).toEqual([]);
  });
});

describe('关卡的出场人物', () => {
  const member = (id: string, role: CastMember['role'], available = true): CastMember => ({ id, name: id, role, available });

  it('说明书列了出场人物：同伴和守卫按说明书（守卫按列出的顺序），主角按名册', () => {
    const members = [member('p', 'player'), member('a', 'guard'), member('b', 'none'), member('c', 'companion')];
    const cast = assignLevelCast(members, [{ personId: 'b', role: 'guard' }, { personId: 'a', role: 'companion' }], 2, 12);
    expect(cast).toMatchObject({ player: 'p', guards: ['b', null], companions: ['a'], standIns: [], notices: [] });
  });

  it('没列出场人物：按名册的分工', () => {
    const members = [member('p', 'player'), member('a', 'guard'), member('c', 'companion')];
    expect(assignLevelCast(members, [], 1, 12)).toMatchObject({ player: 'p', guards: ['a'], companions: ['c'] });
  });

  describe('F3：出场人物以说明书为准（castIsExplicit，工坊生成的关卡）', () => {
    const roster = [member('p', 'player'), member('c', 'companion'), member('g', 'guard')];

    it('说明书没列出场人物：主角是名册的主角，没有同伴，守卫全部是默认小人', () => {
      const cast = assignLevelCast(roster, [], 2, 12, { castIsExplicit: true });
      expect(cast).toEqual({ player: 'p', guards: [null, null], companions: [], notices: [], standIns: [] });
    });

    it('同样的名册，castIsExplicit 为 false（或不传）：和以前一样按名册的分工', () => {
      const expected = { player: 'p', guards: ['g', null], companions: ['c'] };
      expect(assignLevelCast(roster, [], 2, 12, { castIsExplicit: false })).toMatchObject(expected);
      expect(assignLevelCast(roster, [], 2, 12)).toMatchObject(expected);
      expect(assignLevelCast(roster, [], 2, 12, { castIsExplicit: false })).toEqual(assignLevelCast(roster, [], 2, 12));
    });

    it('名册里有“主角兼守卫”的人：这一关只当主角，守卫全部是默认小人', () => {
      const members = [member('pg', 'playerGuard'), member('c', 'companion')];
      const cast = assignLevelCast(members, [], 1, 12, { castIsExplicit: true });
      expect(cast).toMatchObject({ player: 'pg', guards: [null], companions: [] });
      // 对比：不以说明书为准时，他同时当主角和守卫
      expect(assignLevelCast(members, [], 1, 12)).toMatchObject({ player: 'pg', guards: ['pg'], companions: ['c'] });
    });

    it('说明书列了出场人物：结果和 castIsExplicit 为 false 时完全相同（含默认替身、守卫和同屏上限的提示）', () => {
      const members = [member('p', 'player'), member('a', 'guard'), member('b', 'none'), member('c', 'companion'), member('d', 'none', false)];
      const cases: { levelCast: { personId: string; role: 'companion' | 'guard' }[]; guards: number; capacity: number }[] = [
        { levelCast: [{ personId: 'b', role: 'guard' }, { personId: 'a', role: 'companion' }], guards: 2, capacity: 12 },
        { levelCast: [{ personId: 'gone', role: 'guard' }, { personId: 'd', role: 'companion' }], guards: 1, capacity: 12 },
        { levelCast: [{ personId: 'a', role: 'guard' }, { personId: 'b', role: 'guard' }], guards: 1, capacity: 12 },
        { levelCast: [{ personId: 'a', role: 'guard' }, { personId: 'c', role: 'companion' }], guards: 1, capacity: 2 },
      ];
      for (const c of cases) {
        expect(assignLevelCast(members, c.levelCast, c.guards, c.capacity, { castIsExplicit: true })).toEqual(assignLevelCast(members, c.levelCast, c.guards, c.capacity, { castIsExplicit: false }));
      }
    });

    it('同屏实例上限照常：主角占了唯一的名额', () => {
      expect(assignLevelCast(roster, [], 2, 1, { castIsExplicit: true })).toMatchObject({ player: 'p', guards: [null, null], companions: [] });
      expect(assignLevelCast(roster, [], 2, 0, { castIsExplicit: true })).toMatchObject({ player: null, notices: ['同屏的导入实例最多 0 个：“p” 不出场'] });
    });
  });

  it('列出的人物已被删除：用默认替身代替，并给出提示', () => {
    const cast = assignLevelCast([member('p', 'player')], [{ personId: 'gone-guard', role: 'guard' }, { personId: 'gone-friend', role: 'companion' }], 1, 12);
    expect(cast.guards).toEqual([null]);
    expect(cast.companions).toEqual(['stand-in:0']);
    expect(cast.standIns).toEqual(['stand-in:0']);
    expect(cast.notices).toEqual(['出场人物（ID gone-gua）已不在名册里，用默认替身代替', '出场人物（ID gone-fri）已不在名册里，用默认替身代替']);
  });
});

describe('视觉预设', () => {
  it('每种取值在场景里看得出区别：天空、光、雾、雨、地面颜色', () => {
    const scene = new Scene();
    scene.add(new HemisphereLight(), new DirectionalLight());
    const env = new Environment(scene);
    const looks = new Set<string>();
    for (const time of ['day', 'dusk', 'night'] as const) {
      env.apply({ theme: 'grass', time, weather: 'clear' });
      const s = env.snapshot();
      looks.add(`${s.sky}/${String(s.sunIntensity)}`);
      expect(s.fog).toBeNull();
      expect(s.rain).toBe(false);
    }
    expect(looks.size).toBe(3);
    env.apply({ theme: 'grass', time: 'day', weather: 'fog' });
    expect(env.snapshot().fog).toEqual({ near: 6, far: 34 });
    env.apply({ theme: 'grass', time: 'day', weather: 'rain' });
    expect(env.snapshot()).toMatchObject({ rain: true, fog: { near: 14, far: 70 } });
    // 雨滴真的在动：渲染用的坐标随时间变化（第 1 轮审查）
    const before = Float32Array.from(env.rainPositions());
    env.update(0.1, { x: 0, y: 0, z: 0 });
    const after = env.rainPositions();
    let moved = 0;
    for (let i = 1; i < after.length; i += 3) if (Math.abs((after[i] ?? 0) - (before[i] ?? 0)) > 1e-6) moved++;
    expect(moved).toBe(after.length / 3);
    // 只有 y 变了（下落），x、z 不变
    for (let i = 0; i < after.length; i += 3) {
      expect(after[i]).toBe(before[i]);
      expect(after[i + 2]).toBe(before[i + 2]);
    }
    // 不下雨时不动
    env.apply({ theme: 'grass', time: 'day', weather: 'clear' });
    const still = Float32Array.from(env.rainPositions());
    env.update(0.1, { x: 0, y: 0, z: 0 });
    expect(Array.from(env.rainPositions())).toEqual(Array.from(still));
    const grounds = (['grass', 'sand', 'snow'] as const).map((theme) => {
      const view = new LevelView(new Scene(), createInitialState(loadBuiltinLevel('test-a') ?? (null as never)), theme);
      const ground = view.group.getObjectByName('ground') as Mesh;
      return (ground.material as MeshStandardMaterial).color.getHex();
    });
    expect(grounds).toEqual([THEME_COLORS.grass.ground, THEME_COLORS.sand.ground, THEME_COLORS.snow.ground]);
    expect(new Color(THEME_COLORS.sand.ground).getHex()).not.toBe(new Color(THEME_COLORS.snow.ground).getHex());
  });
});

describe('关卡生效的规则', () => {
  it('守卫扣时按关卡保存的规则（默认取 SPEC）', () => {
    const level = loadBuiltinLevel('test-b');
    if (!level) throw new Error('test-b');
    const rules = { penaltySeconds: 3, cooldownSeconds: 1 };
    let state = startGame(createInitialState(level, [], rules));
    for (let i = 0; i < 300 && state.hits.length === 0; i++) state = stepGame(state, NO_INPUT);
    const hit = state.hits[0];
    if (!hit) throw new Error('应该被守卫碰到');
    expect(hit.timeLeftAfter).toBeCloseTo(level.timeLimit - hit.at - 3, 6);
    expect(state.hitCooldown).toBeLessThanOrEqual(1);
  });
});
