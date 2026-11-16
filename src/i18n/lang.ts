// 界面语言（F6）：zh（简体中文）、ja（日语）、en（英语）。这里只有纯函数，不读浏览器环境（浏览器那边见 browser.ts）。
//
// 当前语言的决定顺序：
//   1. 地址里的 ?lang=zh|ja|en（只对这次访问有效，不改保存的选择）；
//   2. 用户上次选的语言（localStorage 的 LANG_STORAGE_KEY）；
//   3. 浏览器语言：navigator.languages 里第一个以 zh 开头的取 zh、以 ja 开头的取 ja，都没有时取 en。
// 无效的 ?lang= 和无效的保存值都忽略。

export const LANGS = ['zh', 'ja', 'en'] as const;
export type Lang = (typeof LANGS)[number];

/** 保存语言选择的 localStorage 键。 */
export const LANG_STORAGE_KEY = 'mw-playground:lang';

/** 根元素的 lang 属性。 */
export const LANG_TAGS: Readonly<Record<Lang, string>> = { zh: 'zh-CN', ja: 'ja', en: 'en' };

/** 语言选择里的选项：固定写成各自语言的名字（“中文 / 日本語 / English”），不跟着界面语言变。 */
export const LANG_OPTIONS: readonly { readonly lang: Lang; readonly label: string }[] = [
  { lang: 'zh', label: '中文' },
  { lang: 'ja', label: '日本語' },
  { lang: 'en', label: 'English' },
];

export function parseLang(value: string | null | undefined): Lang | null {
  return LANGS.find((l) => l === value) ?? null;
}

/** 浏览器语言：列表里第一个以 zh 开头的取 zh、以 ja 开头的取 ja；都没有时取 en。 */
export function langFromBrowser(languages: readonly string[]): Lang {
  for (const tag of languages) {
    const lower = tag.trim().toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
    if (lower.startsWith('ja')) return 'ja';
  }
  return 'en';
}

export interface LangSources {
  /** 地址的查询部分（location.search）。 */
  readonly search: string;
  /** 保存的选择（读不出来时为 null）。 */
  readonly stored: string | null;
  /** navigator.languages。 */
  readonly languages: readonly string[];
}

export function resolveLang(sources: LangSources): Lang {
  return parseLang(new URLSearchParams(sources.search).get('lang')) ?? parseLang(sources.stored) ?? langFromBrowser(sources.languages);
}

/** 读保存的选择。读失败（存储被禁止、抛错）时按没有保存过处理。 */
export function readStoredLang(storage: () => Pick<Storage, 'getItem'>): string | null {
  try {
    return storage().getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 保存选择。写失败时返回 false，不抛错。 */
export function storeLang(storage: () => Pick<Storage, 'setItem'>, lang: Lang): boolean {
  try {
    storage().setItem(LANG_STORAGE_KEY, lang);
    return true;
  } catch {
    return false;
  }
}
