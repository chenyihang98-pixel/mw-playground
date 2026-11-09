// 名册（P4）：浏览器本地保存的人物列表。每个人物保存原文件、显示名、显示身高和朝向、片段的手动设置、分工。
//
// - 恢复：读出每条记录，把保存的文件内容重新走一遍 importModel（预检、加载、检查、归一化），再套上保存的设置。
//   不保存加载后的对象或归一化结果。某一项被拒绝、解析失败、版本认不出或记录损坏时给出提示，跳过那一项
//   （记录留在存储里，可以在名册里删除），其余照常恢复。
// - 加入：同一个文件（SHA-256 相同）不重复加入；名册最多 ROSTER_LIMITS.maxPeople 个人物。
// - 分工：主角（含主角兼守卫）最多一个，同伴最多 ROSTER_LIMITS.maxCompanions 个；出场的分配见 cast.ts。
// - 存储失败（配额不够、浏览器禁止、读写抛错）时给出提示；名册在内存里照常可用，只是不保存。
// 加入名册之后，资产上的设置（身高、朝向、片段用途、播放方式、锁定）一变就保存。

import { clipKey, type ImportedAsset } from '../import/asset';
import type { Playback, Purpose } from '../import/clipRules';
import { applyNormalization } from '../import/normalize';
import { blobSource, importModel, type ImportOutcome, type ImportSource } from '../import/pipeline';
import { Group } from 'three';
import { ROLE_LABELS, ROSTER_LIMITS, isPlayerRole, type Role } from './config';
import type { CastMember } from './cast';
import { clipIndexOf, decodeRecord, encodeRecord, type PersonRecord, type PersonSettings } from './format';
import type { RosterStore, StoredEntry } from './store';
import type { RosterEntrySnapshot, RosterSnapshot } from './types';

export type Importer = (source: ImportSource) => Promise<ImportOutcome>;

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type AddResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: 'duplicate' | 'full' | 'reading'; readonly error: string; readonly key: string | null };

/** 存储里的记录还没读出来时加入的提示。 */
export const ROSTER_READING_MESSAGE = '名册正在读取保存的人物，请稍后再加入';

interface Entry {
  readonly key: string;
  /** 存储里的记录；认不出的版本或损坏的记录为 null。 */
  record: PersonRecord | null;
  asset: ImportedAsset | null;
  status: 'loading' | 'ready' | 'failed';
  error: string | null;
  unsubscribe: (() => void) | null;
}

/** 最多保留几条提示。 */
const MAX_NOTICES = 8;

/** 资产当前的设置（按“SHA-256#片段序号”保存片段的手动选择）。 */
export function captureSettings(asset: ImportedAsset): PersonSettings {
  const purposes: Record<string, Purpose> = {};
  for (const [index, purpose] of [...asset.purposeOverrides].sort((a, b) => a[0] - b[0])) purposes[clipKey(asset.id, index)] = purpose;
  const playbacks: Record<string, Playback> = {};
  for (const [index, playback] of [...asset.playbackOverrides].sort((a, b) => a[0] - b[0])) playbacks[clipKey(asset.id, index)] = playback;
  const lockedMotion = asset.clips.map((_, index) => index).filter((index) => asset.isMotionLocked(index)).map((index) => clipKey(asset.id, index));
  return {
    displayHeight: asset.settings.displayHeight,
    quarterTurns: asset.settings.quarterTurns,
    purposes,
    playbacks,
    lockedMotion,
  };
}

/** 把保存的设置套到刚加载的资产上。片段键不属于这个文件、序号超出、不能锁定的项跳过。 */
export function applySettings(asset: ImportedAsset, settings: PersonSettings): void {
  asset.setDisplayHeight(settings.displayHeight);
  asset.setQuarterTurns(settings.quarterTurns);
  for (const [key, purpose] of Object.entries(settings.purposes)) {
    const index = clipIndexOf(key, asset.id);
    if (index !== null && index < asset.clips.length) asset.setPurpose(index, purpose);
  }
  for (const [key, playback] of Object.entries(settings.playbacks)) {
    const index = clipIndexOf(key, asset.id);
    if (index !== null && index < asset.clips.length) asset.setPlayback(index, playback);
  }
  for (const key of settings.lockedMotion) {
    const index = clipIndexOf(key, asset.id);
    if (index !== null && asset.canLockMotion(index)) asset.setMotionLocked(index, true);
  }
}

function describeError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'QuotaExceededError') return '存储空间不够';
  if (name === 'SecurityError' || name === 'InvalidStateError') return '浏览器禁止使用本地存储';
  if (error instanceof Error && error.message) return error.message;
  return name || String(error);
}

