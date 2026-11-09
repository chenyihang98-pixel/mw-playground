// 导入界面：“导入角色”按钮（文件选择框）、把文件拖进窗口、错误提示、导入卡片（预览、尺寸、片段列表、提示、
// 旋转按钮、身高滑块、“设为主角”、“加入为新人物”）。
// P6：卡片是右侧的主面板（由 PanelManager 管显示），提示分错误、警告、说明三级；没有骨骼的模型不说“绑定姿态”，说“静止姿态”（M3）。
// 只改展示：导入流程、兜底规则和保存的内容都不变。
// P4 起：“加入为新人物”把资产加入名册；“设为主角”在还不在名册里时先加入再设为主角。名册里的人物也能在这里打开、修改设置
// （设置一变名册就保存）。名册里的资产由名册释放，卡片关闭时不释放。
//
// 卡片里的控件（身高滑块、旋转按钮、操作按钮）只在打开卡片时建一次；设置变化时只刷新文字、提示和片段表，
// 不重建正在操作的控件，拖动滑块或连续按方向键时不会丢失焦点。片段表重建后把焦点还给同一个控件。

import './import.css';
import { normalizedBox } from '../normalize';
import { NO_MOVEMENT_NOTICE, PURPOSE_LABELS, PURPOSES, type MotionSource, type Playback, type Purpose } from '../clipRules';
import { DISPLAY } from '../limits';
import { LOCK_UNSUPPORTED_MESSAGE } from '../motion';
import { fileSource, importModel } from '../pipeline';
import type { ImportedAsset } from '../asset';
import { PreviewViewport } from './preview';
import type { ClipRowSnapshot, ImportCardSnapshot, ImportPanelSnapshot, NoticeSnapshot } from './types';
import { button, el, notice, setButtonText, tag } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { poseWording } from './wording';

export type HostResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly error: string };

export interface ImportPanelHost {
  /** 游戏正在进行（指针锁定、计时中）：这时隐藏导入界面。 */
  isPlaying(): boolean;
  /** 加入名册（file 是原文件；从名册打开的卡片为 null）。 */
  addPerson(asset: ImportedAsset, file: Blob | null): HostResult;
  /** 设为主角：还不在名册里就先加入，再设为主角。 */
  setPlayer(asset: ImportedAsset, file: Blob | null): HostResult;
  /** 这个资产由名册负责释放（卡片关闭时不释放）。 */
  retains(asset: ImportedAsset): boolean;
  /** 同一个文件（SHA-256）已在名册里。 */
  inRoster(asset: ImportedAsset): boolean;
  /** 同一个文件（SHA-256）是当前的主角。 */
  isPlayer(asset: ImportedAsset): boolean;
  /**
   * 名册里同一个文件（SHA-256）已经加载好的资产；不在名册里或还没恢复好时返回 asset 本身。
   * 卡片总是操作名册里的那一份，修改才会被名册保存。
   */
  canonical(asset: ImportedAsset): ImportedAsset;
  /**
   * 资产和名册的关系：absent 不在名册里；owned 就是名册里的那一份；
   * pending 名册里同一个文件还在恢复；failed 名册里同一个文件恢复失败。
   */
  rosterStatus(asset: ImportedAsset): RosterRelation;
  /** 卡片打开了（P6：交给 PanelManager 显示）。 */
  cardOpened(): void;
  /** 卡片关掉了。 */
  cardClosed(): void;
}

export type RosterRelation = 'absent' | 'owned' | 'pending' | 'failed';

/**
 * 卡片上的设置不能改的原因：资产是名册里已有文件的另一份副本、名册里的那一份还不可用时，在这份副本上的修改
 * 不会被名册保存（恢复好以后卡片会换成名册里的那一份），所以先禁用设置。可以改时返回 null。
 */
