// 分工的分配规则（纯函数，不依赖 three 和界面）：由名册（按加入的先后排好）算出谁出场、在哪个位置。
//
// - 主角（含主角兼守卫）最多一个；没有时用默认小人。
// - 守卫：分工为守卫或主角兼守卫的人物按名册顺序，依次分给关卡数据里按顺序排列的守卫。人物不够时剩下的守卫用默认小人；
//   人物多出来时多出的不出场，并给出提示。守卫的数量和路线不变，只换外观。
// - 同伴最多 ROSTER_LIMITS.maxCompanions 个。
// - 同屏实例上限（capacity）：按主角 → 守卫 → 同伴的顺序占用，超出时多出的守卫或同伴不出场，并给出提示。
//   主角兼守卫在主角和守卫的位置上各占一个实例。
// - 恢复失败（available = false）的人物不出场。

import { ROLE_LABELS, ROSTER_LIMITS, isGuardRole, isPlayerRole, type Role } from './config';

export interface CastMember {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** 已经加载好、可以出场。 */
  readonly available: boolean;
}

export interface Cast {
  readonly player: string | null;
  /** 关卡里第 i 个守卫用的人物（null 表示默认小人）。长度等于关卡里的守卫数。 */
  readonly guards: readonly (string | null)[];
  readonly companions: readonly string[];
  readonly notices: readonly string[];
}

function names(members: readonly CastMember[]): string {
  return members.map((m) => `“${m.name}”`).join('、');
}

export function assignCast(members: readonly CastMember[], guardCount: number, capacity: number): Cast {
  const notices: string[] = [];
  const ready = members.filter((m) => m.available);
  const unavailable = members.filter((m) => !m.available && m.role !== 'none');
  if (unavailable.length > 0) notices.push(`${names(unavailable)} 没有恢复，不出场`);
  let free = Math.max(0, capacity);
  const dropped: CastMember[] = [];

  const players = ready.filter((m) => isPlayerRole(m.role));
  if (players.length > 1) notices.push(`主角只能有一个：${names(players.slice(1))} 不作为主角出场`);
  const playerMember = players[0] ?? null;
  let player: string | null = null;
  if (playerMember) {
    if (free > 0) {
      player = playerMember.id;
      free--;
    } else {
      dropped.push(playerMember);
    }
  }

  const guardMembers = ready.filter((m) => isGuardRole(m.role));
  const guards: (string | null)[] = Array.from({ length: Math.max(0, guardCount) }, () => null);
  guardMembers.forEach((member, i) => {
    if (i >= guards.length) return;
    if (free > 0) {
      guards[i] = member.id;
      free--;
    } else {
      dropped.push(member);
    }
  });
  const extraGuards = guardMembers.slice(guards.length);
  if (extraGuards.length > 0) {
    notices.push(`关卡里只有 ${String(guards.length)} 个守卫：${names(extraGuards)} 不出场`);
  }

  const companionMembers = ready.filter((m) => m.role === 'companion');
  const companions: string[] = [];
  companionMembers.forEach((member, i) => {
    if (i >= ROSTER_LIMITS.maxCompanions) return;
    if (free > 0) {
      companions.push(member.id);
      free--;
    } else {
      dropped.push(member);
    }
  });
  const extraCompanions = companionMembers.slice(ROSTER_LIMITS.maxCompanions);
  if (extraCompanions.length > 0) {
    notices.push(`${ROLE_LABELS.companion}最多 ${String(ROSTER_LIMITS.maxCompanions)} 个：${names(extraCompanions)} 不出场`);
  }
  if (dropped.length > 0) {
    notices.push(`同屏的导入实例最多 ${String(capacity)} 个：${names(dropped)} 不出场`);
  }
  return { player, guards, companions, notices };
}
