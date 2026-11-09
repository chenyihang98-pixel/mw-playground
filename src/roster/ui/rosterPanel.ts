// 名册界面：人物列表（显示名、分工、恢复失败的项单独标出）、设分工、改名、打开导入卡片修改设置、删除（二次确认）、
// 恢复默认主角，以及提示（重复加入、名册已满、存储失败、恢复失败、分配时不出场的人物）。功能能用就行，视觉留给 P6。
//
// 每一行的控件按人物建一次，名册变化时只刷新文字和选中项；正在输入的显示名不会被覆盖。

import './roster.css';
import { ROLE_LABELS, ROLES, type Role } from '../config';
import type { Roster } from '../roster';

export interface RosterPanelHost {
  /** 游戏正在进行：这时隐藏名册界面。 */
  isPlaying(): boolean;
  /** 在导入卡片里打开这个人物，修改设置。 */
  openCard(key: string): void;
  /** 删除这个人物（已经确认过）。 */
  remove(key: string): void;
  /** 分配时的提示（例如守卫人物比关卡里的守卫多）。 */
  castNotices(): readonly string[];
}

interface Row {
  readonly tr: HTMLTableRowElement;
  readonly name: HTMLInputElement;
  readonly rename: HTMLButtonElement;
  readonly role: HTMLSelectElement;
  readonly status: HTMLTableCellElement;
  readonly open: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: { id?: string; className?: string; text?: string } = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.id) node.id = attrs.id;
  if (attrs.className) node.className = attrs.className;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { text });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export class RosterPanel {
  private readonly panel = el('section', { id: 'roster-panel' });
  private readonly title = el('h2');
  private readonly storage = el('div', { id: 'roster-storage' });
  private readonly notices = el('ul', { id: 'roster-notices' });
  private readonly table = el('table', { id: 'roster-table' });
  private readonly empty = el('div', { className: 'empty', text: '名册是空的：导入角色后点“加入为新人物”或“设为主角”。' });
  private readonly rows = new Map<string, Row>();
  private readonly confirming = new Set<string>();
  private visible = true;
  private lastHighlight: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly roster: Roster,
    private readonly host: RosterPanelHost,
  ) {
    this.panel.setAttribute('aria-label', '名册');
    this.storage.setAttribute('role', 'alert');
    this.notices.setAttribute('role', 'status');
    const header = el('div', { className: 'row' });
    header.append(
      this.title,
      button('恢复默认主角', () => {
        this.roster.restoreDefaultPlayer();
      }),
    );
    this.panel.append(header, this.storage, this.notices, this.empty, this.table);
    root.append(this.panel);
    this.refresh();
  }

  private buildRow(key: string): Row {
    const tr = el('tr');
    tr.dataset.key = key;
    const name = el('input');
    name.type = 'text';
    const rename = button('改名', () => {
      const result = this.roster.rename(key, name.value);
      if (!result.ok) name.setCustomValidity(result.error);
      else name.setCustomValidity('');
    });
    const role = el('select');
    for (const r of ROLES) role.add(new Option(ROLE_LABELS[r], r));
    role.addEventListener('change', () => {
      const result = this.roster.setRole(key, role.value as Role);
      if (!result.ok) this.refresh();
    });
    const status = el('td', { className: 'status' });
    const open = button('打开卡片', () => {
      this.host.openCard(key);
    });
    const remove = button('删除', () => {
      this.confirming.add(key);
      this.refresh();
    });
    const confirm = button('确认删除', () => {
      this.confirming.delete(key);
      this.host.remove(key);
    });
    confirm.className = 'danger';
    const cancel = button('取消', () => {
      this.confirming.delete(key);
      this.refresh();
    });
    const nameCell = el('td');
    nameCell.append(name, rename);
    const roleCell = el('td');
    roleCell.append(role);
    const actions = el('td');
    actions.append(open, remove, confirm, cancel);
    tr.append(nameCell, roleCell, status, actions);
    return { tr, name, rename, role, status, open, remove, confirm, cancel };
  }

  /** 名册变化后刷新。 */
  refresh(): void {
    const snapshot = this.roster.snapshot();
    this.title.textContent = `名册（${String(snapshot.entries.length)} / ${String(snapshot.max)}）${snapshot.restoring ? '：正在恢复…' : ''}`;
    this.storage.textContent = snapshot.storage.problem ?? '';
    this.notices.replaceChildren(...[...snapshot.notices, ...this.host.castNotices()].map((n) => el('li', { text: n })));
    this.empty.hidden = snapshot.entries.length > 0;

    const keys = new Set(snapshot.entries.map((e) => e.key));
    for (const [key, row] of this.rows) {
      if (!keys.has(key)) {
        row.tr.remove();
        this.rows.delete(key);
        this.confirming.delete(key);
      }
    }
    const ordered: HTMLTableRowElement[] = [];
    for (const entry of snapshot.entries) {
      let row = this.rows.get(entry.key);
      if (!row) {
        row = this.buildRow(entry.key);
        this.rows.set(entry.key, row);
      }
      const name = entry.displayName;
      const ready = entry.status === 'ready';
      row.tr.classList.toggle('failed', entry.status === 'failed');
      row.tr.classList.toggle('highlight', entry.highlighted);
      if (document.activeElement !== row.name) row.name.value = name;
      row.name.disabled = entry.role === null;
      row.name.setAttribute('aria-label', `${name} 的显示名`);
      row.rename.disabled = entry.role === null;
      row.rename.setAttribute('aria-label', `保存 ${name} 的显示名`);
      row.role.value = entry.role ?? 'none';
      row.role.disabled = !ready;
      row.role.setAttribute('aria-label', `${name} 的分工`);
      row.status.textContent = entry.status === 'failed' ? `恢复失败：${entry.error ?? ''}` : entry.status === 'loading' ? '正在恢复…' : (entry.roleLabel ?? '');
      row.open.disabled = !ready;
      row.open.setAttribute('aria-label', `打开 ${name} 的导入卡片`);
      const confirming = this.confirming.has(entry.key);
      row.remove.hidden = confirming;
      row.remove.setAttribute('aria-label', `删除 ${name}`);
      row.confirm.hidden = !confirming;
      row.confirm.setAttribute('aria-label', `确认删除 ${name}`);
      row.cancel.hidden = !confirming;
      row.cancel.setAttribute('aria-label', `取消删除 ${name}`);
      ordered.push(row.tr);
    }
    // 按名册顺序排列（只移动位置不对的行，不重建控件）
    ordered.forEach((tr, i) => {
      if (this.table.rows[i] !== tr) this.table.insertBefore(tr, this.table.rows[i] ?? null);
    });
    if (snapshot.highlight !== null && snapshot.highlight !== this.lastHighlight) {
      this.rows.get(snapshot.highlight)?.tr.scrollIntoView({ block: 'nearest' });
    }
    this.lastHighlight = snapshot.highlight;
  }

  /** 每帧：游玩时隐藏。 */
  update(): void {
    const playing = this.host.isPlaying();
    if (playing === this.visible) {
      this.visible = !playing;
      this.panel.hidden = playing;
    }
  }
}
