// 导入界面：“导入角色”按钮（文件选择框）、把文件拖进窗口、错误提示、导入卡片（预览、尺寸、片段列表、提示、
// 旋转按钮、身高滑块、“设为主角”、“加入为新人物”）。功能能用就行，视觉留给 P6。
// P4 起：“加入为新人物”把资产加入名册；“设为主角”在还不在名册里时先加入再设为主角。名册里的人物也能在这里打开、修改设置
// （设置一变名册就保存）。名册里的资产由名册释放，卡片关闭时不释放。
//
// 卡片里的控件（身高滑块、旋转按钮、操作按钮）只在打开卡片时建一次；设置变化时只刷新文字、提示和片段表，
// 不重建正在操作的控件，拖动滑块或连续按方向键时不会丢失焦点。片段表重建后把焦点还给同一个控件。

import './import.css';
import { normalizedBox } from '../normalize';
import { PURPOSE_LABELS, PURPOSES, type MotionSource, type Playback, type Purpose } from '../clipRules';
import { DISPLAY } from '../limits';
import { LOCK_UNSUPPORTED_MESSAGE } from '../motion';
import { fileSource, importModel } from '../pipeline';
import type { ImportedAsset } from '../asset';
import { PreviewViewport } from './preview';
import type { ClipRowSnapshot, ImportCardSnapshot, ImportPanelSnapshot } from './types';

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

function sourceLabel(source: MotionSource | null): string {
  if (source === null) return '无（保持当前动作）';
  switch (source.kind) {
    case 'clip':
      return source.timeScale === 1 ? `#${String(source.index)}` : `#${String(source.index)} ×${source.timeScale.toFixed(2)}`;
    case 'firstFrame':
      return `#${String(source.index)} 的第一帧`;
    case 'bindPose':
      return '绑定姿态';
    case 'sway':
      return '整体摆动';
  }
}

const PLAYBACK_LABELS: Readonly<Record<Playback, string>> = { loop: '循环', once: '一次' };

/** 卡片里需要随设置刷新的部分。 */
interface CardParts {
  readonly info: HTMLElement;
  readonly slider: HTMLInputElement;
  readonly heightValue: HTMLElement;
  readonly turnText: HTMLElement;
  readonly notices: HTMLUListElement;
  readonly planLine: HTMLElement;
  readonly table: HTMLTableElement;
  readonly setPlayer: HTMLButtonElement;
  readonly addPerson: HTMLButtonElement;
  readonly rotateLeft: HTMLButtonElement;
  readonly rotateRight: HTMLButtonElement;
  /** 设置被禁用时的说明。 */
  readonly lockNote: HTMLElement;
}

export class ImportPanel {
  private readonly bar = el('div', { id: 'import-bar' });
  private readonly importButton = el('button', { id: 'import-button', text: '导入角色' });
  private readonly input = el('input', { id: 'import-file' });
  private readonly status = el('span', { id: 'import-status' });
  private readonly errorBox = el('div', { id: 'import-error' });
  private readonly dropHint = el('div', { id: 'import-drop-hint', text: '松开鼠标导入模型（.glb / .obj / .stl / .ply）' });
  private readonly card = el('section', { id: 'import-card' });
  private readonly preview = new PreviewViewport(416, 300);
  private asset: ImportedAsset | null = null;
  /** 卡片上资产的原文件（导入时的 File）；从名册打开的卡片为 null。 */
  private file: Blob | null = null;
  private parts: CardParts | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  private error: string | null = null;
  /** 最近一次导入（成功或失败）的提示。卡片上显示的是卡片所属资产自己的提示。 */
  private warnings: readonly string[] = [];
  private visible = true;

