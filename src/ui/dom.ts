// 界面的小工具（P6）：建元素、带图标的按钮、标签。所有界面共用，样式见 theme.css。

import { icon, type IconName } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: { id?: string; className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.id) node.id = attrs.id;
  if (attrs.className) node.className = attrs.className;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  return node;
}

export type ButtonVariant = 'default' | 'primary' | 'accent' | 'danger' | 'ghost';

export interface ButtonOptions {
  readonly icon?: IconName;
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md' | 'lg';
  /** 只显示图标（文字作为无障碍名称）。 */
  readonly iconOnly?: boolean;
  /** 无障碍名称（默认用文字）。 */
  readonly label?: string;
  readonly id?: string;
  readonly className?: string;
}

/** 带图标的按钮。文字放在 span 里，改文字用 setButtonText。 */
export function button(text: string, onClick: (() => void) | null, options: ButtonOptions = {}): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  const classes = ['mw-btn'];
  if (options.variant && options.variant !== 'default') classes.push(`mw-btn--${options.variant}`);
  if (options.size === 'sm') classes.push('mw-btn--sm');
  if (options.size === 'lg') classes.push('mw-btn--lg');
  if (options.iconOnly) classes.push('mw-btn--icon');
  if (options.className) classes.push(options.className);
  b.className = classes.join(' ');
  if (options.id) b.id = options.id;
  if (options.icon) b.append(icon(options.icon));
  const label = el('span', { className: 'mw-btn-label', text });
  if (options.iconOnly) {
    label.hidden = true;
    b.title = options.label ?? text;
  }
  b.append(label);
  if (options.label || options.iconOnly) b.setAttribute('aria-label', options.label ?? text);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** 改按钮的文字（保留图标）。 */
export function setButtonText(b: HTMLButtonElement, text: string): void {
  const label = b.querySelector('.mw-btn-label');
  if (label) label.textContent = text;
  else b.textContent = text;
}

export type TagColor = 'default' | 'gold' | 'red' | 'orange' | 'green' | 'blue' | 'purple';

export function tag(text: string, color: TagColor = 'default', iconName?: IconName): HTMLSpanElement {
  const t = el('span', { className: color === 'default' ? 'mw-tag' : `mw-tag mw-tag--${color}` });
  if (iconName) t.append(icon(iconName));
  t.append(document.createTextNode(text));
  return t;
}

export type NoticeLevel = 'error' | 'warning' | 'info';

const NOTICE_ICON: Readonly<Record<NoticeLevel, IconName>> = { error: 'alert', warning: 'warning', info: 'info' };

/** 一条提示（错误、警告或说明）。 */
export function notice(level: NoticeLevel, text: string): HTMLLIElement {
  const li = el('li', { className: `mw-notice mw-notice--${level}` });
  li.dataset.level = level;
  li.append(icon(NOTICE_ICON[level]), el('span', { text }));
  return li;
}
