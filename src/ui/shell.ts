// 页面外壳（P6）：顶栏（品牌、当前关卡、导入、名册、静音）、开始界面、底部的提示条。
// 只负责摆放和显示，具体操作由 app.ts 传进来的回调完成。

import './shell.css';
import type { SoundBoard } from '../game/audio/sound';
import { controlsHelp } from '../game/ui/hud';
import { button, el, setButtonText, tag, type TagColor } from './dom';
import { icon } from './icons';
import { langSelect } from './langSelect';
import { markRaw } from './raw';
import { t } from '../i18n';

export const GAME_TITLE = t('app.title');

/** 静音开关：名字固定为“静音”，用 aria-pressed 表示状态（顶栏和开始界面各一个，不会同时显示）。 */
export function muteToggle(sound: SoundBoard, options: { size?: 'md' | 'lg'; className?: string } = {}): HTMLButtonElement {
  const b = button(t('sound.mute'), () => {
    sound.toggle();
  }, { icon: 'volume', iconOnly: true, size: options.size, className: options.className });
  const render = () => {
    b.setAttribute('aria-pressed', String(sound.muted));
    b.title = sound.muted ? t('sound.mutedTitle') : sound.storageAvailable ? t('sound.mute') : t('sound.muteNoStorage');
    b.querySelector('svg')?.replaceWith(icon(sound.muted ? 'mute' : 'volume'));
    b.classList.toggle('is-muted', sound.muted);
  };
  sound.onChange(render);
  render();
  return b;
}

export interface LevelChip {
  readonly title: string;
  /** 标题是保存或生成的文字，原样显示（F6）。 */
  readonly titleRaw?: boolean;
  readonly source: { readonly text: string; readonly color: TagColor };
  readonly difficulty: string | null;
}

export class TopBar {
  readonly root = el('header', { id: 'mw-topbar' });
  private readonly levelButton: HTMLButtonElement;
  readonly rosterButton: HTMLButtonElement;

  constructor(
    host: HTMLElement,
    actions: { readonly onLevels: () => void; readonly onRoster: () => void },
    importButton: HTMLButtonElement,
    sound: SoundBoard,
  ) {
    const brand = el('div', { className: 'mw-brand' });
    brand.append(icon('gem', 'mw-icon mw-brand-icon'), el('span', { text: GAME_TITLE }));
    this.levelButton = button('', actions.onLevels, { icon: 'map', label: t('levels.choose'), id: 'level-toggle', className: 'mw-level-chip' });
    this.levelButton.append(icon('chevronDown', 'mw-icon mw-chevron'));
    this.rosterButton = button(t('common.roster'), actions.onRoster, { icon: 'users', id: 'roster-toggle' });
    this.rosterButton.setAttribute('aria-expanded', 'false');
    importButton.classList.add('mw-btn', 'mw-btn--primary');
    importButton.replaceChildren(icon('upload'), el('span', { className: 'mw-btn-label', text: t('import.button') }));
    const left = el('div', { id: 'mw-topbar-left', className: 'mw-topbar-group' });
    left.append(brand, this.levelButton);
    const right = el('div', { id: 'mw-topbar-right', className: 'mw-topbar-group' });
    right.append(importButton, this.rosterButton, muteToggle(sound));
    this.root.append(left, right);
    host.append(this.root);
  }

  setLevel(title: string, raw = false): void {
    setButtonText(this.levelButton, title);
    const label = this.levelButton.querySelector<HTMLElement>('.mw-btn-label');
    if (label) markRaw(label, raw);
    this.levelButton.title = t('topbar.levelTitle', { title });
  }

  setPanel(levelsOpen: boolean, rosterOpen: boolean): void {
    this.levelButton.setAttribute('aria-expanded', String(levelsOpen));
    this.rosterButton.setAttribute('aria-expanded', String(rosterOpen));
    this.levelButton.classList.toggle('is-current', levelsOpen);
    this.rosterButton.classList.toggle('is-current', rosterOpen);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }
}

export interface HomeActions {
  readonly onStart: () => void;
  readonly onLevels: () => void;
  readonly onRoster: () => void;
  readonly onImport: () => void;
}

/** 开始界面：标题、开始、选关、名册、导入、操作说明、静音。 */
export class HomeScreen {
  readonly root = el('section', { id: 'mw-home' });
  private readonly startButton: HTMLButtonElement;
  private readonly levelTitle = el('strong', { className: 'home-level-title' });
  private readonly levelTags = el('div', { className: 'home-level-tags' });
  private readonly help = el('div', { className: 'home-help', id: 'home-help' });
  private readonly helpButton: HTMLButtonElement;

  constructor(host: HTMLElement, actions: HomeActions, sound: SoundBoard) {
    this.root.setAttribute('aria-label', t('home.label'));
    this.root.hidden = true;
    const card = el('div', { className: 'home-card' });
    const badge = el('div', { className: 'home-badge' });
    badge.append(icon('gem', 'mw-icon'));
    const title = el('h1', { text: GAME_TITLE });
    const tagline = el('p', { className: 'home-tagline', text: t('home.tagline') });
    const level = el('div', { className: 'home-level' });
    const levelLabel = el('span', { className: 'home-level-label', text: t('home.currentLevel') });
    level.append(levelLabel, this.levelTitle, this.levelTags);

    this.startButton = button(t('common.start'), actions.onStart, { icon: 'play', variant: 'primary', size: 'lg', className: 'home-start' });
    const levels = button(t('home.levels'), actions.onLevels, { icon: 'map', size: 'lg', label: t('levels.choose') });
    const roster = button(t('common.roster'), actions.onRoster, { icon: 'users', size: 'lg' });
    const importButton = button(t('import.button'), actions.onImport, { icon: 'upload', size: 'lg' });
    this.helpButton = button(t('help.title'), () => {
      this.setHelp(this.help.hidden === true);
    }, { icon: 'keyboard', size: 'lg' });
    this.helpButton.setAttribute('aria-controls', 'home-help');
    this.helpButton.setAttribute('aria-expanded', 'false');
    const grid = el('div', { className: 'home-actions' });
    grid.append(levels, roster, importButton, this.helpButton);
    this.help.hidden = true;
    this.help.append(el('h2', { text: t('help.title') }), controlsHelp());
    const foot = el('div', { className: 'home-foot' });
    foot.append(el('span', { className: 'mw-subtle', text: t('home.sound') }), muteToggle(sound), langSelect('home-lang'));
    card.append(badge, title, tagline, level, this.startButton, grid, this.help, foot);
    this.root.append(card);
    host.append(this.root);
  }

  private setHelp(open: boolean): void {
    this.help.hidden = !open;
    this.helpButton.setAttribute('aria-expanded', String(open));
    this.helpButton.classList.toggle('is-current', open);
  }

  setLevel(chip: LevelChip): void {
    this.levelTitle.textContent = chip.title;
    markRaw(this.levelTitle, chip.titleRaw ?? false);
    const tags = [tag(chip.source.text, chip.source.color, 'layers')];
    if (chip.difficulty) tags.push(tag(t('level.difficultyTag', { difficulty: chip.difficulty }), 'purple', 'star'));
    this.levelTags.replaceChildren(...tags);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean, focus: boolean): void {
    const was = !this.root.hidden;
    this.root.hidden = !visible;
    if (visible && !was && focus) this.startButton.focus({ preventScroll: true });
  }
}
