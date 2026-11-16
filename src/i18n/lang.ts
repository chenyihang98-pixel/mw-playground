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

/** 启动时的语言（浏览器入口 browser.ts 的 startLang 用它）：languages 就是 navigator.languages，空列表时取 en。 */
export function detectLang(env: { readonly search: string; readonly languages: readonly string[]; readonly storage: () => Pick<Storage, 'getItem'> }): Lang {
  return resolveLang({ search: env.search, stored: readStoredLang(env.storage), languages: env.languages });
}

export interface SwitchDeps {
  /** 刷新前要等的事：名册和已保存关卡排队的写入做完（第 1 轮审查后加上；等的过程中出错也照样切换）。 */
  readonly wait: () => Promise<unknown>;
  readonly storage: () => Pick<Storage, 'setItem'>;
  /** 当前地址（等完以后再读）。 */
  readonly href: () => string;
  /** 换到新地址（刷新页面）。 */
  readonly assign: (url: string) => void;
}

/**
 * 切换语言：先等排队的写入做完，再保存选择，去掉地址里的 ?lang=（不然它会盖过保存的选择），然后刷新页面。
 * 保存不下来时改用 ?lang=（只对这次访问有效）。
 */
export async function switchLangWith(lang: Lang, deps: SwitchDeps): Promise<void> {
  try {
    await deps.wait();
  } catch {
    // 写入失败另有提示；语言照样切换
  }
  const url = new URL(deps.href());
  if (storeLang(deps.storage, lang)) url.searchParams.delete('lang');
  else url.searchParams.set('lang', lang);
  deps.assign(url.toString());
}
