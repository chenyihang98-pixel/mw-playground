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
import { displayTitle } from '../levels/titles';
import { WorkshopClient } from '../../workshop/client';
import { WorkshopController, type WorkshopView } from '../../workshop/controller';
import { OUTCOME_LABELS, type Fallback, type PersonRole, type RosterPersonSnapshot } from '../../workshop/protocol';
import { button, el, notice, tag } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { drawLevelMap, visualLabel } from './levelInfo';
import type { WorkshopSnapshot } from '../appTypes';
import { t } from '../../i18n';
import { markRaw, rawNotice, rawSpan, richNotice, tNodes } from '../../ui/raw';

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
const CAST_TITLE = t('workshop.castTitle');
const CAST_HINT = t('workshop.castHint');

/** 生成进行时，等待提示下面的说明（F4）。 */
const RUNNING_HINT = t('workshop.runningHint');

const ROLE_CHOICES: readonly [RoleChoice, string][] = [
  ['both', t('workshop.roleBoth')],
  ['companion', t('workshop.roleCompanion')],
  ['guard', t('workshop.roleGuard')],
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
        applyFallback: () => displayTitle(host.applyFallback()).text,
      },
      () => {
        this.changed();
      },
    );
    this.input.rows = 3;
    this.input.placeholder = t('workshop.placeholder');
    this.input.setAttribute('aria-label', t('workshop.inputLabel'));
    this.input.addEventListener('input', () => {
      this.renderCounter();
    });
    this.generateButton = button(t('workshop.generate'), () => {
      void this.controller.generate(this.input.value, this.snapshotRoster());
    }, { icon: 'star', variant: 'primary', className: 'ws-generate' });
    const textLabel = el('label', { className: 'ws-label', text: t('workshop.inputTitle') });
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
      out.push({ id: p.id, name: p.name.slice(0, 64) || t('workshop.unnamed'), roles });
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
      const emptyTitle = el('div', { className: 'ws-label', text: t('workshop.castTitleOptional') });
      this.people.replaceChildren(emptyTitle, el('p', { className: 'mw-subtle ws-empty', text: t('workshop.noPeople') }));
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
      check.setAttribute('aria-label', t('workshop.letAppear', { name: p.name }));
      const name = el('label', { className: 'ws-person-name' });
      // 人名是名册里的用户数据，原样显示
      name.append(check, markRaw(el('span', { text: p.name })));
      const select = el('select', { className: 'mw-select' });
      for (const [value, label] of ROLE_CHOICES) select.add(new Option(label, value));
      select.value = choice.roles;
      select.disabled = !choice.checked;
      select.setAttribute('aria-label', t('workshop.canBe', { name: p.name }));
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
    if (!health) this.status.replaceChildren(tag(t('workshop.checking'), 'default', 'refresh'));
    else if (health.kind === 'unreachable') this.status.replaceChildren(tag(t('workshop.serviceUnavailable'), 'orange', 'alert'));
    else {
      const h = health.health;
      this.status.replaceChildren(
        tag(h.available ? t('workshop.modelAvailable') : t('workshop.modelUnavailable'), h.available ? 'green' : 'orange', h.available ? 'check' : 'alert'),
        tag(`${h.provider}${h.model ? ` · ${h.model}` : ''}`, 'default', 'layers'),
      );
    }
    const usable = this.controller.usable;
    const showUnavailable = health !== null && !usable.ok && this.controller.view.kind !== 'running';
    this.unavailable.hidden = !showUnavailable;
    if (showUnavailable) {
      const list = el('ul', { className: 'mw-notices' });
      // 原因是服务端健康检查写的（F7 起按界面的语言），原样显示
      list.append(richNotice('warning', tNodes('workshop.unavailableNotice', { reason: rawSpan(usable.reason) })));
      this.unavailable.replaceChildren(
        list,
        button(t('workshop.useRandom'), () => {
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
        box.append(spinner, el('span', { text: t('workshop.running', { seconds: String(seconds) }) }));
        parts.push(
          box,
          // F4：生成前要先加载模型（F2），冷启动时可能要等一阵；只在生成进行时显示
          el('p', { className: 'mw-subtle ws-note', text: RUNNING_HINT }),
          button(t('workshop.stop'), () => {
            this.controller.cancel();
          }, { icon: 'close' }),
        );
        break;
      }
      case 'cancelled':
        parts.push(el('p', { className: 'mw-muted ws-note', text: t('workshop.cancelled') }));
        break;
      case 'message': {
        const list = el('ul', { className: 'mw-notices' });
        list.append(notice(view.level, view.text));
        parts.push(list);
        break;
      }
      case 'saved': {
        const list = el('ul', { className: 'mw-notices' });
        // 标题是模型写的，原样显示
        list.append(richNotice('info', tNodes('workshop.saved', { title: rawSpan(view.title) })));
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
      // 回退的原因和差别是服务端按请求的语言写的（F7），可能带名册里的名字，原样显示
      richNotice(fallback.outcome === 'error' ? 'error' : 'warning', tNodes('workshop.fellBack', { title, reason: rawSpan(fallback.reason) })),
      ...fallback.differences.map((d) => rawNotice('info', d)),
    );
    const parts: HTMLElement[] = [list];
    if (fallback.history.length > 0) parts.push(this.historyBox(fallback.history));
    return parts;
  }

  private historyBox(history: readonly string[]): HTMLElement {
    const box = el('details', { className: 'ws-history' });
    box.append(el('summary', { text: t('workshop.historyTitle', { count: String(history.length) }) }));
    const list = el('ol');
    // 修复记录是服务端按请求的语言写的（F7），可能带名册里的名字，原样显示
    for (const h of history) list.append(markRaw(el('li', { text: h })));
    box.append(list);
    return box;
  }

  private previewParts(view: Extract<WorkshopView, { kind: 'preview' }>): HTMLElement[] {
    const { preview, pkg } = view;
    const brief = pkg.brief;
    const head = el('div', { className: 'ws-preview-head' });
    // 标题、开场白、台词是模型写的（F7 起提示词要求用界面的语言），原样显示
    head.append(markRaw(el('strong', { className: 'ws-title', text: pkg.title })));
    const tags = el('div', { className: 'level-tags' });
    tags.append(
      tag(t('source.model'), 'purple', 'layers'),
      tag(OUTCOME_LABELS[preview.outcome], preview.outcome === 'model-first' ? 'green' : preview.outcome === 'model-repaired' ? 'blue' : 'orange', 'check'),
      tag(t('workshop.repairs', { count: String(preview.repairs) }), 'default'),
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
    fact(t('preview.timeLimit'), t('preview.timeLimitValue', { seconds: String(pkg.rules.timeLimit) }));
    fact(t('preview.gems'), t('preview.count', { count: String(pkg.rules.target) }));
    fact(t('preview.guards'), t('preview.count', { count: String(pkg.layout.guards.length) }));
    fact(t('preview.platforms'), t('preview.count', { count: String(pkg.layout.platforms.length) }));
    fact(t('preview.visual'), visualLabel(pkg));
    body.append(mapBox, facts);
    const parts: HTMLElement[] = [head, body];
    if (brief?.opening) parts.push(markRaw(el('p', { className: 'random-opening', text: brief.opening })));
    const names = new Map(this.host.people().map((p) => [p.id, p.name]));
    for (const c of brief?.cast ?? []) {
      if (!c.line) continue;
      const line = markRaw(el('p', { className: 'ws-line' }));
      line.append(
        el('strong', { text: t('intro.speaker', { name: names.get(c.personId) ?? t('workshop.notInRoster'), role: c.role === 'guard' ? t('role.guard') : t('role.companion') }) }),
        document.createTextNode(t('intro.line', { line: c.line })),
      );
      parts.push(line);
    }
    if (preview.adjustment) {
      const list = el('ul', { className: 'mw-notices' });
      // 调整的说明和差别是服务端按请求的语言写的（F7），原样显示
      list.append(
        richNotice('warning', tNodes('workshop.adjusted', { change: rawSpan(preview.adjustment.change), message: rawSpan(preview.adjustment.message) })),
        ...preview.differences.map((d) => richNotice('info', tNodes('workshop.mainChange', { change: rawSpan(d) }))),
      );
      parts.push(list);
    }
    if (preview.history.length > 0) parts.push(this.historyBox(preview.history));
    if (view.error) {
      const list = el('ul', { className: 'mw-notices' });
      list.append(notice('error', view.error));
      parts.push(list);
    }
    const checked = el('p', { className: 'random-checked' });
    checked.append(icon('check', 'mw-icon'), document.createTextNode(t('preview.checked')));
    const actions = el('div', { className: 'random-actions' });
    const confirm = button(view.confirming ? t('workshop.confirming') : t('workshop.confirm'), () => {
      void this.controller.confirm();
    }, { icon: 'check', variant: 'primary', label: t('workshop.confirmLabel') });
    confirm.disabled = view.confirming;
    actions.append(
      confirm,
      button(t('workshop.retry'), () => {
        if (this.controller.discard()) {
          this.input.focus();
          this.input.select();
        }
      }, { icon: 'edit' }),
      button(t('workshop.discard'), () => {
        this.controller.discard();
      }, { icon: 'close', variant: 'ghost', label: t('workshop.discardLabel') }),
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
