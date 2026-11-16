// 浏览器里的语言（F6）：启动时决定当前语言、设根元素的 lang；切换时等排队的写入做完，保存选择并刷新页面。
// localStorage 读写失败时照静音设置（game/audio/sound.ts）的做法：按没有保存过处理，不报错，游戏照常运行。
// 保存不下来时，切换改用地址里的 ?lang=（只对这次访问有效）。

import { setLang } from './index';
import { LANG_TAGS, detectLang, switchLangWith, type Lang, type WriteQueues } from './lang';

const storage = () => window.localStorage;

/** 切换前要等它们同时空闲的写入队列；app 注册成名册和已保存关卡。 */
let queues: WriteQueues = { idle: () => true, waitIdle: () => Promise.resolve() };

/**
 * 按地址、保存的选择、浏览器语言决定当前语言，并设好根元素的 lang（字体跟着它选，见 ui/theme.css）。
 * 浏览器语言只看 navigator.languages：空列表时取 en（第 1 轮审查后改，以前空列表时还看 navigator.language）。
 */
export function startLang(): Lang {
  const lang = detectLang({ search: window.location.search, languages: navigator.languages, storage });
  setLang(lang);
  document.documentElement.lang = LANG_TAGS[lang];
  return lang;
}

/** 注册切换前要等的写入队列（app.ts：名册和已保存关卡）。 */
export function setBeforeLangSwitch(writeQueues: WriteQueues): void {
  queues = writeQueues;
}

/**
 * 切换语言：等名册和已保存关卡的写入同时做完，保存选择，去掉地址里的 ?lang=，刷新页面。
 * 名册、已保存的关卡在 IndexedDB，静音设置在 localStorage，刷新后都还在。保存选择失败时改用 ?lang=。
 */
export function switchLang(lang: Lang): Promise<void> {
  return switchLangWith(lang, {
    queues,
    storage,
    href: () => window.location.href,
    assign: (url) => {
      window.location.assign(url);
    },
  });
}
