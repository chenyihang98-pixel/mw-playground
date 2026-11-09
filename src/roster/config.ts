// 名册（P4）的配置：上限和分工。改上限时同时改 docs/status.md 的 P4 一节。

export const ROSTER_LIMITS = Object.freeze({
  /** 名册最多几个人物（包括恢复失败、仍留在存储里的项）。 */
  maxPeople: 20,
  /** 同伴最多几个。 */
  maxCompanions: 3,
  /** 显示名最长几个字符。 */
  maxNameLength: 60,
});

/** 分工：主角；守卫；主角兼守卫；同伴；不出场。 */
export const ROLES = ['player', 'guard', 'playerGuard', 'companion', 'none'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  player: '主角',
  guard: '守卫',
  playerGuard: '主角兼守卫',
  companion: '同伴',
  none: '不出场',
});

/** 这个分工是不是主角（含主角兼守卫）。 */
export function isPlayerRole(role: Role): boolean {
  return role === 'player' || role === 'playerGuard';
}

/** 这个分工是不是守卫（含主角兼守卫）。 */
export function isGuardRole(role: Role): boolean {
  return role === 'guard' || role === 'playerGuard';
}