export function settingsLockedReason(relation: RosterRelation): string | null {
  switch (relation) {
    case 'pending':
      return '名册里的这个人物还在恢复：恢复好之后卡片会换成名册里的那一份，到时再修改设置（现在的修改不会保存，所以先禁用）';
    case 'failed':
      return '名册里的这个人物恢复失败：先在名册里删除它，再加入这个文件，才能修改并保存设置';
    case 'absent':
    case 'owned':
      return null;
  }
}

function sourceLabel(source: MotionSource | null, skinned: boolean): string {
  if (source === null) return '无（保持当前动作）';
  switch (source.kind) {
    case 'clip':
      return source.timeScale === 1 ? `#${String(source.index)}` : `#${String(source.index)} ×${source.timeScale.toFixed(2)}`;
    case 'firstFrame':
      return `#${String(source.index)} 的第一帧`;
    case 'bindPose':
      return skinned ? '绑定姿态' : '静止姿态';
    case 'sway':
      return '整体摆动';
  }
}

const PLAYBACK_LABELS: Readonly<Record<Playback, string>> = { loop: '循环', once: '一次' };

/** 说明级的兜底提示里，这几条是“能用但效果打了折扣”，按警告显示。 */
const DEGRADED_NOTICES: readonly string[] = [NO_MOVEMENT_NOTICE];

/** 卡片里需要随设置刷新的部分。 */
interface CardParts {
  readonly stats: HTMLElement;
  readonly slider: HTMLInputElement;
  readonly heightValue: HTMLElement;
  readonly turnText: HTMLElement;
  readonly notices: HTMLUListElement;
  readonly plan: HTMLElement;
  readonly clips: HTMLOListElement;
  readonly clipCount: HTMLElement;
  readonly setPlayer: HTMLButtonElement;
  readonly addPerson: HTMLButtonElement;
  readonly rotateLeft: HTMLButtonElement;
  readonly rotateRight: HTMLButtonElement;
  /** 设置被禁用时的说明。 */
  readonly lockNote: HTMLElement;
}

/** 状态提示条显示多久后自动消失（毫秒）。 */
const STATUS_TOAST_MS = 6000;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

