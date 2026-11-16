// 语言选择（F6）：开始界面和暂停菜单里各一个。选项固定写成“中文 / 日本語 / English”。
// 切换时保存选择并刷新页面（i18n/browser.ts）：名册、已保存的关卡、静音设置都在浏览器的存储里，刷新后还在；
// 只在开始界面和暂停菜单里提供，游玩中不会切到一半。

import { switchLang } from '../i18n/browser';
import { currentLang, t } from '../i18n';
import { LANG_OPTIONS, parseLang } from '../i18n/lang';
import { el } from './dom';

/** 一行：标签“语言”和下拉框。下拉框的选项是各自语言的名字，不翻译（标了 data-i18n-raw）。 */
export function langSelect(id: string): HTMLLabelElement {
  const row = el('label', { className: 'mw-lang' });
  row.htmlFor = id;
  const select = el('select', { id, className: 'mw-select mw-lang-select' });
  for (const option of LANG_OPTIONS) select.add(new Option(option.label, option.lang, false, option.lang === currentLang()));
  select.dataset.i18nRaw = 'lang-names';
  select.setAttribute('aria-label', t('lang.label'));
  select.addEventListener('change', () => {
    const lang = parseLang(select.value);
    if (lang && lang !== currentLang()) switchLang(lang);
  });
  row.append(el('span', { className: 'mw-subtle', text: t('lang.label') }), select);
  return row;
}
