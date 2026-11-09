// 名册（P4）：恢复（重新走导入流程，尺寸、朝向、片段建议和手动设置一致；被拒绝的一项跳过）、加入（重复的 SHA-256、上限）、
// 分工（主角唯一、同伴上限、恢复默认主角）、删除正在使用的人物（主角、守卫、同伴）、实例独立和同屏上限。
// 存储用内存实现。

import { describe, expect, it, vi } from 'vitest';
import { buildFixture } from '../../src/asset/fixtures';
import { sha256Hex } from '../../src/import/asset';
import * as pipeline from '../../src/import/pipeline';
import { ROSTER_LIMITS } from '../../src/roster/config';
import { encodeRecord } from '../../src/roster/format';
import { ROSTER_READING_MESSAGE, Roster } from '../../src/roster/roster';
import { MemoryRosterStore, type RosterStore, type StoredEntry } from '../../src/roster/store';
import { layout } from '../helpers/game';
import { Stage, addOrThrow, distinctGlb, importFixtureForRoster, importForRoster } from '../helpers/roster';

/** 读出记录要等 gate 放行的存储（模拟 IndexedDB 读得慢）。 */
class GatedStore implements RosterStore {
  constructor(
    private readonly inner: MemoryRosterStore,
    private readonly gate: Promise<void>,
  ) {}

  async loadAll(): Promise<StoredEntry[]> {
    await this.gate;
    return this.inner.loadAll();
  }

  put(key: string, value: unknown): Promise<void> {
    return this.inner.put(key, value);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 恢复后要和加入时一致的部分。 */
function comparable(roster: Roster) {
  return roster.snapshot().entries.map((e) => ({
    key: e.key,
    displayName: e.displayName,
    role: e.role,
    order: e.order,
    displayHeight: e.displayHeight,
    quarterTurns: e.quarterTurns,
    size: e.size,
    slots: e.slots,
    manual: e.manual,
  }));
}

describe('恢复', () => {
  it('同一个文件和设置：恢复后尺寸、朝向、片段建议和手动设置都和加入时一致；恢复时重新走 importModel', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    const humanoid = await importFixtureForRoster('skinned-humanoid');
    const moving = await importFixtureForRoster('root-motion');
    const statue = await importFixtureForRoster('static-mesh');
    const hKey = addOrThrow(first, humanoid);
    const mKey = addOrThrow(first, moving);
    const sKey = addOrThrow(first, statue);
    // 加入之后在导入卡片上继续修改设置
    humanoid.asset.setDisplayHeight(2.05);
    humanoid.asset.rotateQuarter(-1);
    humanoid.asset.setPurpose(2, 'walk');
    humanoid.asset.setPlayback(0, 'once');
    const motionIndex = moving.asset.rootMotion.findIndex((m) => m.kind === 'identified' && m.flagged);
    expect(motionIndex).toBeGreaterThanOrEqual(0);
    moving.asset.setMotionLocked(motionIndex, true);
    statue.asset.rotateQuarter(1);
    first.rename(sKey, '雕像');
    first.setRole(hKey, 'player');
    first.setRole(mKey, 'companion');
    first.setRole(sKey, 'guard');
    await first.whenIdle();
    const before = comparable(first);
    expect(before[0]).toMatchObject({ displayHeight: 2.05, quarterTurns: 3, manual: { purposes: { [`${hKey}#2`]: 'walk' }, playbacks: { [`${hKey}#0`]: 'once' } } });
    expect(before[1]?.manual?.lockedMotion).toEqual([`${mKey}#${String(motionIndex)}`]);

    const importer = vi.spyOn(pipeline, 'importModel');
    const second = new Roster(store, pipeline.importModel);
    await second.restore();
    expect(importer).toHaveBeenCalledTimes(3);
    importer.mockRestore();
    expect(comparable(second)).toEqual(before);
    expect(second.snapshot().entries.every((e) => e.status === 'ready')).toBe(true);
    // 恢复的是新加载的对象，不是原来的
    expect(second.assetOf(hKey)).not.toBe(humanoid.asset);
    expect(second.assetOf(hKey)?.decisions()).toEqual(humanoid.asset.decisions());
    expect(second.assetOf(mKey)?.isMotionLocked(motionIndex)).toBe(true);
    expect(second.assetOf(mKey)?.lockedResidual(motionIndex)).toBeCloseTo(0, 9);
  });

  it('某一项恢复时被拒绝：给出提示，跳过那一项（记录保留，可以删除），其余照常恢复', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    const a = await importForRoster('a.glb', distinctGlb(10));
    const b = await importForRoster('b.glb', distinctGlb(11));
    const aKey = addOrThrow(first, a);
    const bKey = addOrThrow(first, b);
    first.setRole(bKey, 'player');
    await first.whenIdle();
    // 再加一条格式正确、但文件已损坏的记录（排在最后）
    const broken = buildFixture('corrupt-truncated');
    const brokenSha = await sha256Hex(broken);
    store.data.set(
      brokenSha,
      encodeRecord({
        id: brokenSha,
        sha256: brokenSha,
        fileName: 'broken.glb',
        displayName: '坏文件',
        order: 5,
        role: 'guard',
        settings: { displayHeight: 1.75, quarterTurns: 0, purposes: {}, playbacks: {}, lockedMotion: [] },
        file: new Blob([broken]),
      }),
    );
    const second = new Roster(store);
    await second.restore();
    const snap = second.snapshot();
    expect(snap.entries.map((e) => [e.key, e.status])).toEqual([
      [aKey, 'ready'],
      [bKey, 'ready'],
      [brokenSha, 'failed'],
    ]);
    expect(snap.entries[2]?.error).toContain('恢复失败：文件损坏');
    expect(second.members().find((m) => m.id === bKey)).toMatchObject({ role: 'player', available: true });
    expect(snap.notices.join()).toContain('“坏文件”恢复失败');
    expect(second.members().find((m) => m.id === brokenSha)?.available).toBe(false);
    expect(second.setRole(brokenSha, 'player')).toEqual({ ok: false, error: '这一项没有恢复，只能删除' });
    await second.remove(brokenSha);
    expect(store.data.has(brokenSha)).toBe(false);
    expect(second.size).toBe(2);
  });

  it('保存的文件内容和记录的 SHA-256 不一致：恢复失败，跳过', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    const a = await importForRoster('a.glb', distinctGlb(12));
    const key = addOrThrow(first, a);
    await first.whenIdle();
    const saved = store.data.get(key) as Record<string, unknown>;
    store.data.set(key, { ...saved, file: new Blob([distinctGlb(13)]) });
    const second = new Roster(store);
    await second.restore();
    expect(second.snapshot().entries[0]).toMatchObject({ status: 'failed', error: '恢复失败：文件内容与记录的 SHA-256 不一致' });
  });
});

