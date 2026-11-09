// 名册界面：人物卡片（缩略图、显示名、分工标签、恢复失败的项单独标出）、设分工、改名、打开导入卡片修改设置、
// 删除（二次确认）、恢复默认主角，以及提示（重复加入、名册已满、存储失败、恢复失败、分配时不出场的人物）。
// P6：左侧的主面板（由 PanelManager 管显示）；缩略图在运行时生成，只放在内存里（见 thumbnails.ts）。
//
// 每张卡片的控件按人物建一次，名册变化时只刷新文字和选中项；正在输入的显示名不会被覆盖。

import './roster.css';
import { ROLE_LABELS, ROLES, type Role } from '../config';
import type { Roster } from '../roster';
import { button, el, notice, tag, type TagColor } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { ThumbnailRenderer } from './thumbnails';

export interface RosterPanelHost {
  /** 在导入卡片里打开这个人物，修改设置。 */
  openCard(key: string): void;
  /** 删除这个人物（已经确认过）。 */
  remove(key: string): void;
  /** 分配时的提示（例如守卫人物比关卡里的守卫多）。 */
  castNotices(): readonly string[];
  /** 关掉名册面板。 */
  close(): void;
}

const ROLE_COLORS: Readonly<Record<Role, TagColor>> = {
  player: 'gold',
  guard: 'red',
  playerGuard: 'orange',
  companion: 'green',
  none: 'default',
};

interface Card {
  readonly li: HTMLLIElement;
  readonly thumb: HTMLElement;
  readonly img: HTMLImageElement;
  readonly name: HTMLInputElement;
  readonly rename: HTMLButtonElement;
  readonly roleBox: HTMLElement;
  readonly file: HTMLElement;
  readonly role: HTMLSelectElement;
  readonly status: HTMLElement;
  readonly open: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly confirmRow: HTMLElement;
  readonly confirm: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

export class RosterPanel {
  private readonly panel = el('section', { id: 'roster-panel', className: 'mw-panel mw-main-panel' });
  private readonly count = el('span', { className: 'mw-tag' });
  private readonly restoring = el('span', { className: 'roster-restoring' });
  private readonly storage = el('div', { id: 'roster-storage' });
  private readonly notices = el('ul', { id: 'roster-notices', className: 'mw-notices' });
  private readonly list = el('ol', { id: 'roster-list', className: 'person-list' });
  private readonly empty = el('div', { className: 'roster-empty' });
  private readonly closeButton: HTMLButtonElement;
  private readonly cards = new Map<string, Card>();
  private readonly confirming = new Set<string>();
  private lastHighlight: string | null = null;
  private shown = false;

  constructor(
    root: HTMLElement,
    private readonly roster: Roster,
    private readonly host: RosterPanelHost,
    private readonly thumbnails: ThumbnailRenderer,
  ) {
    this.panel.setAttribute('aria-label', '名册');
    this.panel.hidden = true;
    this.storage.setAttribute('role', 'alert');
    this.notices.setAttribute('role', 'status');
    const header = el('div', { className: 'mw-panel-header' });
    const title = el('h2');
    title.append(icon('users', 'mw-icon roster-title-icon'), document.createTextNode('名册'));
    this.closeButton = button('关闭名册', () => {
      this.host.close();
    }, { icon: 'close', iconOnly: true, variant: 'ghost' });
    header.append(title, this.restoring, this.count, this.closeButton);
    this.empty.append(icon('user', 'mw-icon roster-empty-icon'), el('p', { text: '名册是空的：导入角色后点“加入为新人物”或“设为主角”。' }));
    const body = el('div', { className: 'mw-panel-body mw-scroll' });
    body.append(this.storage, this.notices, this.empty, this.list);
    const footer = el('div', { className: 'mw-panel-footer' });
    footer.append(
      button('恢复默认主角', () => {
        this.roster.restoreDefaultPlayer();
      }, { icon: 'user', size: 'sm' }),
      el('span', { className: 'mw-subtle', text: '分工一改就自动保存。' }),
    );
    this.panel.append(header, body, footer);
    root.append(this.panel);
    thumbnails.onChange(() => {
      this.refresh();
    });
    this.refresh();
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    this.panel.hidden = !shown;
    if (shown) this.refresh();
  }

  focusFirst(): void {
    this.closeButton.focus({ preventScroll: true });
  }

  private buildCard(key: string): Card {
    const li = el('li', { className: 'person-card' });
    li.dataset.key = key;
    const thumb = el('div', { className: 'person-thumb' });
    const img = el('img');
    img.alt = '';
    img.hidden = true;
    thumb.append(icon('user', 'mw-icon person-placeholder'), img);

    const name = el('input', { className: 'mw-input person-name' });
    name.type = 'text';
    const rename = button('保存名字', () => {
      const result = this.roster.rename(key, name.value);
      if (!result.ok) name.setCustomValidity(result.error);
      else name.setCustomValidity('');
    }, { icon: 'check', iconOnly: true, size: 'sm' });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') rename.click();
    });
    const nameRow = el('div', { className: 'person-name-row' });
    nameRow.append(name, rename);

    const roleBox = el('span', { className: 'person-role-tag' });
    const file = el('span', { className: 'person-file mw-subtle' });
    const meta = el('div', { className: 'person-meta' });
    meta.append(roleBox, file);

