// 界面固定文字的多语言（F6）。用法：t('home.start')、t('hud.timeLeft', { time })。
// - 三份词典（messages/zh.ts、ja.ts、en.ts）的键完全相同；带参数的文字用命名占位（{time}），三种语言的占位名一致。
//   中文词典的文字和 F6 之前写死在代码里的完全一样。
// - 当前语言是全局的。浏览器在入口最先加载的 i18n/boot.ts 里决定（见 lang.ts 的顺序）；
//   Node（工坊服务、命令行脚本、单元测试）里不决定，一直是 zh：服务端发给模型的文字、日志和命令行输出都不变。
// - 切换语言时保存选择并刷新页面（browser.ts），运行中途不换文字。
// 这个模块不读浏览器环境，纯模块（关卡生成、检查器）也可以用。

import { en } from './messages/en';
import { ja } from './messages/ja';
import { zh, type MessageKey, type Messages } from './messages/zh';
import type { Lang } from './lang';

export type { Lang } from './lang';
export type { MessageKey } from './messages/zh';

const DICTS: Readonly<Record<Lang, Messages>> = { zh, ja, en };

let current: Lang = 'zh';

export function currentLang(): Lang {
  return current;
}

/** 设定当前语言（浏览器启动时调用一次；测试可以用来切换）。 */
export function setLang(lang: Lang): void {
  current = lang;
}

/** 当前语言的文字。params 填进同名的占位 {name}；没给的占位原样保留。 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const template = DICTS[current][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** 某种语言的词典（测试和语言选择用）。 */
export function messagesOf(lang: Lang): Messages {
  return DICTS[lang];
}
