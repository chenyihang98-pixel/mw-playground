// 关卡工坊的提示词和给模型的结构化输出 schema（P8）。数值（档位范围、上限）都从 P5 的 GEN_CONFIG 和说明书 schema 取，不另写一份。
// 模型只填说明书，不摆坐标、不写时间限制；它的输出只经结构化输出和 zod 校验进入流程，其他内容一律不执行。
// 提示词按第 0 条的实测调整过（docs/workshop-notes.md）：人物用短代号；组合规则写成可以照着算的式子。
// F7：请求的语言是 ja、en 时，提示词仍用中文，只改写说明书的系统提示里的两处：title 那一行写成用这种语言写标题，
// 再加一行要求 title、opening 和每个 line 用这种语言写。其余内容（理解请求的提示、用户消息、修复时附上的问题、工具说明）都不变。

import { z } from 'zod';
import type { Lang } from '../src/i18n';
import { BRIEF_SCHEMA_VERSION, MAX_COLLECTIBLES_PER_PLATFORM, briefSchema } from '../src/game/level/gen/brief';
import { DENSITIES, DISTRIBUTIONS, GEN_CONFIG, INTENTS, PATROLS, THEMES, TIERS, TIMES_OF_DAY, WEATHERS } from '../src/game/level/gen/config';
import { describeRoster, type RosterEntry } from './roster';

/** 说明书的 JSON Schema（由 P5 的 zod schema 生成），作为结构化输出传给模型。 */
export function briefJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(briefSchema, { io: 'input' });
}

function tierLines(): string {
  return TIERS.map((t) => {
    const c = GEN_CONFIG.tiers[t];
    return `  - ${t}：边长 ${String(c.size)} m，collectibles ${String(c.collectibles.min)}–${String(c.collectibles.max)}，guards 0–${String(c.maxGuards)}`;
  }).join('\n');
}

/** 第 1 步“理解请求”的系统提示：可以调用工具查名册快照，最后用几句话总结要做的关卡。 */
export function understandSystemPrompt(): string {
  return [
    '你是 3D 小游戏“宝石游乐场”的关卡设计助手。玩家用一句话描述想玩的关卡：在限定时间里收集宝石，躲开巡逻的守卫。',
    '这一步只做理解：用中文写 2–4 句话，概括玩家想要的地图大小、障碍多少、高台、宝石数量和分布、守卫和巡逻方式、难度、视觉（地面主题、时间、天气）和出场人物。',
    '玩家提到人物，或者你需要知道有哪些人物可以出场时，调用 lookup_roster 工具查名册快照；只能用快照里的人物。',
    '不要写坐标，不要写时间限制，不要输出 JSON。',
  ].join('\n');
}

/** ja、en 请求加的那一行：要求标题、开场白和台词用这种语言写。 */
export const BRIEF_LANG_LINES: Readonly<Record<Exclude<Lang, 'zh'>, string>> = {
  ja: '- title、opening 和 cast 里每个 line 都用日语写。',
  en: '- title、opening 和 cast 里每个 line 都用英语写。',
};

/** title 那一行（ja、en 写成用这种语言写标题；en 的长度单位是字符）。 */
function titleLine(lang: Lang, max: number): string {
  if (lang === 'ja') return `- title：日语标题，1–${String(max)} 个字。`;
  if (lang === 'en') return `- title：英语标题，1–${String(max)} 个字符。`;
  return `- title：中文标题，1–${String(max)} 个字。`;
}

/** 第 2 步“写说明书”的系统提示：说明每个字段和组合规则。lang 是请求的语言（F7，默认中文）。 */
export function briefSystemPrompt(lang: Lang = 'zh'): string {
  const b = GEN_CONFIG.brief;
  const m = MAX_COLLECTIBLES_PER_PLATFORM;
  return [
    '你是 3D 小游戏“宝石游乐场”的关卡设计助手。根据玩家的一句话，填写一份关卡说明书（JSON）。程序会按说明书生成布局、检查，并估计时间限制。',
    '只输出说明书 JSON，字段必须正好是下面这些：',
    `- schemaVersion：固定写 ${String(BRIEF_SCHEMA_VERSION)}。`,
    `- tier：地图档位，${TIERS.join(' / ')}：`,
    tierLines(),
    `- density：障碍密度，${DENSITIES.join(' / ')}。`,
    `- platforms：高台数量，${String(b.platforms.min)}–${String(b.platforms.max)} 的整数。`,
    '- collectibles：收集点（宝石）数量，必须在所选档位的范围内。',
    `- distribution：收集点分布，${DISTRIBUTIONS.join(' / ')}（scattered 分散，edge 靠边，elevated 只放在高台上，clustered 集中）。`,
    '- guards：守卫数量，在所选档位的范围内。',
    `- patrol：巡逻方式，${PATROLS.join(' / ')}（loop 绕圈，back-and-forth 来回）。`,
    `- intent：难度意向，${INTENTS.join(' / ')}。`,
    `- visual：{ theme: ${THEMES.join(' / ')}, time: ${TIMES_OF_DAY.join(' / ')}, weather: ${WEATHERS.join(' / ')} }。`,
    titleLine(lang, b.titleMaxLength),
    `- opening：开场白，最多 ${String(b.openingMaxLength)} 个字，可以是空字符串。`,
    `- cast：出场人物数组，每项 { personId, role, line }。personId 填名册快照里的人物代号（例如 r1），role 只能是这个人物允许的分工（companion 同伴 / guard 守卫），line 是一句台词（最多 ${String(b.lineMaxLength)} 个字）。玩家没提到人物时用空数组。`,
    ...(lang === 'zh' ? [] : [BRIEF_LANG_LINES[lang]]),
    '组合规则（必须全部满足，写完先自己核对一遍）：',
    `1. distribution 是 elevated 时：platforms ≥ 1，并且 collectibles ≤ platforms × ${String(m)}。先定 collectibles，再把 platforms 设成至少 collectibles ÷ ${String(m)}（向上取整），不超过 ${String(b.platforms.max)}。`,
    '2. cast 里 role 为 guard 的人数 ≤ guards。守卫不需要都由名册人物来当：没有分到人物的守卫用默认外观，所以 guards 可以比 cast 里的守卫多。',
    `3. cast 里 role 为 companion 的人数 ≤ ${String(b.maxCompanions)}。`,
    '4. 每个人物代号在 cast 里最多出现一次：一个人物只能有一个分工，不能既当同伴又当守卫。玩家点名要谁当什么就只给他这个分工，其他人物不必都出场。',
    '玩家没说清楚的地方，按“好玩、不太难”自己决定。不要写坐标和时间限制。',
  ].join('\n');
}

/** 写说明书时给模型的用户消息：玩家的一句话、第 1 步的理解、名册快照，以及上一次的问题（修复时）。 */
export function briefUserPrompt(input: {
  readonly text: string;
  readonly understanding: string;
  readonly roster: readonly RosterEntry[];
  readonly previous: string | null;
  readonly problems: readonly string[];
}): string {
  const parts = [`玩家的一句话：${input.text}`, `对请求的理解：${input.understanding || '（无）'}`, `名册快照：\n${describeRoster(input.roster)}`];
  if (input.problems.length > 0) {
    parts.push(
      `上一次写的说明书：${input.previous ?? '（没有得到可解析的 JSON）'}`,
      `它没有通过，原因如下，请照着改，其余尽量保持不变：\n${input.problems.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  parts.push('现在输出说明书 JSON。');
  return parts.join('\n\n');
}