describe('加入', () => {
  it('同一个文件（SHA-256 相同）再次加入：不新增，提示“已在名册里”，并标出那一项', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const first = await importForRoster('x.glb', distinctGlb(20));
    const again = await importForRoster('x-copy.glb', distinctGlb(20)); // 内容相同、文件名不同
    const key = addOrThrow(roster, first);
    const result = roster.add(again.asset, again.file);
    expect(result).toEqual({ ok: false, reason: 'duplicate', error: '“x.glb”已在名册里', key });
    expect(roster.size).toBe(1);
    expect(roster.snapshot().highlight).toBe(key);
    expect(roster.snapshot().entries[0]?.highlighted).toBe(true);
    expect(roster.snapshot().notices).toContain('“x.glb”已在名册里');
    expect(roster.owns(again.asset)).toBe(false);
  });

  it(`名册最多 ${String(ROSTER_LIMITS.maxPeople)} 个人物：到了上限就不能再加入，给出提示`, async () => {
    expect(ROSTER_LIMITS.maxPeople).toBe(20);
    const roster = new Roster(new MemoryRosterStore());
    for (let i = 0; i < ROSTER_LIMITS.maxPeople; i++) addOrThrow(roster, await importForRoster(`p${String(i)}.glb`, distinctGlb(100 + i)));
    const extra = await importForRoster('extra.glb', distinctGlb(999));
    expect(roster.add(extra.asset, extra.file)).toEqual({ ok: false, reason: 'full', error: '名册已满（最多 20 个人物），不能再加入', key: null });
    expect(roster.size).toBe(20);
    expect(roster.snapshot().notices).toContain('名册已满（最多 20 个人物），不能再加入');
  });

  it('新加入的人物分工为“不出场”，显示名默认是文件名，按加入的先后排列', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push(addOrThrow(roster, await importForRoster(`n${String(i)}.glb`, distinctGlb(30 + i))));
    expect(roster.snapshot().entries.map((e) => [e.key, e.displayName, e.role, e.order])).toEqual(keys.map((k, i) => [k, `n${String(i)}.glb`, 'none', i]));
  });
});

