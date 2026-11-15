// 测试快照里的导入实例列表（F2）：CastDirector.importedInstances 只读地列出场景里的每个导入实例。
// 主角兼守卫时有两项（主角、守卫各一个独立的实例），骨骼的 uuid 互不相交；数量等于实例登记里的数量。

import { describe, expect, it } from 'vitest';
import { Roster } from '../../src/roster/roster';
import { MemoryRosterStore } from '../../src/roster/store';
import { layout } from '../helpers/game';
import { Stage, addOrThrow, distinctGlb, importFixtureForRoster, importForRoster } from '../helpers/roster';

describe('importedInstances（测试快照）', () => {
  it('主角兼守卫：两项（主角、守卫），根节点不同，boneUuids 互不相交；数量等于实例登记里的数量', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const stage = new Stage(roster, layout({ guards: [{ id: 'g-a', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] }] }));
    const hero = addOrThrow(roster, await importFixtureForRoster('skinned-humanoid'));
    roster.setRole(hero, 'playerGuard');

    const list = stage.director.importedInstances();
    expect(list.map((i) => [i.slot, i.slotId, i.personId])).toEqual([
      ['player', null, hero],
      ['guard', 'g-a', hero],
    ]);
    expect(list).toHaveLength(stage.registry.count);
    const [player, guard] = list;
    if (!player || !guard) throw new Error('应该有两项');
    expect(player.rootUuid).not.toBe(guard.rootUuid);
    expect(player.boneUuids.length).toBeGreaterThan(0);
    expect(guard.boneUuids).toHaveLength(player.boneUuids.length);
    const shared = player.boneUuids.filter((uuid) => guard.boneUuids.includes(uuid));
    expect(shared).toEqual([]);
    // 每个实例各自的动画状态
    expect(player.animator?.state).toBe('idle');
    expect(guard.animator?.state).toBe('idle');

    // 只读：再读一次结果相同，实例没有变化
    expect(stage.director.importedInstances()).toEqual(list);
    expect(stage.registry.count).toBe(2);
  });

  it('主角、守卫、同伴各一项；静态模型的 boneUuids 是空数组；默认小人不算', async () => {
    const roster = new Roster(new MemoryRosterStore());
    const stage = new Stage(
      roster,
      layout({
        guards: [
          { id: 'g-a', route: [{ x: -5, z: 5 }, { x: 5, z: 5 }] },
          { id: 'g-b', route: [{ x: -5, z: 8 }, { x: 5, z: 8 }] },
        ],
      }),
    );
    const hero = addOrThrow(roster, await importFixtureForRoster('skinned-humanoid'));
    const statue = addOrThrow(roster, await importFixtureForRoster('static-mesh'));
    const friend = addOrThrow(roster, await importForRoster('friend.glb', distinctGlb(91)));
    roster.setRole(hero, 'player');
    roster.setRole(statue, 'guard');
    roster.setRole(friend, 'companion');

    const list = stage.director.importedInstances();
    expect(list.map((i) => [i.slot, i.slotId, i.personId])).toEqual([
      ['player', null, hero],
      ['guard', 'g-a', statue],
      ['companion', friend, friend],
    ]);
    // 第二个守卫用默认小人，不在列表里
    expect(stage.director.snapshot().guards[1]?.model).toBe('default');
    expect(list).toHaveLength(stage.registry.count);
    expect(list[1]?.boneUuids).toEqual([]);
    expect(new Set(list.map((i) => i.rootUuid)).size).toBe(3);
  });
});
