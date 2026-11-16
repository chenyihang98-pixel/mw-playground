// 浏览器里的语言（F6）：启动时决定当前语言、设根元素的 lang；切换时保存选择并刷新页面。
// localStorage 读写失败时照静音设置（game/audio/sound.ts）的做法：按没有保存过处理，不报错，游戏照常运行。
// 保存不下来时，切换改用地址里的 ?lang=（只对这次访问有效）。

import { setLang } from './index';
import { LANG_TAGS, readStoredLang, resolveLang, storeLang, type Lang } from './lang';

const storage = () => window.localStorage;

/** 按地址、保存的选择、浏览器语言决定当前语言，并设好根元素的 lang（字体跟着它选，见 ui/theme.css）。 */
export function startLang(): Lang {
  const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  const lang = resolveLang({ search: window.location.search, stored: readStoredLang(storage), languages });
  setLang(lang);
  document.documentElement.lang = LANG_TAGS[lang];
  return lang;
}

/**
 * 切换语言：保存选择，去掉地址里的 ?lang=（不然它会盖过保存的选择），刷新页面。
 * 名册、已保存的关卡在 IndexedDB，静音设置在 localStorage，刷新后都还在。保存失败时改用 ?lang=。
 */
export function switchLang(lang: Lang): void {
  const url = new URL(window.location.href);
  if (storeLang(storage, lang)) url.searchParams.delete('lang');
  else url.searchParams.set('lang', lang);
  window.location.assign(url.toString());
}
