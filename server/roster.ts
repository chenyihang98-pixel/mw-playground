// 名册快照在工坊里的用法（P8）：浏览器发来选中人物的元数据（人物 ID、显示名、允许的分工），不含模型文件。
// 给模型看的时候每个人物用一个短代号（r1、r2…），模型在说明书里填代号，服务再换回真正的人物 ID。
// 实测（docs/workshop-notes.md）：让 9B 模型照抄 64 位的人物 ID 很容易抄错，用代号后不再出这类错。
// 模型只能分配快照里的人物、只能用快照允许的分工；这两条在说明书校验时检查。

import type { Brief, BriefProblem } from '../src/game/level/gen/brief';
import type { PersonRole, RosterPersonSnapshot } from '../src/workshop/protocol';

export interface RosterEntry {
  readonly alias: string;
  readonly id: string;
  readonly name: string;
  readonly roles: readonly PersonRole[];
}

export function rosterEntries(snapshot: readonly RosterPersonSnapshot[]): RosterEntry[] {
  return snapshot.map((p, i) => ({ alias: `r${String(i + 1)}`, id: p.id, name: p.name, roles: [...p.roles] }));
}

const ROLE_WORDS: Readonly<Record<PersonRole, string>> = { companion: '同伴', guard: '守卫' };

/** 名册快照的文字说明（工具的返回值，也放进写说明书的提示里）。 */
export function describeRoster(entries: readonly RosterEntry[]): string {
  if (entries.length === 0) return '名册快照是空的：这一关没有出场人物，cast 必须是空数组。';
  return entries
    .map((p) => `- 代号 ${p.alias}：${p.name}；允许的分工：${p.roles.map((r) => `${r}（${ROLE_WORDS[r]}）`).join('、')}`)
    .join('\n');
}

/** 把模型输出里 cast[].personId 的代号换回人物 ID（其他内容原样保留，之后再用 zod 校验）。 */
export function resolveAliases(raw: unknown, entries: readonly RosterEntry[]): unknown {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { cast?: unknown }).cast)) return raw;
  const byAlias = new Map(entries.map((e) => [e.alias.toLowerCase(), e.id]));
  const cast = ((raw as { cast: unknown[] }).cast).map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const personId = (item as { personId?: unknown }).personId;
    if (typeof personId !== 'string') return item;
    const id = byAlias.get(personId.trim().toLowerCase());
    return id === undefined ? item : { ...item, personId: id };
  });
  return { ...(raw as Record<string, unknown>), cast };
}

/** 出场人物的分工必须是快照允许的。 */
export function roleProblems(brief: Brief, entries: readonly RosterEntry[]): BriefProblem[] {
  const problems: BriefProblem[] = [];
  brief.cast.forEach((c, i) => {
    const person = entries.find((e) => e.id === c.personId);
    if (person && !person.roles.includes(c.role)) {
      problems.push({
        path: `cast.${String(i)}.role`,
        message: `人物 ${person.id}（${person.name}）不能当${ROLE_WORDS[c.role]}，允许的分工是：${person.roles.map((r) => ROLE_WORDS[r]).join('、')}`,
      });
    }
  });
  return problems;
}

/** 给模型看的文字里，把人物 ID 换成代号（修复时把原因交回模型）。 */
export function aliasText(text: string, entries: readonly RosterEntry[]): string {
  let out = text;
  for (const e of entries) out = out.split(e.id).join(e.alias);
  return out;
}