export class Roster {
  private readonly list: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private noticeList: string[] = [];
  private storageError: string | null = null;
  private restoringNow = false;
  /** 正在等存储读出所有记录：这期间名册还不完整，不能加入（去重、上限、顺序都要按完整的名册算）。 */
  private reading = false;
  private highlightKey: string | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly store: RosterStore,
    private readonly importer: Importer = importModel,
  ) {}

  // ---------- 通知 ----------

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private notice(message: string): void {
    this.noticeList = [...this.noticeList.filter((n) => n !== message), message].slice(-MAX_NOTICES);
  }

  get notices(): readonly string[] {
    return this.noticeList;
  }

  get restoring(): boolean {
    return this.restoringNow;
  }

  /** 最近一次存储失败的提示；之后保存成功就清空。 */
  get storageProblem(): string | null {
    return this.storageError;
  }

  private storageFailed(what: string, error: unknown): void {
    const message = `${what}（${describeError(error)}）。游戏照常运行，本次会话里的名册仍然能用，但刷新后不会保留这些修改`;
    this.storageError = message;
    this.notice(message);
    this.emit();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const done = () => {
      this.pending.delete(promise);
    };
    // 这里只负责记账；出错的处理在各自的调用处，这个分支不再产生未处理的拒绝
    promise.then(done, done);
    return promise;
  }

  /** 等所有进行中的恢复和保存结束（测试和关闭页面前用）。 */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---------- 查询 ----------

  private find(key: string): Entry | undefined {
    return this.list.find((e) => e.key === key);
  }

  get size(): number {
    return this.list.length;
  }

  /** 这个资产是不是名册里某个人物的（名册负责释放它）。 */
  owns(asset: ImportedAsset): boolean {
    return this.list.some((e) => e.asset === asset);
  }

  has(id: string): boolean {
    return this.find(id) !== undefined;
  }

  assetOf(key: string): ImportedAsset | null {
    const entry = this.find(key);
    return entry?.status === 'ready' ? entry.asset : null;
  }

  /** 这一项的恢复状态；不在名册里时为 null。 */
  statusOf(key: string): 'loading' | 'ready' | 'failed' | null {
    return this.find(key)?.status ?? null;
  }

  roleOf(key: string): Role | null {
    return this.find(key)?.record?.role ?? null;
  }

  nameOf(key: string): string {
    const entry = this.find(key);
    return entry?.record?.displayName ?? key.slice(0, 12);
  }

  /** 给分配规则用：按名册顺序（加入的先后）。 */
  members(): CastMember[] {
    return this.list.map((e) => ({
      id: e.key,
      name: this.nameOf(e.key),
      role: e.record?.role ?? 'none',
      available: e.status === 'ready' && e.asset !== null,
    }));
  }

  // ---------- 恢复 ----------

  /** 页面加载时调用一次：读出所有记录，逐个重新导入并套上设置。 */
  restore(): Promise<void> {
    return this.track(this.restoreAll());
  }

  private async restoreAll(): Promise<void> {
    this.restoringNow = true;
    this.reading = true;
    this.emit();
    let stored: StoredEntry[];
    try {
      stored = await this.store.loadAll();
    } catch (error) {
      this.reading = false;
      this.restoringNow = false;
      this.storageFailed('读不了浏览器里保存的名册', error);
      return;
    }
    const valid: Entry[] = [];
    const broken: Entry[] = [];
    for (const item of stored) {
      if (this.find(item.key)) continue;
      const decoded = decodeRecord(item.value);
      if (!decoded.ok || decoded.record.id !== item.key) {
        const message = decoded.ok ? '记录损坏：键与记录里的 id 不一致' : decoded.message;
        broken.push({ key: item.key, record: null, asset: null, status: 'failed', error: message, unsubscribe: null });
        this.notice(`名册里的一项已跳过：${message}（记录还在，可以在名册里删除）`);
        continue;
      }
      valid.push({ key: item.key, record: decoded.record, asset: null, status: 'loading', error: null, unsubscribe: null });
    }
    valid.sort((a, b) => (a.record?.order ?? 0) - (b.record?.order ?? 0));
    // 先把所有记录（包括还在恢复的、认不出的）放进名册，再允许加入：去重、上限和顺序都按完整的名册算
    this.list.push(...valid, ...broken);
    this.reading = false;
    try {
      this.emit();
      for (const entry of valid) {
        try {
          await this.load(entry);
        } catch (error) {
          // 某一项出了意外的错误：标为失败、跳过，其余照常恢复
          if (entry.status !== 'ready') {
            entry.status = 'failed';
            entry.error = `恢复失败：${describeError(error)}`;
            this.notice(`“${this.nameOf(entry.key)}”${entry.error}，已跳过（记录还在，可以在名册里删除）`);
          }
        }
      }
    } finally {
      this.restoringNow = false;
      this.emit();
    }
  }

  /** 把一条记录的文件重新走一遍 importModel，再套上设置。 */
  private async load(entry: Entry): Promise<void> {
    const record = entry.record;
    if (!record) return;
    const fail = (message: string) => {
      entry.status = 'failed';
      entry.error = message;
      this.notice(`“${record.displayName}”${message}，已跳过（记录还在，可以在名册里删除）`);
      this.emit();
    };
    let outcome: ImportOutcome;
    try {
      outcome = await this.importer(blobSource(record.fileName, record.file));
    } catch (error) {
      fail(`恢复失败：${describeError(error)}`);
      return;
    }
    if (!outcome.ok) {
      fail(`恢复失败：${outcome.error}`);
      return;
    }
    const asset = outcome.asset;
    if (!this.list.includes(entry)) {
      // 恢复期间已经被删除
      asset.dispose();
      return;
    }
    if (asset.id !== record.sha256) {
      asset.dispose();
      fail('恢复失败：文件内容与记录的 SHA-256 不一致');
      return;
    }
    applySettings(asset, record.settings);
    entry.asset = asset;
    entry.status = 'ready';
    this.watch(entry);
    this.emit();
  }

  /** 资产上的设置一变就保存。 */
  private watch(entry: Entry): void {
    const asset = entry.asset;
    if (!asset) return;
    entry.unsubscribe?.();
    entry.unsubscribe = asset.onChange(() => {
      if (!entry.record || entry.asset !== asset) return;
      entry.record = { ...entry.record, settings: captureSettings(asset) };
      this.persist(entry);
      this.emit();
    });
  }

  // ---------- 保存 ----------

  /** 把一条记录写进存储。同一条记录的写入按顺序进行；失败时给出提示，不抛异常。 */
  private persist(entry: Entry): void {
    const record = entry.record;
    if (!record) return;
    const value = encodeRecord(record);
    const previous = this.writes.get(entry.key) ?? Promise.resolve();
    const write = previous
      .then(() => this.store.put(entry.key, value))
      .then(
        () => {
          if (this.storageError !== null) {
            this.storageError = null;
            this.emit();
          }
        },
        (error: unknown) => {
          this.storageFailed(`“${record.displayName}”没有保存`, error);
        },
      );
    this.writes.set(entry.key, write);
    void this.track(write);
  }

  private update(entry: Entry, change: Partial<Pick<PersonRecord, 'displayName' | 'role'>>): void {
    if (!entry.record) return;
    entry.record = { ...entry.record, ...change };
    this.persist(entry);
  }

  // ---------- 操作 ----------

  /** 加入名册（分工为“不出场”）。同一个文件已在名册里时不新增，标出那一项。 */
  add(asset: ImportedAsset, file: Blob): AddResult {
    if (this.reading) {
      this.notice(ROSTER_READING_MESSAGE);
      this.emit();
      return { ok: false, reason: 'reading', error: ROSTER_READING_MESSAGE, key: null };
    }
    const existing = this.find(asset.id);
    if (existing) {
      this.highlightKey = existing.key;
      const error = `“${this.nameOf(existing.key)}”已在名册里`;
      this.notice(error);
      this.emit();
      return { ok: false, reason: 'duplicate', error, key: existing.key };
    }
    if (this.list.length >= ROSTER_LIMITS.maxPeople) {
      const error = `名册已满（最多 ${String(ROSTER_LIMITS.maxPeople)} 个人物），不能再加入`;
      this.notice(error);
      this.emit();
      return { ok: false, reason: 'full', error, key: null };
    }
    const order = this.list.reduce((max, e) => Math.max(max, (e.record?.order ?? -1) + 1), 0);
    const record: PersonRecord = {
      id: asset.id,
      sha256: asset.id,
      fileName: asset.fileName,
      displayName: asset.fileName.slice(0, ROSTER_LIMITS.maxNameLength),
      order,
      role: 'none',
      settings: captureSettings(asset),
      file,
    };
    const entry: Entry = { key: asset.id, record, asset, status: 'ready', error: null, unsubscribe: null };
    this.list.push(entry);
    this.watch(entry);
    this.persist(entry);
    this.highlightKey = null;
    this.emit();
    return { ok: true, key: entry.key };
  }

  /** 设分工。主角只有一个：设新主角时原来的主角（包括主角兼守卫）改为不出场。同伴最多 maxCompanions 个。 */
  setRole(key: string, role: Role): ActionResult {
    const entry = this.find(key);
    if (!entry?.record) return { ok: false, error: '名册里没有这一项' };
    if (entry.status === 'loading') return { ok: false, error: '这一项还在恢复，请稍后再试' };
    if (entry.status !== 'ready') return { ok: false, error: '这一项没有恢复，只能删除' };
    if (entry.record.role === role) return { ok: true };
    if (role === 'companion') {
      // 还在恢复、分工已经是同伴的人物也算在内（恢复完就会出场）
      const companions = this.list.filter((e) => e !== entry && e.status !== 'failed' && e.record?.role === 'companion').length;
      if (companions >= ROSTER_LIMITS.maxCompanions) {
        const error = `${ROLE_LABELS.companion}最多 ${String(ROSTER_LIMITS.maxCompanions)} 个`;
        this.notice(error);
        this.emit();
        return { ok: false, error };
      }
    }
    if (isPlayerRole(role)) {
      for (const other of this.list) {
        if (other !== entry && other.record && isPlayerRole(other.record.role)) {
          this.update(other, { role: 'none' });
          this.notice(`“${other.record.displayName}”不再是主角，改为不出场`);
        }
      }
    }
    this.update(entry, { role });
    this.highlightKey = null;
    this.emit();
    return { ok: true };
  }

  /** 恢复默认主角：原来的主角（包括主角兼守卫）改为不出场。 */
  restoreDefaultPlayer(): void {
    for (const entry of this.list) {
      if (entry.record && isPlayerRole(entry.record.role)) this.update(entry, { role: 'none' });
    }
    this.highlightKey = null;
    this.emit();
  }

  rename(key: string, name: string): ActionResult {
    const entry = this.find(key);
    if (!entry?.record) return { ok: false, error: '名册里没有这一项' };
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, error: '显示名不能为空' };
    if (trimmed.length > ROSTER_LIMITS.maxNameLength) return { ok: false, error: `显示名最长 ${String(ROSTER_LIMITS.maxNameLength)} 个字符` };
    this.update(entry, { displayName: trimmed });
    this.emit();
    return { ok: true };
  }

  /**
   * 删除：先从名册移除并通知（出场的位置随之换回默认小人或移除，释放它的实例），再释放资产，最后从存储里删除。
   */
  remove(key: string): Promise<void> {
    const index = this.list.findIndex((e) => e.key === key);
    const entry = this.list[index];
    if (!entry) return Promise.resolve();
    this.list.splice(index, 1);
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    if (this.highlightKey === key) this.highlightKey = null;
    this.emit();
    entry.asset?.dispose();
    entry.asset = null;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const deletion = previous
      .then(() => this.store.delete(key))
      .then(
        () => undefined,
        (error: unknown) => {
          this.storageFailed(`“${entry.record?.displayName ?? key}”没有从存储里删除`, error);
        },
      );
    this.writes.set(key, deletion);
    return this.track(deletion);
  }

  // ---------- 快照 ----------

  snapshot(): RosterSnapshot {
    const entries: RosterEntrySnapshot[] = this.list.map((e) => {
      const record = e.record;
      const asset = e.status === 'ready' ? e.asset : null;
      const size = asset ? applyNormalization(new Group(), asset.bounds, asset.settings) : null;
      return {
        key: e.key,
        displayName: this.nameOf(e.key),
        fileName: record?.fileName ?? null,
        role: record?.role ?? null,
        roleLabel: record ? ROLE_LABELS[record.role] : null,
        status: e.status,
        error: e.error,
        order: record?.order ?? null,
        displayHeight: record?.settings.displayHeight ?? null,
        quarterTurns: record?.settings.quarterTurns ?? null,
        size: size ? { width: size.width, height: size.height, depth: size.depth } : null,
        slots: asset ? asset.decisions().slots : null,
        manual: record
          ? { purposes: { ...record.settings.purposes }, playbacks: { ...record.settings.playbacks }, lockedMotion: [...record.settings.lockedMotion] }
          : null,
        highlighted: this.highlightKey === e.key,
      };
    });
    return {
      restoring: this.restoringNow,
      saving: this.pending.size > 0,
      max: ROSTER_LIMITS.maxPeople,
      storage: { ok: this.storageError === null, problem: this.storageError },
      notices: [...this.noticeList],
      highlight: this.highlightKey,
      entries,
    };
  }
}
