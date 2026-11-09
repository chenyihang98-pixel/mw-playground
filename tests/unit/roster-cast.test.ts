// 分工的分配规则（P4，纯函数）：主角唯一、同伴上限、守卫按顺序分配（人物不够、人物多出）、
// 主角兼守卫同时出现在两个位置、同屏实例上限、没恢复的人物不出场。

import { describe, expect, it } from 'vitest';
import { assignCast, type CastMember } from '../../src/roster/cast';
import { ROSTER_LIMITS, type Role } from '../../src/roster/config';

function member(id: string, role: Role, available = true): CastMember {
  return { id, name: id, role, available };
}

describe('分配规则', () => {
  it('没有主角时用默认小人（player 为 null）；守卫都用默认小人', () => {
    expect(assignCast([member('a', 'none')], 2, 12)).toEqual({ player: null, guards: [null, null], companions: [], notices: [] });
  });

  it('主角唯一：存储里意外有两个主角时只取名册里靠前的一个，并提示', () => {
    const cast = assignCast([member('a', 'player'), member('b', 'playerGuard')], 1, 12);
    expect(cast.player).toBe('a');
    expect(cast.guards).toEqual(['b']); // b 仍按守卫出场
    expect(cast.notices.join()).toContain('主角只能有一个');
  });

  it('同伴最多 3 个：多出的不出场并提示', () => {
    expect(ROSTER_LIMITS.maxCompanions).toBe(3);
    const cast = assignCast(['a', 'b', 'c', 'd'].map((id) => member(id, 'companion')), 0, 12);
    expect(cast.companions).toEqual(['a', 'b', 'c']);
    expect(cast.notices.join()).toContain('“d”');
  });

  it('守卫按名册顺序依次分给关卡里按顺序排列的守卫；人物不够时剩下的守卫用默认小人', () => {
    const cast = assignCast([member('a', 'none'), member('g1', 'guard'), member('c', 'companion')], 3, 12);
    expect(cast.guards).toEqual(['g1', null, null]);
    expect(cast.notices).toEqual([]);
  });

  it('守卫人物多出来：多出的不出场，并提示', () => {
    const cast = assignCast([member('g1', 'guard'), member('g2', 'guard'), member('g3', 'guard')], 2, 12);
    expect(cast.guards).toEqual(['g1', 'g2']);
    expect(cast.notices).toEqual(['关卡里只有 2 个守卫：“g3” 不出场']);
    // 关卡里没有守卫
    expect(assignCast([member('g1', 'guard')], 0, 12)).toMatchObject({ guards: [], notices: ['关卡里只有 0 个守卫：“g1” 不出场'] });
  });

  it('主角兼守卫同时出现在主角和守卫的位置上，守卫分配时和其他守卫一起按名册顺序排', () => {
    const cast = assignCast([member('g1', 'guard'), member('pg', 'playerGuard'), member('g2', 'guard')], 2, 12);
    expect(cast.player).toBe('pg');
    expect(cast.guards).toEqual(['g1', 'pg']);
    expect(cast.notices).toEqual(['关卡里只有 2 个守卫：“g2” 不出场']);
  });

  it('同屏实例上限：按主角 → 守卫 → 同伴占用，多出的守卫或同伴不出场，并提示', () => {
    const members = [member('p', 'playerGuard'), member('g1', 'guard'), member('c1', 'companion'), member('c2', 'companion')];
    // 主角 1 + 守卫 2（主角兼守卫占两个实例）= 3，同伴只剩 1 个名额
    const cast = assignCast(members, 2, 4);
    expect(cast).toEqual({ player: 'p', guards: ['p', 'g1'], companions: ['c1'], notices: ['同屏的导入实例最多 4 个：“c2” 不出场'] });
    const tight = assignCast(members, 2, 2);
    expect(tight.guards).toEqual(['p', null]);
    expect(tight.companions).toEqual([]);
    expect(tight.notices).toEqual(['同屏的导入实例最多 2 个：“g1”、“c1”、“c2” 不出场']);
  });

  it('没恢复的人物不出场，并提示', () => {
    const cast = assignCast([member('p', 'player', false), member('g', 'guard', false), member('x', 'none', false)], 1, 12);
    expect(cast.player).toBeNull();
    expect(cast.guards).toEqual([null]);
    expect(cast.notices).toEqual(['“p”、“g” 没有恢复，不出场']);
  });
});
