// 界面固定文字的多语言（F6）。用法：t('home.start')、t('hud.timeLeft', { time })。
// - 三份词典（messages/zh.ts、ja.ts、en.ts）的键完全相同；带参数的文字用命名占位（{time}），三种语言的占位名一致。
//   中文词典的文字和 F6 之前写死在代码里的完全一样。
// - 当前语言是全局的。浏览器在入口最先加载的 i18n/boot.ts 里决定（见 lang.ts 的顺序）；
//   Node（工坊服务、命令行脚本、单元测试）里不决定，一直是 zh：服务端发给模型的文字、日志和命令行输出都不变。
// - 切换语言时保存选择并刷新页面（browser.ts），运行中途不换文字。
// 这个模块不读浏览器环境，纯模块（关卡生成、检查器）也可以用。
// - F7：工坊服务按请求的语言写给玩家看的说明，不切换全局的当前语言：用 translator(lang) 取一个指定语言的 Translate，
//   需要它的模块（说明书校验、检查器、流水线、diff 等）把它当参数接收，没给时用 t（浏览器里的行为不变）。

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

export type MessageParams = Readonly<Record<string, string | number>>;

/** 取文字的函数：t 是当前语言的，translator(lang) 是指定语言的。 */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** 指定语言的文字（纯函数）。params 填进同名的占位 {name}；没给的占位原样保留。 */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = DICTS[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** 指定语言的 Translate。 */
export function translator(lang: Lang): Translate {
  return (key, params) => translate(lang, key, params);
}

/** 当前语言的文字。 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

/** 某种语言的词典（测试和语言选择用）。 */
export function messagesOf(lang: Lang): Messages {
  return DICTS[lang];
}