    const role = el('select', { className: 'mw-select' });
    for (const r of ROLES) role.add(new Option(ROLE_LABELS[r], r));
    role.addEventListener('change', () => {
      const result = this.roster.setRole(key, role.value as Role);
      if (!result.ok) this.refresh();
    });
    const open = button('设置', () => {
      this.host.openCard(key);
    }, { icon: 'edit', size: 'sm' });
    const remove = button('删除', () => {
      this.confirming.add(key);
      this.refresh();
    }, { icon: 'trash', iconOnly: true, size: 'sm', variant: 'ghost' });
    const actions = el('div', { className: 'person-actions' });
    const roleField = el('label', { className: 'person-role' });
    roleField.append(el('span', { text: '分工' }), role);
    actions.append(roleField, open, remove);

    const confirm = button('确认删除', () => {
      this.confirming.delete(key);
      this.host.remove(key);
    }, { icon: 'trash', variant: 'danger', size: 'sm' });
    const cancel = button('取消', () => {
      this.confirming.delete(key);
      this.refresh();
    }, { size: 'sm' });
    const confirmRow = el('div', { className: 'person-confirm' });
    confirmRow.append(el('span', { text: '从名册里删除这个人物？' }), confirm, cancel);

    const status = el('div', { className: 'person-status' });
    const main = el('div', { className: 'person-main' });
    main.append(nameRow, meta, status, actions, confirmRow);
    li.append(thumb, main);
    return { li, thumb, img, name, rename, roleBox, file, role, status, open, remove, confirmRow, confirm, cancel };
  }

  /** 名册变化后刷新。 */
  refresh(): void {
    const snapshot = this.roster.snapshot();
    this.count.textContent = `${String(snapshot.entries.length)} / ${String(snapshot.max)}`;
    this.restoring.textContent = snapshot.restoring ? '正在恢复…' : '';
    this.storage.replaceChildren();
    if (snapshot.storage.problem) this.storage.append(notice('error', snapshot.storage.problem));
    this.storage.hidden = snapshot.storage.problem === null;
    this.notices.replaceChildren(...[...snapshot.notices, ...this.host.castNotices()].map((n) => notice('info', n)));
    this.empty.hidden = snapshot.entries.length > 0;
    this.thumbnails.setPaused(snapshot.restoring);

    const keys = new Set(snapshot.entries.map((e) => e.key));
    for (const [key, card] of this.cards) {
      if (!keys.has(key)) {
        card.li.remove();
        this.cards.delete(key);
        this.confirming.delete(key);
      }
    }
    const ordered: HTMLLIElement[] = [];
    for (const entry of snapshot.entries) {
      let card = this.cards.get(entry.key);
      if (!card) {
        card = this.buildCard(entry.key);
        this.cards.set(entry.key, card);
      }
      const name = entry.displayName;
      const ready = entry.status === 'ready';
      card.li.classList.toggle('failed', entry.status === 'failed');
      card.li.classList.toggle('loading', entry.status === 'loading');
      card.li.classList.toggle('highlight', entry.highlighted);
      card.li.dataset.role = entry.role ?? 'unknown';
      if (document.activeElement !== card.name) card.name.value = name;
      card.name.disabled = entry.role === null;
      card.name.setAttribute('aria-label', `${name} 的显示名`);
      card.rename.disabled = entry.role === null;
      card.rename.setAttribute('aria-label', `保存 ${name} 的显示名`);
      card.rename.title = '保存名字';
      const roleKey = entry.role ?? 'unknown';
      if (card.roleBox.dataset.role !== roleKey) {
        card.roleBox.dataset.role = roleKey;
        card.roleBox.replaceChildren(this.roleTag(entry.role));
      }
      card.file.textContent = entry.fileName && entry.fileName !== name ? entry.fileName : '';
      card.role.value = entry.role ?? 'none';
      card.role.disabled = !ready;
      card.role.setAttribute('aria-label', `${name} 的分工`);
      card.status.textContent = entry.status === 'failed' ? `恢复失败：${entry.error ?? ''}` : entry.status === 'loading' ? '正在恢复…' : '';
      card.status.hidden = ready;
      card.status.className = `person-status${entry.status === 'failed' ? ' is-error' : ''}`;
      card.open.disabled = !ready;
      card.open.setAttribute('aria-label', `打开 ${name} 的导入卡片`);
      const confirming = this.confirming.has(entry.key);
      card.remove.hidden = confirming;
      card.remove.setAttribute('aria-label', `删除 ${name}`);
      card.remove.title = `删除 ${name}`;
      card.confirmRow.hidden = !confirming;
      card.confirm.setAttribute('aria-label', `确认删除 ${name}`);
      card.cancel.setAttribute('aria-label', `取消删除 ${name}`);
      // 缩略图：资产恢复好了才画；画好之前显示占位图标
      const asset = ready ? this.roster.assetOf(entry.key) : null;
      const url = asset ? this.thumbnails.get(asset) : null;
      if (asset && url === null) this.thumbnails.request(asset);
      if (url !== null && card.img.src !== url) card.img.src = url;
      card.img.hidden = url === null;
      card.thumb.classList.toggle('has-image', url !== null);
      ordered.push(card.li);
    }
    // 按名册顺序排列（只移动位置不对的卡片，不重建控件）
    ordered.forEach((li, i) => {
      if (this.list.children[i] !== li) this.list.insertBefore(li, this.list.children[i] ?? null);
    });
    if (snapshot.highlight !== null && snapshot.highlight !== this.lastHighlight && this.shown) {
      this.cards.get(snapshot.highlight)?.li.scrollIntoView({ block: 'nearest' });
    }
    this.lastHighlight = snapshot.highlight;
  }

  private roleTag(role: Role | null): HTMLElement {
    if (role === null) return tag('无法识别', 'red', 'alert');
    return tag(ROLE_LABELS[role], ROLE_COLORS[role], role === 'none' ? undefined : role === 'companion' ? 'users' : role === 'guard' ? 'shield' : 'star');
  }
}