export class ImportPanel {
  /** “导入角色”按钮（P6 起放在顶栏里）。 */
  readonly importButton = el('button', { id: 'import-button', text: '导入角色' });
  private readonly input = el('input', { id: 'import-file' });
  private readonly toasts = el('div', { id: 'mw-toasts' });
  private readonly status = el('div', { id: 'import-status' });
  private readonly errorBox = el('div', { id: 'import-error' });
  private readonly errorText = el('span');
  private readonly dropHint = el('div', { id: 'import-drop-hint' });
  private readonly card = el('section', { id: 'import-card', className: 'mw-panel mw-main-panel' });
  private readonly preview = new PreviewViewport(420, 260);
  private asset: ImportedAsset | null = null;
  /** 卡片上资产的原文件（导入时的 File）；从名册打开的卡片为 null。 */
  private file: Blob | null = null;
  private parts: CardParts | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  private error: string | null = null;
  /** 最近一次导入（成功或失败）的提示。卡片上显示的是卡片所属资产自己的提示。 */
  private warnings: readonly string[] = [];
  /** PanelManager 让卡片显示（游玩中、别的面板在上面时为 false）。 */
  private shown = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    root: HTMLElement,
    private readonly host: ImportPanelHost,
  ) {
    this.input.type = 'file';
    this.input.accept = '.glb,.obj,.stl,.ply';
    this.input.hidden = true;
    this.importButton.type = 'button';
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.hidden = true;
    this.errorBox.append(icon('alert'), this.errorText);
    this.status.setAttribute('role', 'status');
    this.card.setAttribute('aria-label', '导入预览');
    this.card.hidden = true;
    this.dropHint.hidden = true;
    const dropInner = el('div', { className: 'drop-inner' });
    dropInner.append(icon('upload', 'mw-icon drop-icon'), el('strong', { text: '松开鼠标导入模型' }), el('span', { text: '.glb / .obj / .stl / .ply' }));
    this.dropHint.append(dropInner);
    this.toasts.append(this.errorBox, this.status);
    root.append(this.input, this.toasts, this.dropHint, this.card);

    this.importButton.addEventListener('click', () => {
      this.chooseFile();
    });
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      if (file) void this.importFile(file);
    });
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true;
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || this.host.isPlaying()) return;
      e.preventDefault();
      this.dropHint.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) this.dropHint.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      this.dropHint.hidden = true;
      if (!hasFiles(e) || this.host.isPlaying()) return;
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) void this.importFile(file);
    });
  }

  /** 打开文件选择框（顶栏和开始界面的“导入角色”）。 */
  chooseFile(): void {
    if (this.busy) return;
    this.input.value = '';
    this.input.click();
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = text === '' ? null : setTimeout(() => {
      this.status.textContent = '';
      this.statusTimer = null;
    }, STATUS_TOAST_MS);
  }

  private setError(message: string | null): void {
    this.error = message;
    this.errorText.textContent = message === null ? '' : `导入失败：${message}`;
    this.errorBox.hidden = message === null;
  }

  async importFile(file: File): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.importButton.disabled = true;
    this.setStatus(`正在导入 ${file.name}…`);
    this.setError(null);
    try {
      const outcome = await importModel(fileSource(file));
      this.warnings = outcome.warnings;
      if (!outcome.ok) {
        // 失败时不动当前的卡片、主角和场景
        this.setError(outcome.error);
        this.setStatus('');
        return;
      }
      const own = this.host.canonical(outcome.asset);
      if (own !== outcome.asset) {
        // 名册里已有同一个文件：卡片打开名册里的那一份（修改会保存），刚加载的副本释放掉
        outcome.asset.dispose();
        this.open(own, null);
        this.setStatus(`${file.name} 已在名册里：卡片显示的是名册里的这一项，修改会保存`);
        return;
      }
      this.open(outcome.asset, file);
      this.setStatus(`已导入 ${file.name}`);
    } catch (error) {
      this.setError(`文件损坏或格式不对，无法解析：${error instanceof Error ? error.message : String(error)}`);
      this.setStatus('');
    } finally {
      this.busy = false;
      this.importButton.disabled = false;
    }
  }

  /** 打开名册里的人物，修改设置。 */
  openAsset(asset: ImportedAsset): void {
    if (this.asset === asset) {
      this.host.cardOpened();
      return;
    }
    this.open(asset, null);
    this.setStatus(`正在修改 ${asset.fileName} 的设置（自动保存到名册）`);
  }

  private open(asset: ImportedAsset, file: Blob | null): void {
    this.release();
    this.asset = asset;
    this.file = file;
    const { slots } = asset.decisions();
    this.preview.show(asset, slots.idle ?? slots.walk ?? (asset.clips.length > 0 ? 0 : null));
    this.parts = this.buildCard(asset);
    this.unsubscribe = asset.onChange(() => {
      this.refresh();
    });
    this.refresh();
    this.host.cardOpened();
    this.card.hidden = !this.shown;
  }

  /** 释放卡片上的内容（不通知 PanelManager）。 */
  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.preview.clear();
    const asset = this.asset;
    this.asset = null;
    this.file = null;
    this.parts = null;
    if (asset && !this.host.retains(asset) && asset.instanceCount === 0) asset.dispose();
    this.card.hidden = true;
    this.card.replaceChildren();
  }

  /** 关闭卡片：释放预览实例；资产不在名册里（名册不负责释放）时一并释放。 */
  close(): void {
    const had = this.asset !== null;
    this.release();
    if (had) this.host.cardClosed();
  }

  /** PanelManager 控制显示（不释放内容）。 */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.card.hidden = !shown || this.asset === null;
  }

  focusFirst(): void {
    this.card.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }

  /** 当前卡片上的资产（主角替换时用来判断旧资产能不能释放）。 */
  currentAsset(): ImportedAsset | null {
    return this.asset;
  }

  /**
   * 卡片上的资产如果是名册里已有文件的另一份副本（例如导入时名册里那一项还在恢复），换成名册里的那一份。
   * 返回是否换了。
   */
  private rebindToRoster(): boolean {
    const asset = this.asset;
    if (!asset) return false;
    const own = this.host.canonical(asset);
    if (own === asset) return false;
    this.open(own, null);
    this.setStatus(`${own.fileName} 已在名册里：卡片改为显示名册里的这一项，修改会保存`);
    return true;
  }

  /** 卡片的固定部分：只在打开时建一次。 */
  private buildCard(asset: ImportedAsset): CardParts {
    const skinned = asset.stats.skinnedMeshes > 0;
    const header = el('div', { className: 'mw-panel-header' });
    const titleBox = el('div', { className: 'card-title' });
    const title = el('h2', { text: asset.fileName });
    title.title = asset.fileName;
    const meta = el('div', { className: 'card-meta' });
    meta.append(
      tag(asset.format.toUpperCase(), 'blue'),
      tag(formatBytes(asset.sizeBytes)),
      skinned ? tag('带骨骼', 'green', 'user') : tag('静态模型', 'default', 'layers'),
    );
    titleBox.append(title, meta);
    const closeButton = button('关闭', () => {
      this.close();
    }, { icon: 'close', iconOnly: true, variant: 'ghost', label: '关闭' });
    closeButton.dataset.autofocus = 'true';
    header.append(titleBox, closeButton);

    const body = el('div', { className: 'mw-panel-body mw-scroll' });
    const stage = el('div', { className: 'card-stage' });
    stage.append(this.preview.canvas);
    const stats = el('dl', { className: 'card-stats' });

    const lockNote = el('div', { className: 'lock-note mw-notice' });
    lockNote.setAttribute('role', 'note');

    const display = el('div', { className: 'card-section' });
    display.append(el('h3', { className: 'mw-section-title', text: '显示' }));
    const heightRow = el('div', { className: 'card-field' });
    const heightLabel = el('label', { className: 'card-field-label', text: '显示身高' });
    heightLabel.htmlFor = 'import-height';
    const slider = el('input', { id: 'import-height', className: 'mw-range' });
    slider.type = 'range';
    slider.min = String(DISPLAY.minHeight);
    slider.max = String(DISPLAY.maxHeight);
    slider.step = '0.01';
    slider.value = String(asset.settings.displayHeight);
    slider.setAttribute('aria-label', '显示身高');
    slider.addEventListener('input', () => {
      asset.setDisplayHeight(Number(slider.value));
    });
    const heightValue = el('span', { className: 'card-field-value' });
    heightRow.append(heightLabel, slider, heightValue);
    const heightHint = el('p', { className: 'mw-subtle card-hint', text: '身高和转向只影响显示，玩法用的胶囊不变；默认把 +Z 当作正前方。' });

    const turnRow = el('div', { className: 'card-field card-field--turn' });
    const turnText = el('span', { className: 'card-field-value' });
    const rotateLeft = button('向左转 90°', () => {
      asset.rotateQuarter(1);
    }, { icon: 'rotateLeft', size: 'sm' });
    const rotateRight = button('向右转 90°', () => {
      asset.rotateQuarter(-1);
    }, { icon: 'rotateRight', size: 'sm' });
    turnRow.append(el('span', { className: 'card-field-label', text: '正前方' }), rotateLeft, rotateRight, turnText);
    display.append(heightRow, turnRow, heightHint);

    const noticeSection = el('div', { className: 'card-section' });
    const notices = el('ul', { id: 'import-notices', className: 'mw-notices' });
    noticeSection.append(el('h3', { className: 'mw-section-title', text: '提示' }), notices);

    const planSection = el('div', { className: 'card-section' });
    const plan = el('dl', { className: 'card-plan' });
    planSection.append(el('h3', { className: 'mw-section-title', text: '动作安排' }), plan);

    const clipSection = el('div', { className: 'card-section' });
    const clipCount = el('span', { className: 'mw-subtle' });
    const clipTitle = el('h3', { className: 'mw-section-title', text: '片段 ' });
    clipTitle.append(clipCount);
    const clips = el('ol', { id: 'import-clips', className: 'clip-list' });
    clipSection.append(clipTitle, clips);

    body.append(stage, stats, lockNote, display, noticeSection, planSection, clipSection);

    // 操作前先确认卡片上的是名册里的那一份（不是另一份副本）
    const act = (action: (target: ImportedAsset, file: Blob | null) => HostResult) => {
      this.rebindToRoster();
      const target = this.asset;
      if (!target) return;
      const result = action(target, this.file);
      this.setStatus(result.ok ? result.message : result.error);
      this.refresh();
    };
    const setPlayer = button('设为主角', () => {
      act((target, file) => this.host.setPlayer(target, file));
    }, { icon: 'star', variant: 'accent' });
    const addPerson = button('加入为新人物', () => {
      act((target, file) => this.host.addPerson(target, file));
    }, { icon: 'users', variant: 'primary' });
    const footer = el('div', { className: 'mw-panel-footer card-actions' });
    footer.append(setPlayer, addPerson);

    this.card.replaceChildren(header, body, footer);
    return { stats, slider, heightValue, turnText, notices, plan, clips, clipCount, setPlayer, addPerson, rotateLeft, rotateRight, lockNote };
  }

  /** 设置变化后刷新卡片的可变部分；不重建身高滑块和按钮。 */
  private refresh(): void {
    const asset = this.asset;
    const parts = this.parts;
    if (!asset || !parts) return;
    const skinned = asset.stats.skinnedMeshes > 0;
    const { plan } = asset.decisions();
    const size = this.preview.currentInstance()?.normalizedSize();
    const stat = (label: string, value: string) => {
      const box = el('div', { className: 'card-stat' });
      box.append(el('dt', { text: label }), el('dd', { text: value }));
      return box;
    };
    parts.stats.replaceChildren(
      stat('尺寸（米）', `${(size?.width ?? 0).toFixed(2)} × ${(size?.height ?? 0).toFixed(2)} × ${(size?.depth ?? 0).toFixed(2)}`),
      stat('三角面', asset.stats.triangles.toLocaleString('en-US')),
      stat('骨骼', skinned ? String(asset.stats.bones) : '无骨骼'),
      stat('片段', String(asset.clips.length)),
      stat('贴图', asset.stats.textures.map((t) => `${String(t.width)}×${String(t.height)}`).join('、') || '无'),
    );
    const height = String(asset.settings.displayHeight);
    if (parts.slider.value !== height && Number(parts.slider.value) !== asset.settings.displayHeight) parts.slider.value = height;
    parts.heightValue.textContent = `${asset.settings.displayHeight.toFixed(2)} m`;
    parts.turnText.textContent = `已转 ${String(asset.settings.quarterTurns * 90)}°`;
    parts.notices.replaceChildren(...this.noticeList(asset).map((n) => notice(n.level, n.text)));
    const planRows: [string, string][] = [
      ['待机', sourceLabel(plan.idle, skinned)],
      ['走', sourceLabel(plan.walk, skinned)],
      ['跑', sourceLabel(plan.run, skinned)],
      // 没有跳的片段时提示里已经说明“保持当前的动作”，这里只写“无”
      ['跳', plan.jump ? sourceLabel(plan.jump, skinned) : '无'],
    ];
    parts.plan.replaceChildren(
      ...planRows.map(([k, v]) => {
        const box = el('div', { className: 'card-plan-item' });
        box.append(el('dt', { text: k }), el('dd', { text: v }));
        return box;
      }),
    );
    setButtonText(parts.setPlayer, this.host.isPlayer(asset) ? '已设为主角' : '设为主角');
    setButtonText(parts.addPerson, this.host.inRoster(asset) ? '已在名册里' : '加入为新人物');
    // 名册里同一个文件还不可用时，这份副本上的设置先禁用（修改不会被保存）
    const relation = this.host.rosterStatus(asset);
    const lockedReason = settingsLockedReason(relation);
    const editable = lockedReason === null;
    parts.slider.disabled = !editable;
    parts.rotateLeft.disabled = !editable;
    parts.rotateRight.disabled = !editable;
    parts.lockNote.replaceChildren(icon(relation === 'failed' ? 'alert' : 'warning'), el('span', { text: lockedReason ?? '' }));
    parts.lockNote.className = `lock-note mw-notice mw-notice--${relation === 'failed' ? 'error' : 'warning'}`;
    parts.lockNote.hidden = editable;
    parts.clipCount.textContent = `${String(asset.clips.length)} 个`;
    this.renderClips(asset, parts.clips, editable);
  }

  /** 卡片上的提示，按级别分：导入时的警告（文件大、面数多）和效果打折扣的兜底为警告，其余为说明。 */
  private noticeList(asset: ImportedAsset): NoticeSnapshot[] {
    const skinned = asset.stats.skinnedMeshes > 0;
    const out: NoticeSnapshot[] = [];
    for (const w of asset.warnings) out.push({ level: 'warning', text: w });
    for (const n of asset.decisions().plan.notices) {
      out.push({ level: DEGRADED_NOTICES.includes(n) ? 'warning' : 'info', text: poseWording(n, skinned) });
    }
    for (const n of asset.notices) out.push({ level: 'info', text: n });
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /** 卡片上显示的提示文字（快照用，和界面一致）。 */
  private notices(asset: ImportedAsset): string[] {
    const skinned = asset.stats.skinnedMeshes > 0;
    return [...asset.notices, ...asset.warnings, ...asset.decisions().plan.notices.map((n) => poseWording(n, skinned))];
  }

  /** 重建片段列表；之前焦点在列表里的哪个控件，重建后还给同一个控件。 */
  private renderClips(asset: ImportedAsset, list: HTMLOListElement, editable: boolean): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.control : undefined;
    const { clips: decisions } = asset.decisions();
    const items: HTMLLIElement[] = [];
    if (decisions.length === 0) {
      items.push(el('li', { className: 'clip-empty mw-subtle', text: '这个模型没有动画片段。' }));
    }
    for (const d of decisions) {
      const clip = asset.clips[d.index];
      const li = el('li', { className: 'clip-item' });
      li.dataset.clipIndex = String(d.index);

      const playButton = button('预览', () => {
        this.preview.play(d.index);
      }, { icon: 'play', iconOnly: true, size: 'sm', label: `预览片段 ${String(d.index)}` });
      playButton.dataset.control = `play-${String(d.index)}`;
      if (this.preview.snapshot().clipIndex === d.index) playButton.classList.add('is-current');

      const head = el('div', { className: 'clip-head' });
      const clipName = clip?.name ?? '';
      const name = el('span', { className: 'clip-name', text: clipName === '' ? '（未命名）' : clipName });
      name.title = clip?.name ?? '';
      head.append(
        playButton,
        el('span', { className: 'clip-index', text: `#${String(d.index)}` }),
        name,
        el('span', { className: 'clip-duration', text: `${(clip?.duration ?? 0).toFixed(2)} s` }),
      );
      if (d.slot) head.append(tag(`用于${PURPOSE_LABELS[d.slot]}`, 'green'));

      const purposeSelect = el('select', { className: 'mw-select' });
      purposeSelect.dataset.control = `purpose-${String(d.index)}`;
      purposeSelect.setAttribute('aria-label', `片段 ${String(d.index)} 的用途`);
      purposeSelect.add(new Option(`自动：${PURPOSE_LABELS[d.recognized]}`, ''));
      for (const p of PURPOSES) purposeSelect.add(new Option(PURPOSE_LABELS[p], p));
      purposeSelect.value = d.purposeSource === 'manual' ? d.purpose : '';
      purposeSelect.disabled = !editable;
      purposeSelect.addEventListener('change', () => {
        asset.setPurpose(d.index, purposeSelect.value === '' ? null : (purposeSelect.value as Purpose));
      });

      const playbackSelect = el('select', { className: 'mw-select' });
      playbackSelect.dataset.control = `playback-${String(d.index)}`;
      playbackSelect.setAttribute('aria-label', `片段 ${String(d.index)} 的播放方式`);
      const autoLabel =
        d.playbackSource === 'manual'
          ? '自动'
          : `自动：${PLAYBACK_LABELS[d.playback]}${d.playbackSource === 'inferred' ? '（推断）' : '（明确）'}`;
      playbackSelect.add(new Option(autoLabel, ''));
      playbackSelect.add(new Option('循环', 'loop'));
      playbackSelect.add(new Option('一次', 'once'));
      playbackSelect.value = d.playbackSource === 'manual' ? d.playback : '';
      playbackSelect.disabled = !editable;
      playbackSelect.addEventListener('change', () => {
        asset.setPlayback(d.index, playbackSelect.value === '' ? null : (playbackSelect.value as Playback));
      });

      const controls = el('div', { className: 'clip-controls' });
      const purposeField = el('label', { className: 'clip-field' });
      purposeField.append(el('span', { text: '用途' }), purposeSelect);
      const playbackField = el('label', { className: 'clip-field' });
      playbackField.append(el('span', { text: '播放' }), playbackSelect);
      if (d.playbackSource === 'inferred') playbackField.append(tag('推断', 'orange'));
      controls.append(purposeField, playbackField);

      const motion = asset.rootMotion[d.index] ?? { kind: 'none' as const };
      const motionRow = el('div', { className: 'clip-motion' });
      if (motion.kind === 'identified') {
        motionRow.append(el('span', { text: `${motion.flagged ? '带位移' : '原地'} ${motion.maxHorizontal.toFixed(2)} m` }));
        const lockLabel = el('label', { className: 'clip-lock', text: '锁定水平位移' });
        const lock = el('input');
        lock.type = 'checkbox';
        lock.dataset.control = `lock-${String(d.index)}`;
        lock.checked = asset.isMotionLocked(d.index);
        lock.disabled = !editable;
        lock.setAttribute('aria-label', `锁定片段 ${String(d.index)} 的水平位移`);
        lock.addEventListener('change', () => {
          asset.setMotionLocked(d.index, lock.checked);
        });
        lockLabel.prepend(lock);
        motionRow.append(lockLabel);
        if (motion.flagged) motionRow.classList.add('is-flagged');
      } else if (motion.kind === 'unidentified') {
        motionRow.append(el('span', { text: LOCK_UNSUPPORTED_MESSAGE }));
        motionRow.title = motion.reason;
      } else {
        motionRow.append(el('span', { text: '原地' }));
      }

      li.append(head, controls, motionRow);
      if (d.notes.length > 0) li.append(el('p', { className: 'clip-note', text: poseWording(d.notes.join('；'), asset.stats.skinnedMeshes > 0) }));
      items.push(li);
    }
    list.replaceChildren(...items);
    if (active) list.querySelector<HTMLElement>(`[data-control="${active}"]`)?.focus();
  }

  /** 名册变化后刷新卡片：名册里同一个文件恢复好了就换成那一份，否则只刷新按钮文字。 */
  refreshCard(): void {
    if (!this.rebindToRoster()) this.refresh();
  }

  update(dt: number): void {
    if (this.host.isPlaying()) {
      this.dropHint.hidden = true;
      // 开始游玩后不再显示导入的状态提示
      if (this.status.textContent !== '') this.setStatus('');
    }
    if (!this.card.hidden) {
      this.preview.update(dt);
      this.markPlaying();
    }
  }

  /** 片段列表里标出正在预览的片段。 */
  private markPlaying(): void {
    const current = this.preview.snapshot().clipIndex;
    const list = this.parts?.clips;
    if (!list) return;
    for (const b of list.querySelectorAll<HTMLButtonElement>('button[data-control^="play-"]')) {
      b.classList.toggle('is-current', b.dataset.control === `play-${String(current)}`);
    }
  }

  snapshot(): ImportPanelSnapshot {
    const asset = this.asset;
    let card: ImportCardSnapshot | null = null;
    const instance = this.preview.currentInstance();
    if (asset) {
      const skinned = asset.stats.skinnedMeshes > 0;
      const { clips, slots, plan } = asset.decisions();
      const size = instance?.normalizedSize() ?? { width: 0, height: 0, depth: 0 };
      // 归一化之后的绑定姿态包围盒：模型空间的包围盒经过外层节点的变换（预览在播放动画，不用当前姿态）
      const box = instance ? normalizedBox(asset.bounds, instance.outer) : null;
      const rows: ClipRowSnapshot[] = asset.clipViews().map((view) => {
        const motion = view.rootMotion;
        return {
          index: view.index,
          key: view.key,
          name: view.name,
          duration: view.duration,
          recognized: view.decision.recognized,
          purpose: view.decision.purpose,
          purposeSource: view.decision.purposeSource,
          playback: view.decision.playback,
          playbackSource: view.decision.playbackSource,
          loopRaw: view.loopRaw,
          slot: view.decision.slot,
          short: view.decision.short,
          rootMotion: {
            kind: motion.kind,
            nodeName: motion.kind === 'identified' ? motion.nodeName : null,
            maxHorizontal: motion.kind === 'identified' ? motion.maxHorizontal : null,
            flagged: motion.kind === 'identified' && motion.flagged,
            reason: motion.kind === 'unidentified' ? motion.reason : null,
          },
          lockAvailable: motion.kind === 'identified',
          locked: view.locked,
          lockedResidual: asset.lockedResidual(view.index),
          notes: clips[view.index]?.notes ?? [],
        };
      });
      card = {
        assetId: asset.id,
        fileName: asset.fileName,
        format: asset.format,
        sizeBytes: asset.sizeBytes,
        displayHeight: asset.settings.displayHeight,
        quarterTurns: asset.settings.quarterTurns,
        size: { width: size.width, height: size.height, depth: size.depth },
        bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : { min: [0, 0, 0], max: [0, 0, 0] },
        triangles: asset.stats.triangles,
        meshes: asset.stats.meshes,
        skinned,
        bones: asset.stats.bones,
        bindPose: asset.bindPose ? { convention: asset.bindPose.convention } : null,
        textures: asset.stats.textures.map((t) => ({ width: t.width, height: t.height })),
        notices: this.notices(asset),
        noticeLevels: this.noticeList(asset),
        clips: rows,
        slots,
        plan: {
          idle: sourceLabel(plan.idle, skinned),
          walk: sourceLabel(plan.walk, skinned),
          run: sourceLabel(plan.run, skinned),
          jump: plan.jump ? sourceLabel(plan.jump, skinned) : null,
          sway: plan.sway,
        },
        preview: this.preview.snapshot(),
        isPlayer: this.host.isPlayer(asset),
        inRoster: this.host.inRoster(asset),
        rosterOwned: this.host.retains(asset),
        settingsLockedReason: settingsLockedReason(this.host.rosterStatus(asset)),
        shown: !this.card.hidden,
      };
    }
    return { busy: this.busy, error: this.error, warnings: this.warnings, card };
  }
}
