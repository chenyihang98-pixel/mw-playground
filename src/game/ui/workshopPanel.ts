// 关卡工坊的界面（P8），放在选关界面的右栏。视觉沿用 P6 的设计约定（docs/design.md）。
// - 输入一句话，勾选出场人物（每人可以选允许的分工），生成；
// - 生成中显示状态，可以停止（取消不算失败，不回退）；
// - 预览：来源、修复次数、程序调整的原因和主要变化、开场白和台词；确认、改一句话重来、放弃；
// - 最终失败时已经加载了内置的回退关卡：说明来源、原因和与请求的主要差别；
// - 服务不可用（没启动、提供方是 off、模型连不上）：说明原因，并提供“随机一关”作为替代；游戏的其他部分照常。
// 状态和异步结果的处理在 WorkshopController（src/workshop/controller.ts，不碰 DOM，有单元测试），这里只负责显示。

import './workshopPanel.css';
import type { LevelPackage } from '../levels/package';
import { FALLBACK_LEVEL_ID } from '../level/generatedLevels';
import { WorkshopClient } from '../../workshop/client';
import { WorkshopController, type WorkshopView } from '../../workshop/controller';
import { OUTCOME_LABELS, type Fallback, type PersonRole, type RosterPersonSnapshot } from '../../workshop/protocol';
import { button, el, notice, tag } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { drawLevelMap, visualLabel } from './levelInfo';
import type { WorkshopSnapshot } from '../appTypes';

export interface WorkshopPanelHost {
  /** 名册里可以出场的人物（已恢复好的）。 */
  people(): readonly { readonly id: string; readonly name: string }[];
  /** 确认后：保存（P5 的保存模块）并加载这一关。 */
  applyLevel(pkg: LevelPackage): void;
  /** 最终失败：加载内置的回退关卡，返回它。 */
  applyFallback(): LevelPackage;
  /** 改用“随机一关”。 */
  startRandom(): void;
}

type RoleChoice = 'both' | PersonRole;

/** 出场人物区的标题和说明（F3：工坊生成的关卡，没勾选的人不出场）。 */
const CAST_TITLE = '出场人物（没勾选的人不出场）';
const CAST_HINT = '一个都不勾选时，这一关没有同伴，守卫用默认小人；主角仍按名册。';

/** 生成进行时，等待提示下面的说明（F4）。 */
const RUNNING_HINT = '第一次生成要先把模型加载进显卡；长时间没用之后可能要等几十秒。';

const ROLE_CHOICES: readonly [RoleChoice, string][] = [
  ['both', '同伴或守卫'],
  ['companion', '只当同伴'],
  ['guard', '只当守卫'],
];

export class WorkshopPanel {
  readonly root = el('div', { id: 'level-workshop' });
  private readonly status = el('div', { className: 'ws-status' });
  private readonly unavailable = el('div', { className: 'ws-unavailable' });
  private readonly form = el('div', { className: 'ws-form' });
  private readonly input = el('textarea', { className: 'mw-input ws-text' });
  private readonly counter = el('span', { className: 'mw-subtle ws-counter' });
  private readonly people = el('div', { className: 'ws-people' });
  private readonly generateButton: HTMLButtonElement;
  private readonly result = el('div', { className: 'ws-result' });
  private readonly controller: WorkshopController;
  private readonly choices = new Map<string, { checked: boolean; roles: RoleChoice }>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private peopleKey = '';
  private lastKind: WorkshopView['kind'] = 'idle';

  constructor(
    private readonly host: WorkshopPanelHost,
    client: WorkshopClient = new WorkshopClient(),
  ) {
    this.controller = new WorkshopController(
      client,
      {
        applyLevel: (pkg) => {
          host.applyLevel(pkg);
        },
        applyFallback: () => host.applyFallback().title,
      },
      () => {
        this.changed();
      },
    );
    this.input.rows = 3;
    this.input.placeholder = '例如：下雨的夜晚，中等大小的地图，宝石都藏在高台上，两个守卫来回巡逻。';
    this.input.setAttribute('aria-label', '一句话描述想玩的关卡');
    this.input.addEventListener('input', () => {
      this.renderCounter();
    });
    this.generateButton = button('生成关卡', () => {
      void this.controller.generate(this.input.value, this.snapshotRoster());
    }, { icon: 'star', variant: 'primary', className: 'ws-generate' });
    const textLabel = el('label', { className: 'ws-label', text: '用一句话描述想玩的关卡' });
    const textRow = el('div', { className: 'ws-text-row' });
    textRow.append(this.input, this.counter);
    this.form.append(textLabel, textRow, this.people, this.generateButton);
    this.root.append(this.status, this.unavailable, this.form, this.result);
    this.render();
  }