describe('恢复期间的加入和分工（第 1 轮审查）', () => {
  it('存储里的记录读出来之前不能加入：已有 20 人时不会加入第 21 人，也不会产生重复的顺序', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    for (let i = 0; i < ROSTER_LIMITS.maxPeople; i++) addOrThrow(first, await importForRoster(`s${String(i)}.glb`, distinctGlb(200 + i)));
    await first.whenIdle();
    const reading = gate();
    const second = new Roster(new GatedStore(store, reading.promise));
    const restoring = second.restore();
    const extra = await importForRoster('extra.glb', distinctGlb(299));
    expect(second.add(extra.asset, extra.file)).toEqual({ ok: false, reason: 'reading', error: ROSTER_READING_MESSAGE, key: null });
    expect(second.snapshot().notices).toContain(ROSTER_READING_MESSAGE);
    reading.open();
    await restoring;
    expect(second.size).toBe(20);
    expect(second.add(extra.asset, extra.file)).toMatchObject({ ok: false, reason: 'full' });
    await second.whenIdle();
    expect(store.data.size).toBe(20);
    const orders = second.snapshot().entries.map((e) => e.order);
    expect(new Set(orders).size).toBe(20);
  });

  it('记录读出来以后（人物还在恢复）可以加入：去重认得还在恢复的项，新人物排在最后；同伴上限把还在恢复的同伴也算在内', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    const idle = await importForRoster('idle.glb', distinctGlb(300));
    const friends = [await importForRoster('c1.glb', distinctGlb(301)), await importForRoster('c2.glb', distinctGlb(302)), await importForRoster('c3.glb', distinctGlb(303))];
    const idleKey = addOrThrow(first, idle);
    const friendKeys = friends.map((f) => addOrThrow(first, f));
    for (const key of friendKeys) expect(first.setRole(key, 'companion')).toEqual({ ok: true });
    await first.whenIdle();

    // 第一个人物（不出场）照常恢复，后面三个同伴的恢复卡在 importing 上
    const importing = gate();
    let calls = 0;
    const second = new Roster(store, async (source) => {
      calls++;
      if (calls > 1) await importing.promise;
      return pipeline.importModel(source);
    });
    const restoring = second.restore();
    await vi.waitFor(() => {
      expect(second.snapshot().entries[0]?.status).toBe('ready');
    });
    expect(second.snapshot().entries.slice(1).map((e) => e.status)).toEqual(['loading', 'loading', 'loading']);
    // 第四个同伴设不上；还在恢复的项不能改分工
    expect(second.setRole(idleKey, 'companion')).toEqual({ ok: false, error: '同伴最多 3 个' });
    expect(second.statusOf(friendKeys[0] ?? '')).toBe('loading');
    expect(second.setRole(friendKeys[0] ?? '', 'guard')).toEqual({ ok: false, error: '这一项还在恢复，请稍后再试' });
    // 去重认得还在恢复的项；新人物排在最后
    const again = await importForRoster('c1-again.glb', distinctGlb(301));
    expect(second.add(again.asset, again.file)).toMatchObject({ ok: false, reason: 'duplicate', key: friendKeys[0] });
    const newcomer = await importForRoster('new.glb', distinctGlb(304));
    const newKey = addOrThrow(second, newcomer);
    importing.open();
    await restoring;
    await second.whenIdle();
    const snap = second.snapshot();
    expect(snap.entries.map((e) => [e.key, e.role, e.order, e.status])).toEqual([
      [idleKey, 'none', 0, 'ready'],
      ...friendKeys.map((k, i) => [k, 'companion', i + 1, 'ready']),
      [newKey, 'none', 4, 'ready'],
    ]);
  });
});

describe('分工', () => {
  it('主角唯一：设新主角时原来的主角（包括主角兼守卫）改为不出场；恢复默认主角', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const a = addOrThrow(roster, await importForRoster('a.glb', distinctGlb(40)));
    const b = addOrThrow(roster, await importForRoster('b.glb', distinctGlb(41)));
    roster.setRole(a, 'playerGuard');
    roster.setRole(b, 'player');
    expect(roster.roleOf(a)).toBe('none');
    expect(roster.roleOf(b)).toBe('player');
    expect(roster.snapshot().notices).toContain('“a.glb”不再是主角，改为不出场');
    roster.restoreDefaultPlayer();
    expect(roster.roleOf(b)).toBe('none');
  });

  it('同伴最多 3 个：第 4 个设不上，给出提示', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(addOrThrow(roster, await importForRoster(`c${String(i)}.glb`, distinctGlb(50 + i))));
    for (const key of keys.slice(0, 3)) expect(roster.setRole(key, 'companion')).toEqual({ ok: true });
    expect(roster.setRole(keys[3] ?? '', 'companion')).toEqual({ ok: false, error: '同伴最多 3 个' });
    expect(roster.roleOf(keys[3] ?? '')).toBe('none');
  });

  it('改名：去掉首尾空白；空名和太长的名字不接受', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const key = addOrThrow(roster, await importForRoster('r.glb', distinctGlb(60)));
    expect(roster.rename(key, '  新名字  ')).toEqual({ ok: true });
    expect(roster.nameOf(key)).toBe('新名字');
    expect(roster.rename(key, '   ')).toEqual({ ok: false, error: '显示名不能为空' });
    expect(roster.rename(key, 'x'.repeat(61)).ok).toBe(false);
  });
});