  constructor(
    root: HTMLElement,
    private readonly host: ImportPanelHost,
  ) {
    this.input.type = 'file';
    this.input.accept = '.glb,.obj,.stl,.ply';
    this.input.hidden = true;
    this.importButton.type = 'button';
    this.errorBox.setAttribute('role', 'alert');
    this.status.setAttribute('role', 'status');
    this.card.setAttribute('aria-label', '导入预览');
    this.card.hidden = true;
    this.dropHint.hidden = true;
    this.bar.append(this.importButton, this.status, this.input);
    root.append(this.bar, this.errorBox, this.dropHint, this.card);

    this.importButton.addEventListener('click', () => {
      this.input.value = '';
      this.input.click();
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

  private setError(message: string | null): void {
    this.error = message;
    this.errorBox.textContent = message === null ? '' : `导入失败：${message}`;
  }

  async importFile(file: File): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.importButton.disabled = true;
    this.status.textContent = `正在导入 ${file.name}…`;
    this.setError(null);
    try {
      const outcome = await importModel(fileSource(file));
      this.warnings = outcome.warnings;
      if (!outcome.ok) {
        // 失败时不动当前的卡片、主角和场景
        this.setError(outcome.error);
        this.status.textContent = '';
        return;
      }
      const own = this.host.canonical(outcome.asset);
      if (own !== outcome.asset) {
        // 名册里已有同一个文件：卡片打开名册里的那一份（修改会保存），刚加载的副本释放掉
        outcome.asset.dispose();
        this.open(own, null);
        this.status.textContent = `${file.name} 已在名册里：卡片显示的是名册里的这一项，修改会保存`;
        return;
      }
      this.open(outcome.asset, file);
      this.status.textContent = `已导入 ${file.name}`;
    } catch (error) {
      this.setError(`文件损坏或格式不对，无法解析：${error instanceof Error ? error.message : String(error)}`);
      this.status.textContent = '';
    } finally {
      this.busy = false;
      this.importButton.disabled = false;
    }
  }

  /** 打开名册里的人物，修改设置。 */
  openAsset(asset: ImportedAsset): void {
    if (this.asset === asset) return;
    this.open(asset, null);
    this.status.textContent = `正在修改 ${asset.fileName} 的设置（自动保存到名册）`;
  }

  private open(asset: ImportedAsset, file: Blob | null): void {
    this.close();
    this.asset = asset;
    this.file = file;
    const { slots } = asset.decisions();
    this.preview.show(asset, slots.idle ?? slots.walk ?? (asset.clips.length > 0 ? 0 : null));
    this.parts = this.buildCard(asset);
    this.unsubscribe = asset.onChange(() => {
      this.refresh();
    });
    this.card.hidden = false;
    this.refresh();
  }

  /** 关闭卡片：释放预览实例；资产不在名册里（名册不负责释放）时一并释放。 */
  close(): void {
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
    this.status.textContent = `${own.fileName} 已在名册里：卡片改为显示名册里的这一项，修改会保存`;
    return true;
  }

  /** 卡片的固定部分：只在打开时建一次。 */
  private buildCard(asset: ImportedAsset): CardParts {
    const header = el('div', { className: 'row' });
    header.append(
      el('h2', { text: asset.fileName }),
      button('关闭', () => {
        this.close();
      }),
    );
    const info = el('div');

    const heightRow = el('div', { className: 'row' });
    const heightLabel = el('label', { text: '显示身高' });
    const slider = el('input', { id: 'import-height' });
    slider.type = 'range';
    slider.min = String(DISPLAY.minHeight);
    slider.max = String(DISPLAY.maxHeight);
    slider.step = '0.01';
    slider.value = String(asset.settings.displayHeight);
    slider.setAttribute('aria-label', '显示身高');
    slider.addEventListener('input', () => {
      asset.setDisplayHeight(Number(slider.value));
    });
    const heightValue = el('span');
    heightLabel.append(slider);
    heightRow.append(heightLabel, heightValue);

    const turnRow = el('div', { className: 'row' });
    const turnText = el('span');
    const rotateLeft = button('向左转 90°', () => {
      asset.rotateQuarter(1);
    });
    const rotateRight = button('向右转 90°', () => {
      asset.rotateQuarter(-1);
    });
    turnRow.append(rotateLeft, rotateRight, turnText);
    const lockNote = el('div', { className: 'lock-note' });
    lockNote.setAttribute('role', 'note');

    const notices = el('ul', { id: 'import-notices' });
    const planLine = el('div');
    const table = el('table', { id: 'import-clips' });
    // 操作前先确认卡片上的是名册里的那一份（不是另一份副本）
    const act = (action: (target: ImportedAsset, file: Blob | null) => HostResult) => {
      this.rebindToRoster();
      const target = this.asset;
      if (!target) return;
      const result = action(target, this.file);
      this.status.textContent = result.ok ? result.message : result.error;
      this.refresh();
    };
    const setPlayer = button('设为主角', () => {
      act((target, file) => this.host.setPlayer(target, file));
    });
    const addPerson = button('加入为新人物', () => {
      act((target, file) => this.host.addPerson(target, file));
    });
    const actions = el('div', { className: 'row' });
    actions.append(setPlayer, addPerson);

    this.card.replaceChildren(
      header,
      this.preview.canvas,
      info,
      lockNote,
      heightRow,
      turnRow,
      el('div', { text: '提示：' }),
      notices,
      planLine,
      table,
      actions,
    );
    return { info, slider, heightValue, turnText, notices, planLine, table, setPlayer, addPerson, rotateLeft, rotateRight, lockNote };
  }

  /** 设置变化后刷新卡片的可变部分；不重建身高滑块和按钮。 */
  private refresh(): void {
    const asset = this.asset;
    const parts = this.parts;
    if (!asset || !parts) return;
    const { plan } = asset.decisions();
    const size = this.preview.currentInstance()?.normalizedSize();
    parts.info.textContent =
      `尺寸：宽 ${(size?.width ?? 0).toFixed(2)} × 高 ${(size?.height ?? 0).toFixed(2)} × 深 ${(size?.depth ?? 0).toFixed(2)} m；` +
      `三角面 ${asset.stats.triangles.toLocaleString('en-US')}；` +
      (asset.stats.skinnedMeshes > 0 ? `骨骼 ${String(asset.stats.bones)}；` : '无骨骼；') +
      `片段 ${String(asset.clips.length)}；贴图 ${asset.stats.textures.map((t) => `${String(t.width)}×${String(t.height)}`).join('、') || '无'}`;
    const height = String(asset.settings.displayHeight);
    if (parts.slider.value !== height && Number(parts.slider.value) !== asset.settings.displayHeight) parts.slider.value = height;
    parts.heightValue.textContent = `${asset.settings.displayHeight.toFixed(2)} m（只影响显示，玩法胶囊不变）`;
    parts.turnText.textContent = `已转 ${String(asset.settings.quarterTurns * 90)}°（默认把 +Z 当作正前方）`;
    parts.notices.replaceChildren(...this.notices(asset).map((n) => el('li', { text: n })));
    parts.planLine.textContent = `动作：待机 ${sourceLabel(plan.idle)}；走 ${sourceLabel(plan.walk)}；跑 ${sourceLabel(plan.run)}；跳 ${sourceLabel(plan.jump)}`;
    parts.setPlayer.textContent = this.host.isPlayer(asset) ? '已设为主角' : '设为主角';
    parts.addPerson.textContent = this.host.inRoster(asset) ? '已在名册里' : '加入为新人物';
    // 名册里同一个文件还不可用时，这份副本上的设置先禁用（修改不会被保存）
    const lockedReason = settingsLockedReason(this.host.rosterStatus(asset));
    const editable = lockedReason === null;
    parts.slider.disabled = !editable;
    parts.rotateLeft.disabled = !editable;
    parts.rotateRight.disabled = !editable;
    parts.lockNote.textContent = lockedReason ?? '';
    parts.lockNote.hidden = editable;
    this.renderClipTable(asset, parts.table, editable);
  }

  private notices(asset: ImportedAsset): string[] {
    return [...asset.notices, ...asset.warnings, ...asset.decisions().plan.notices];
  }

  /** 重建片段表；之前焦点在表里的哪个控件，重建后还给同一个控件。 */
  private renderClipTable(asset: ImportedAsset, table: HTMLTableElement, editable: boolean): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.control : undefined;
    const { clips: decisions } = asset.decisions();
    const head = el('tr');
    for (const h of ['#', '名字', '时长', '用途', '播放', '位移', '']) head.append(el('th', { text: h }));
    const rows: HTMLTableRowElement[] = [head];
    for (const d of decisions) {
      const clip = asset.clips[d.index];
      const tr = el('tr');
      tr.dataset.clipIndex = String(d.index);

      const purposeSelect = el('select');
      purposeSelect.dataset.control = `purpose-${String(d.index)}`;
      purposeSelect.setAttribute('aria-label', `片段 ${String(d.index)} 的用途`);
      purposeSelect.add(new Option(`自动：${PURPOSE_LABELS[d.recognized]}`, ''));
      for (const p of PURPOSES) purposeSelect.add(new Option(PURPOSE_LABELS[p], p));
      purposeSelect.value = d.purposeSource === 'manual' ? d.purpose : '';
      purposeSelect.disabled = !editable;
      purposeSelect.addEventListener('change', () => {
        asset.setPurpose(d.index, purposeSelect.value === '' ? null : (purposeSelect.value as Purpose));
      });

      const playbackSelect = el('select');
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

      const motion = asset.rootMotion[d.index] ?? { kind: 'none' as const };
      const motionCell = el('td');
      if (motion.kind === 'identified') {
        motionCell.append(el('span', { text: `${motion.flagged ? '带位移' : '原地'} ${motion.maxHorizontal.toFixed(2)} m ` }));
        const lockLabel = el('label', { text: '锁定水平位移' });
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
        motionCell.append(lockLabel);
      } else if (motion.kind === 'unidentified') {
        motionCell.append(el('span', { text: LOCK_UNSUPPORTED_MESSAGE }));
        motionCell.title = motion.reason;
      } else {
        motionCell.textContent = '原地';
      }

      const playButton = button('▶', () => {
        this.preview.play(d.index);
      });
      playButton.dataset.control = `play-${String(d.index)}`;
      playButton.setAttribute('aria-label', `预览片段 ${String(d.index)}`);

      const purposeCell = el('td');
      purposeCell.append(purposeSelect);
      if (d.slot) purposeCell.append(el('span', { className: 'tag', text: `用于${PURPOSE_LABELS[d.slot]}` }));
      const playbackCell = el('td');
      playbackCell.append(playbackSelect);
      if (d.playbackSource === 'inferred') playbackCell.append(el('span', { className: 'tag warn', text: '推断' }));
      const playCell = el('td');
      playCell.append(playButton);
      tr.append(
        el('td', { text: String(d.index) }),
        el('td', { text: clip?.name ?? '' }),
        el('td', { text: `${(clip?.duration ?? 0).toFixed(2)}s` }),
        purposeCell,
        playbackCell,
        motionCell,
        playCell,
      );
      rows.push(tr);
      if (d.notes.length > 0) {
        const noteRow = el('tr');
        const noteCell = el('td', { className: 'note', text: d.notes.join('；') });
        noteCell.colSpan = 7;
        noteRow.append(noteCell);
        rows.push(noteRow);
      }
    }
    table.replaceChildren(...rows);
    if (active) table.querySelector<HTMLElement>(`[data-control="${active}"]`)?.focus();
  }

  /** 名册变化后刷新卡片：名册里同一个文件恢复好了就换成那一份，否则只刷新按钮文字。 */
  refreshCard(): void {
    if (!this.rebindToRoster()) this.refresh();
  }

  update(dt: number): void {
    const playing = this.host.isPlaying();
    if (playing === this.visible) {
      this.visible = !playing;
      this.bar.hidden = playing;
      this.card.hidden = playing || this.asset === null;
      if (playing) this.dropHint.hidden = true;
    }
    if (!this.card.hidden) this.preview.update(dt);
  }

  snapshot(): ImportPanelSnapshot {
    const asset = this.asset;
    let card: ImportCardSnapshot | null = null;
    const instance = this.preview.currentInstance();
    if (asset) {
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
        skinned: asset.stats.skinnedMeshes > 0,
        bones: asset.stats.bones,
        bindPose: asset.bindPose ? { convention: asset.bindPose.convention } : null,
        textures: asset.stats.textures.map((t) => ({ width: t.width, height: t.height })),
        notices: this.notices(asset),
        clips: rows,
        slots,
        plan: {
          idle: sourceLabel(plan.idle),
          walk: sourceLabel(plan.walk),
          run: sourceLabel(plan.run),
          jump: plan.jump ? sourceLabel(plan.jump) : null,
          sway: plan.sway,
        },
        preview: this.preview.snapshot(),
        isPlayer: this.host.isPlayer(asset),
        inRoster: this.host.inRoster(asset),
        rosterOwned: this.host.retains(asset),
        settingsLockedReason: settingsLockedReason(this.host.rosterStatus(asset)),
      };
    }
    return { busy: this.busy, error: this.error, warnings: this.warnings, card };
  }
}
