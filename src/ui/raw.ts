// 原样显示的内容（F6）：用户数据（文件名、名册里的人名、已保存关卡的标题）、生成的文字（关卡标题、开场白、台词）
// 和服务端没有错误码的原文，都不翻译，所在的元素标上 data-i18n-raw。端到端测试检查界面语言时跳过这些元素。

import { currentLang, messagesOf, type MessageKey } from '../i18n';
import type { NoticeLevel } from './dom';
import { icon, type IconName } from './icons';

/** 标上（或去掉）data-i18n-raw。返回这个元素，方便链式写法。 */
export function markRaw<T extends HTMLElement>(node: T, raw = true): T {
  if (raw) node.dataset.i18nRaw = 'data';
  else delete node.dataset.i18nRaw;
  return node;
}

/** 一段原样显示的文字。 */
export function rawSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = text;
  return markRaw(span);
}

/**
 * 当前语言的文字，按占位拆开：字符串参数直接填进去，节点参数（例如 rawSpan）原样插进对应的位置。
 * 用在一句话里混着原样显示的内容的地方（例如“已经保存了 {title}”），翻译的部分照样检查。
 */
export function tNodes(key: MessageKey, params: Readonly<Record<string, string | Node>>): (string | Node)[] {
  const template = messagesOf(currentLang())[key];
  const out: (string | Node)[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const value = params[match[1] ?? ''];
    if (value === undefined) continue;
    out.push(template.slice(last, match.index), value);
    last = match.index + match[0].length;
  }
  out.push(template.slice(last));
  return out.filter((part) => part !== '');
}

const NOTICE_ICON: Readonly<Record<NoticeLevel, IconName>> = { error: 'alert', warning: 'warning', info: 'info' };

/** 和 dom.ts 的 notice 一样的一条提示，内容可以混着原样显示的节点。 */
export function richNotice(level: NoticeLevel, parts: readonly (string | Node)[]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `mw-notice mw-notice--${level}`;
  li.dataset.level = level;
  const span = document.createElement('span');
  span.append(...parts);
  li.append(icon(NOTICE_ICON[level]), span);
  return li;
}

/** 整条都是原样显示的提示（服务端没有错误码的原文等）。 */
export function rawNotice(level: NoticeLevel, text: string): HTMLLIElement {
  return markRaw(richNotice(level, [text]));
}
