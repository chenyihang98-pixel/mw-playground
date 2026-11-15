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
  /** 用默认替身出场的同伴（P5：关卡列出的人物已不在名册里）。这些 id 不是名册里的人物。 */
  readonly standIns?: readonly string[];
}

/** 关卡说明书里列出的出场人物（P5）。 */
export interface LevelCastEntry {
  readonly personId: string;
  readonly role: 'companion' | 'guard';
}

/** 关卡分配的选项（F3）。 */
export interface LevelCastOptions {
  /**
   * 出场人物以说明书为准，空也算（工坊生成的关卡）。为 true 时说明书没列出场人物就没有同伴、守卫全部用默认小人，
   * 不再按名册里同伴、守卫的分工；主角仍按名册。
   */
  readonly castIsExplicit: boolean;
}

/** 默认替身的 id 前缀（不会和名册里的 SHA-256 冲突）。 */
export const STAND_IN_PREFIX = 'stand-in:';

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

/**
 * 关卡的分配（P5）：主角按名册；关卡说明书列了出场人物时，同伴和守卫的外观按说明书
 * （同伴最多 maxCompanions 个，守卫按列出的顺序分给关卡里的守卫，规则同 P4），名册里的同伴、守卫分工这一关不用；
 * 列出的人物已不在名册里（或没有恢复）时用默认替身：守卫用默认小人，同伴用默认替身，并给出提示。
 * 没列出场人物时按名册的分工（assignCast）。
 * F3：options.castIsExplicit 为 true（工坊生成的关卡）时，出场人物以说明书为准，空也算：
 * 没列出场人物就没有同伴、守卫全部用默认小人，和列了人物时走同一条路（主角按名册，主角兼守卫的人这一关只当主角）。
 */
export function assignLevelCast(
  members: readonly CastMember[],
  levelCast: readonly LevelCastEntry[],
  guardCount: number,
  capacity: number,
  options: LevelCastOptions = { castIsExplicit: false },
): Cast {
  if (levelCast.length === 0 && !options.castIsExplicit) return assignCast(members, guardCount, capacity);
  const notices: string[] = [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const usable = (id: string) => byId.get(id)?.available === true;
  const missing = (id: string) => {
    const known = byId.get(id);
    notices.push(known ? `出场人物“${known.name}”没有恢复，用默认替身代替` : `出场人物（ID ${id.slice(0, 8)}）已不在名册里，用默认替身代替`);
  };
  let free = Math.max(0, capacity);
  const dropped: string[] = [];
  const take = (id: string): boolean => {
    if (free > 0) {
      free--;
      return true;
    }
    dropped.push(byId.get(id)?.name ?? id.slice(0, 8));
    return false;
  };

  const playerMember = members.find((m) => m.available && isPlayerRole(m.role)) ?? null;
  const player = playerMember && take(playerMember.id) ? playerMember.id : null;

  const guards: (string | null)[] = Array.from({ length: Math.max(0, guardCount) }, () => null);
  const guardEntries = levelCast.filter((c) => c.role === 'guard');
  guardEntries.forEach((entry, i) => {
    if (i >= guards.length) return;
    if (!usable(entry.personId)) {
      missing(entry.personId);
      return;
    }
    if (take(entry.personId)) guards[i] = entry.personId;
  });
  if (guardEntries.length > guards.length) notices.push(`关卡里只有 ${String(guards.length)} 个守卫：多列出的守卫不出场`);

  const companions: string[] = [];
  const standIns: string[] = [];
  levelCast
    .filter((c) => c.role === 'companion')
    .slice(0, ROSTER_LIMITS.maxCompanions)
    .forEach((entry, i) => {
      if (!usable(entry.personId)) {
        missing(entry.personId);
        const id = `${STAND_IN_PREFIX}${String(i)}`;
        companions.push(id);
        standIns.push(id);
        return;
      }
      if (take(entry.personId)) companions.push(entry.personId);
    });
  if (dropped.length > 0) notices.push(`同屏的导入实例最多 ${String(capacity)} 个：${dropped.map((n) => `“${n}”`).join('、')} 不出场`);
  return { player, guards, companions, notices, standIns };
}