  /** 选关界面打开时：查一次服务状态，刷新人物列表。 */
  refresh(): void {
    this.renderPeople();
    if (this.controller.view.kind !== 'running') void this.controller.checkHealth();
  }

  private get maxChars(): number {
    const health = this.controller.health;
    return health?.kind === 'ok' ? health.health.maxRequestChars : 200;
  }

  private snapshotRoster(): RosterPersonSnapshot[] {
    const out: RosterPersonSnapshot[] = [];
    for (const p of this.host.people()) {
      const choice = this.choices.get(p.id);
      if (!choice?.checked) continue;
      const roles: PersonRole[] = choice.roles === 'both' ? ['companion', 'guard'] : [choice.roles];
      out.push({ id: p.id, name: p.name.slice(0, 64) || '（无名）', roles });
    }
    return out;
  }

  /** 控制器的状态变了：重画，生成中每秒刷新一次已用的时间。 */
  private changed(): void {
    const view = this.controller.view;
    if (view.kind === 'running' && this.ticker === null) {
      this.ticker = setInterval(() => {
        this.renderResult();
      }, 1000);
    }
    if (view.kind !== 'running' && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.render();
    // 预览、回退和提示出现在右栏下方：滚到能看见的位置
    if (view.kind !== this.lastKind && (view.kind === 'preview' || view.kind === 'fallback' || view.kind === 'message')) this.result.scrollIntoView({ block: 'nearest' });
    this.lastKind = view.kind;
  }

  private renderCounter(): void {
    const length = this.input.value.trim().length;
    this.counter.textContent = `${String(length)} / ${String(this.maxChars)}`;
    this.counter.classList.toggle('is-over', length > this.maxChars);
    this.generateButton.disabled = length === 0 || length > this.maxChars || this.controller.locked || !this.controller.usable.ok;
  }

  private renderPeople(): void {
    const people = this.host.people();
    const key = people.map((p) => `${p.id}:${p.name}`).join('|');
    if (key === this.peopleKey && this.people.childElementCount > 0) return;
    this.peopleKey = key;
    if (people.length === 0) {
      // 名册里没有可以出场的人物：显示和以前一样
      const emptyTitle = el('div', { className: 'ws-label', text: '出场人物（可以不选）' });
      this.people.replaceChildren(emptyTitle, el('p', { className: 'mw-subtle ws-empty', text: '名册里还没有可以出场的人物。' }));
      return;
    }
    const title = el('div', { className: 'ws-label', text: CAST_TITLE });
    const hint = el('p', { className: 'mw-subtle ws-note', text: CAST_HINT });
    const rows = people.map((p) => {
      const choice = this.choices.get(p.id) ?? { checked: false, roles: 'both' as RoleChoice };
      this.choices.set(p.id, choice);
      const row = el('div', { className: 'ws-person' });
      const check = el('input');
      check.type = 'checkbox';
      check.checked = choice.checked;
      check.setAttribute('aria-label', `让 ${p.name} 出场`);
      const name = el('label', { className: 'ws-person-name' });
      name.append(check, el('span', { text: p.name }));
      const select = el('select', { className: 'mw-select' });
      for (const [value, label] of ROLE_CHOICES) select.add(new Option(label, value));
      select.value = choice.roles;
      select.disabled = !choice.checked;
      select.setAttribute('aria-label', `${p.name} 可以当`);
      select.dataset.personId = p.id;
      check.addEventListener('change', () => {
        choice.checked = check.checked;
        select.disabled = !check.checked;
      });
      select.addEventListener('change', () => {
        choice.roles = select.value as RoleChoice;
      });
      row.append(name, select);
      return row;
    });
    this.people.replaceChildren(title, hint, ...rows);
  }

  private render(): void {
    // 状态标签：提供方和模型名（不含密钥）
    const health = this.controller.health;
    if (!health) this.status.replaceChildren(tag('正在检查工坊服务…', 'default', 'refresh'));
    else if (health.kind === 'unreachable') this.status.replaceChildren(tag('工坊服务不可用', 'orange', 'alert'));
    else {
      const h = health.health;
      this.status.replaceChildren(
        tag(h.available ? '模型可用' : '模型不可用', h.available ? 'green' : 'orange', h.available ? 'check' : 'alert'),
        tag(`${h.provider}${h.model ? ` · ${h.model}` : ''}`, 'default', 'layers'),
      );
    }
    const usable = this.controller.usable;
    const showUnavailable = health !== null && !usable.ok && this.controller.view.kind !== 'running';
    this.unavailable.hidden = !showUnavailable;
    if (showUnavailable) {
      const list = el('ul', { className: 'mw-notices' });
      list.append(notice('warning', `${usable.reason}。可以先玩“随机一关”，游戏的其他部分照常。`));
      this.unavailable.replaceChildren(
        list,
        button('改用随机一关', () => {
          this.host.startRandom();
        }, { icon: 'dice', variant: 'accent', className: 'ws-random' }),
      );
    }
    this.form.hidden = showUnavailable;
    const running = this.controller.view.kind === 'running';
    this.input.disabled = running;
    this.input.maxLength = this.maxChars;
    for (const control of this.people.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      const personId = control.dataset.personId;
      control.disabled = running || (personId !== undefined && this.choices.get(personId)?.checked !== true);
    }
    this.renderCounter();
    this.renderResult();
  }

  private renderResult(): void {
    const view = this.controller.view;
    const parts: HTMLElement[] = [];
    switch (view.kind) {
      case 'idle':
        break;
      case 'running': {
        const seconds = Math.max(0, Math.round((Date.now() - view.startedAt) / 1000));
        const box = el('div', { className: 'ws-running' });
        const spinner = el('span', { className: 'ws-spinner' });
        spinner.setAttribute('aria-hidden', 'true');
        box.append(spinner, el('span', { text: `正在准备模型并写说明书，程序随后生成并检查布局…（${String(seconds)} 秒）` }));
        parts.push(
          box,
          // F4：生成前要先加载模型（F2），冷启动时可能要等一阵；只在生成进行时显示
          el('p', { className: 'mw-subtle ws-note', text: RUNNING_HINT }),
          button('停止生成', () => {
            this.controller.cancel();
          }, { icon: 'close' }),
        );
        break;
      }
      case 'cancelled':
        parts.push(el('p', { className: 'mw-muted ws-note', text: '已取消这次生成（不算失败，也没有换关卡）。' }));
        break;
      case 'message': {
        const list = el('ul', { className: 'mw-notices' });
        list.append(notice(view.level, view.text));
        parts.push(list);
        break;
      }
      case 'saved': {
        const list = el('ul', { className: 'mw-notices' });
        list.append(notice('info', `“${view.title}”已经保存到“已保存的关卡”，并加载好了。`));
        parts.push(list);
        break;
      }
      case 'fallback':
        parts.push(...this.fallbackParts(view.fallback, view.title));
        break;
      case 'preview':
        parts.push(...this.previewParts(view));
        break;
    }
    this.result.replaceChildren(...parts);
  }

  private fallbackParts(fallback: Fallback, title: string): HTMLElement[] {
    const list = el('ul', { className: 'mw-notices' });
    list.append(
      notice(fallback.outcome === 'error' ? 'error' : 'warning', `已回退到内置关卡“${title}”（来源：内置回退关卡，不是模型做的）。原因：${fallback.reason}`),
      ...fallback.differences.map((d) => notice('info', d)),
    );
    const parts: HTMLElement[] = [list];
    if (fallback.history.length > 0) parts.push(this.historyBox(fallback.history));
    return parts;
  }

  private historyBox(history: readonly string[]): HTMLElement {
    const box = el('details', { className: 'ws-history' });
    box.append(el('summary', { text: `模型的修复记录（${String(history.length)} 条）` }));
    const list = el('ol');
    for (const h of history) list.append(el('li', { text: h }));
    box.append(list);
    return box;
  }

  private previewParts(view: Extract<WorkshopView, { kind: 'preview' }>): HTMLElement[] {
    const { preview, pkg } = view;
    const brief = pkg.brief;
    const head = el('div', { className: 'ws-preview-head' });
    head.append(el('strong', { className: 'ws-title', text: pkg.title }));
    const tags = el('div', { className: 'level-tags' });
    tags.append(
      tag('模型生成', 'purple', 'layers'),
      tag(OUTCOME_LABELS[preview.outcome], preview.outcome === 'model-first' ? 'green' : preview.outcome === 'model-repaired' ? 'blue' : 'orange', 'check'),
      tag(`修复 ${String(preview.repairs)} 次`, 'default'),
      tag(`${preview.provider}${preview.model ? ` · ${preview.model}` : ''}`, 'default'),
    );
    head.append(tags);
    const body = el('div', { className: 'random-preview' });
    const map = el('canvas', { className: 'level-map', id: 'workshop-preview-map' });
    map.width = 260;
    map.height = 260;
    map.setAttribute('aria-hidden', 'true');
    drawLevelMap(map, pkg);
    const mapBox = el('div', { className: 'random-map' });
    mapBox.append(map);
    const facts = el('dl', { className: 'random-facts' });
    const fact = (k: string, v: string) => {
      const box = el('div');
      box.append(el('dt', { text: k }), el('dd', { text: v }));
      facts.append(box);
    };
    fact('时间限制', `${String(pkg.rules.timeLimit)} 秒（估计值）`);
    fact('宝石', `${String(pkg.rules.target)} 个`);
    fact('守卫', `${String(pkg.layout.guards.length)} 个`);
    fact('高台', `${String(pkg.layout.platforms.length)} 个`);
    fact('视觉', visualLabel(pkg));
    body.append(mapBox, facts);
    const parts: HTMLElement[] = [head, body];
    if (brief?.opening) parts.push(el('p', { className: 'random-opening', text: brief.opening }));
    const names = new Map(this.host.people().map((p) => [p.id, p.name]));
    for (const c of brief?.cast ?? []) {
      if (!c.line) continue;
      const line = el('p', { className: 'ws-line' });
      line.append(el('strong', { text: `${names.get(c.personId) ?? '（不在名册里的人物）'}（${c.role === 'guard' ? '守卫' : '同伴'}）` }), document.createTextNode(`：${c.line}`));
      parts.push(line);
    }
    if (preview.adjustment) {
      const list = el('ul', { className: 'mw-notices' });
      list.append(notice('warning', `程序调整过一次：${preview.adjustment.change}（原因：${preview.adjustment.message}）`), ...preview.differences.map((d) => notice('info', `主要变化：${d}`)));
      parts.push(list);
    }
    if (preview.history.length > 0) parts.push(this.historyBox(preview.history));
    if (view.error) {
      const list = el('ul', { className: 'mw-notices' });
      list.append(notice('error', view.error));
      parts.push(list);
    }
    const checked = el('p', { className: 'random-checked' });
    checked.append(icon('check', 'mw-icon'), document.createTextNode('空间与规则检查通过，难度为估计。'));
    const actions = el('div', { className: 'random-actions' });
    const confirm = button(view.confirming ? '正在确认…' : '确认', () => {
      void this.controller.confirm();
    }, { icon: 'check', variant: 'primary', label: '确认工坊关卡' });
    confirm.disabled = view.confirming;
    actions.append(
      confirm,
      button('改一句话重来', () => {
        if (this.controller.discard()) {
          this.input.focus();
          this.input.select();
        }
      }, { icon: 'edit' }),
      button('放弃', () => {
        this.controller.discard();
      }, { icon: 'close', variant: 'ghost', label: '放弃工坊关卡' }),
    );
    parts.push(checked, actions);
    return parts;
  }

  snapshot(): WorkshopSnapshot {
    const health = this.controller.health;
    const view = this.controller.view;
    return {
      health: !health
        ? { kind: 'checking', provider: null, model: null, available: false, reason: null }
        : health.kind === 'unreachable'
          ? { kind: 'unreachable', provider: null, model: null, available: false, reason: health.reason }
          : { kind: 'ok', provider: health.health.provider, model: health.health.model, available: health.health.available, reason: health.health.reason },
      view: view.kind,
      generationId: view.kind === 'running' || view.kind === 'preview' || view.kind === 'fallback' || view.kind === 'saved' ? view.generationId : null,
      previewHash: view.kind === 'preview' ? view.pkg.layoutHash : null,
      outcome: view.kind === 'preview' ? view.preview.outcome : view.kind === 'fallback' ? view.fallback.outcome : null,
      repairs: view.kind === 'preview' ? view.preview.repairs : null,
      fallbackId: view.kind === 'fallback' ? FALLBACK_LEVEL_ID : null,
      message: view.kind === 'message' ? view.text : null,
      saves: this.controller.saves,
    };
  }
}