describe('出场和删除', () => {
  async function stageWithThree() {
    const roster = new Roster(new MemoryRosterStore());
    const level = layout({ guards: [{ id: 'g-a', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] }, { id: 'g-b', route: [{ x: -5, z: 8 }, { x: 5, z: 8 }] }] });
    const stage = new Stage(roster, level);
    const hero = await importFixtureForRoster('skinned-humanoid');
    const guard = await importForRoster('guard.glb', distinctGlb(70));
    const friend = await importFixtureForRoster('node-animation');
    const keys = { hero: addOrThrow(roster, hero), guard: addOrThrow(roster, guard), friend: addOrThrow(roster, friend) };
    roster.setRole(keys.hero, 'player');
    roster.setRole(keys.guard, 'guard');
    roster.setRole(keys.friend, 'companion');
    return { roster, stage, keys, assets: { hero: hero.asset, guard: guard.asset, friend: friend.asset } };
  }

  it('主角、守卫、同伴各自有独立的实例（不共享骨骼和 mixer），计入同屏上限', async () => {
    const { stage, keys } = await stageWithThree();
    const cast = stage.director.snapshot();
    expect(cast.player).toEqual({ personId: keys.hero, model: 'imported' });
    expect(cast.guards).toEqual([
      { guardId: 'g-a', personId: keys.guard, model: 'imported' },
      { guardId: 'g-b', personId: null, model: 'default' },
    ]);
    expect(cast.companions).toEqual([{ personId: keys.friend, model: 'imported' }]);
    expect(stage.state.companions.map((c) => c.id)).toEqual([keys.friend]);
    expect(stage.registry.count).toBe(3);
  });

  it('主角兼守卫：主角和守卫的位置上各有一个独立的实例', async () => {
    const { roster, stage, keys } = await stageWithThree();
    roster.setRole(keys.hero, 'playerGuard');
    const cast = stage.director.snapshot();
    expect(cast.player.personId).toBe(keys.hero);
    // 守卫按名册顺序分配：hero 先加入，排在 guard 前面
    expect(cast.guards.map((g) => g.personId)).toEqual([keys.hero, keys.guard]);
    const playerModel = stage.player.currentModel as unknown as { instance: { mixer: unknown; object: unknown } };
    const guardModel = stage.guards[0]?.currentModel as unknown as { instance: { mixer: unknown; object: unknown } };
    expect(playerModel.instance.mixer).not.toBe(guardModel.instance.mixer);
    expect(playerModel.instance.object).not.toBe(guardModel.instance.object);
    expect(stage.registry.count).toBe(4);
  });

  it('删除主角：恢复默认主角，释放它的实例和资源', async () => {
    const { roster, stage, keys, assets } = await stageWithThree();
    await roster.remove(keys.hero);
    expect(stage.director.snapshot().player).toEqual({ personId: null, model: 'default' });
    expect(stage.director.playerSnapshot().model).toBe('default');
    expect(assets.hero.isDisposed).toBe(true);
    expect(stage.registry.count).toBe(2);
  });

  it('删除守卫：那个守卫恢复默认小人；守卫的数量和路线不变', async () => {
    const { roster, stage, keys, assets } = await stageWithThree();
    const guardsBefore = stage.state.guards;
    await roster.remove(keys.guard);
    expect(stage.director.snapshot().guards.map((g) => g.model)).toEqual(['default', 'default']);
    expect(stage.state.guards).toBe(guardsBefore);
    expect(assets.guard.isDisposed).toBe(true);
    expect(stage.registry.count).toBe(2);
  });

  it('删除同伴：直接移除（场景里的视图和模拟里的同伴都没了）', async () => {
    const { roster, stage, keys, assets } = await stageWithThree();
    expect(stage.parent.children).toHaveLength(1);
    await roster.remove(keys.friend);
    expect(stage.director.snapshot().companions).toEqual([]);
    expect(stage.state.companions).toEqual([]);
    expect(stage.parent.children).toHaveLength(0);
    expect(assets.friend.isDisposed).toBe(true);
    expect(stage.registry.count).toBe(2);
  });

  it('同屏实例上限：超出时多出的同伴或守卫不出场，并给出提示', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const level = layout({ guards: [{ id: 'g-a', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] }] });
    const stage = new Stage(roster, level, 2);
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push(addOrThrow(roster, await importForRoster(`m${String(i)}.glb`, distinctGlb(80 + i))));
    roster.setRole(keys[0] ?? '', 'player');
    roster.setRole(keys[1] ?? '', 'guard');
    roster.setRole(keys[2] ?? '', 'companion');
    expect(stage.registry.count).toBe(2);
    expect(stage.director.snapshot().companions).toEqual([]);
    expect(stage.director.notices).toContain('同屏的导入实例最多 2 个：“m2.glb” 不出场');
    expect(stage.state.companions).toEqual([]);
  });
});
