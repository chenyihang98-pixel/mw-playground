// 已保存的关卡（P5）：确认过的关卡存在浏览器本地（IndexedDB，与名册分库：数据库 mw-playground-levels，对象仓库 levels）；
// 单元测试用内存实现。沿用 P4 的存储接口和写法：带版本号，认不出的版本或损坏的记录提示后跳过（可以删除），
// 存储失败只给提示，不影响游戏。
//
// 每条记录保存：规范化后的说明书和种子、schemaVersion、generatorVersion、最终布局和视觉预设、
// 最终生效的规则（时间限制、收集目标数、守卫扣时和冷却）、来源（随机、程序调整，以后还有模型）和程序调整的记录。
// 重玩时直接用保存的布局和规则：不重新生成，也不重算时间（这里没有调用生成器和时间推算）。

import { z } from 'zod';
import { briefSchema, visualPresetSchema } from '../level/gen/brief';
import { parseLevel } from '../level/schema';
import type { RosterStore, StoredEntry } from '../../roster/store';
import { layoutHash, type LevelPackage, type LevelSource } from './package';

export const SAVED_FORMAT = 'mw-saved-level';
export const SAVED_VERSION = 1;
/** IndexedDB 的数据库名和对象仓库名（与名册分库）。 */
export const SAVED_LEVELS_DB = { database: 'mw-playground-levels', store: 'levels' } as const;

const positive = z.number().positive();

const recordSchema = z.strictObject({
  format: z.literal(SAVED_FORMAT),
  version: z.literal(SAVED_VERSION),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  order: z.number().int().nonnegative(),
  source: z.enum(['random', 'adjusted', 'model']),
  title: z.string().min(1),
  brief: briefSchema,
  seed: z.string(),
  schemaVersion: z.number().int().positive(),
  generatorVersion: z.number().int().positive(),
  layout: z.unknown(),
  visual: visualPresetSchema,
  rules: z.strictObject({ timeLimit: positive, target: z.number().int().positive(), penaltySeconds: z.number().nonnegative(), cooldownSeconds: z.number().nonnegative() }),
  adjustment: z
    .strictObject({ reason: z.enum(['cannot-fit', 'too-far']), change: z.string(), message: z.string(), requestedBrief: briefSchema })
    .nullable(),
});

type SavedRecord = z.output<typeof recordSchema>;

export interface SavedLevelEntry {
  readonly id: string;
  readonly status: 'ready' | 'failed';
  readonly title: string;
  readonly error: string | null;
  readonly source: LevelSource | null;
  readonly layoutHash: string | null;
  readonly timeLimit: number | null;
  readonly tier: string | null;
}

export type SaveResult = { readonly ok: true; readonly id: string; readonly duplicate: boolean } | { readonly ok: false; readonly error: string };

type Decoded = { readonly ok: true; readonly pkg: LevelPackage; readonly order: number } | { readonly ok: false; readonly error: string };

/** 存储里的值还原成一关。只校验、不重新生成、不重算时间。 */
export function decodeSavedLevel(value: unknown, key?: string): Decoded {
  if (typeof value !== 'object' || value === null || (value as { format?: unknown }).format !== SAVED_FORMAT) {
    return { ok: false, error: '记录损坏：不是已保存的关卡' };
  }
  const version = (value as { version?: unknown }).version;
  if (version !== SAVED_VERSION) {
    const shown = typeof version === 'number' || typeof version === 'string' ? String(version) : '缺失';
    return { ok: false, error: `认不出的存储版本（${shown}），本版只认版本 ${String(SAVED_VERSION)}` };
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `记录损坏：${first ? `${first.path.map(String).join('.')}：${first.message}` : '格式不对'}` };
  }
  const r: SavedRecord = parsed.data;
  if (key !== undefined && key !== r.id) return { ok: false, error: '记录损坏：键与记录里的 id 不一致' };
  let layout;
  try {
    layout = parseLevel(r.layout);
  } catch (error) {
    return { ok: false, error: `记录损坏：${error instanceof Error ? error.message : String(error)}` };
  }
  if (layout.timeLimit !== r.rules.timeLimit || layout.target !== r.rules.target) {
    return { ok: false, error: '记录损坏：布局里的时间限制或目标数与保存的规则不一致' };
  }
  if (layoutHash(layout) !== r.id) return { ok: false, error: '记录损坏：布局的哈希与记录的 id 不一致' };
  return {
    ok: true,
    order: r.order,
    pkg: {
      key: `saved:${r.id}`,
      source: r.source,
      title: r.title,
      layout,
      visual: r.visual,
      rules: r.rules,
      brief: r.brief,
      seed: r.seed,
      schemaVersion: r.schemaVersion,
      generatorVersion: r.generatorVersion,
      adjustment: r.adjustment,
      layoutHash: r.id,
    },
  };
}

function encode(pkg: LevelPackage, order: number): SavedRecord | null {
  if (!pkg.brief || pkg.seed === null || pkg.schemaVersion === null || pkg.generatorVersion === null || pkg.source === 'builtin') return null;
  return {
    format: SAVED_FORMAT,
    version: SAVED_VERSION,
    id: pkg.layoutHash,
    order,
    source: pkg.source,
    title: pkg.title,
    brief: pkg.brief,
    seed: pkg.seed,
    schemaVersion: pkg.schemaVersion,
    generatorVersion: pkg.generatorVersion,
    layout: pkg.layout,
    visual: pkg.visual,
    rules: { timeLimit: pkg.rules.timeLimit, target: pkg.rules.target, penaltySeconds: pkg.rules.penaltySeconds, cooldownSeconds: pkg.rules.cooldownSeconds },
    adjustment: pkg.adjustment,
  };
}

interface Item {
  readonly id: string;
  readonly order: number;
  readonly pkg: LevelPackage | null;
  readonly error: string | null;
}

function describeError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'QuotaExceededError') return '存储空间不够';
  if (name === 'SecurityError' || name === 'InvalidStateError') return '浏览器禁止使用本地存储';
  if (error instanceof Error && error.message) return error.message;
  return name || String(error);
}

export class SavedLevels {
  private items: Item[] = [];
  private readonly listeners = new Set<() => void>();
  private problem: string | null = null;
  private noticeList: string[] = [];
  private loadingNow = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly store: RosterStore) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private notice(message: string): void {
    this.noticeList = [...this.noticeList.filter((n) => n !== message), message].slice(-6);
  }

  private failed(what: string, error: unknown): void {
    this.problem = `${what}（${describeError(error)}）。游戏照常运行，本次会话里的关卡列表仍然能用，但刷新后不会保留这些修改`;
    this.notice(this.problem);
    this.emit();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const done = () => {
      this.pending.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  get loading(): boolean {
    return this.loadingNow;
  }

  get notices(): readonly string[] {
    return this.noticeList;
  }

  get storageProblem(): string | null {
    return this.problem;
  }

  /** 页面加载时读出所有已保存的关卡。认不出或损坏的记录提示后跳过（列表里标为失败，可以删除）。 */
  load(): Promise<void> {
    return this.track(this.loadAll());
  }

  private async loadAll(): Promise<void> {
    this.loadingNow = true;
    this.emit();
    let stored: StoredEntry[];
    try {
      stored = await this.store.loadAll();
    } catch (error) {
      this.loadingNow = false;
      this.failed('读不了浏览器里保存的关卡', error);
      return;
    }
    const loaded: Item[] = [];
    for (const { key, value } of stored) {
      if (this.items.some((i) => i.id === key)) continue;
      const decoded = decodeSavedLevel(value, key);
      if (decoded.ok) loaded.push({ id: key, order: decoded.order, pkg: decoded.pkg, error: null });
      else {
        loaded.push({ id: key, order: Number.MAX_SAFE_INTEGER, pkg: null, error: decoded.error });
        this.notice(`已保存的关卡里有一项已跳过：${decoded.error}（记录还在，可以删除）`);
      }
    }
    this.items = [...this.items, ...loaded].sort((a, b) => a.order - b.order);
    this.loadingNow = false;
    this.emit();
  }

  list(): SavedLevelEntry[] {
    return this.items.map((i) => ({
      id: i.id,
      status: i.pkg ? 'ready' : 'failed',
      title: i.pkg?.title ?? '（无法读取的关卡）',
      error: i.error,
      source: i.pkg?.source ?? null,
      layoutHash: i.pkg?.layoutHash ?? null,
      timeLimit: i.pkg?.rules.timeLimit ?? null,
      tier: i.pkg?.brief?.tier ?? null,
    }));
  }

  /** 已保存的一关（用保存的布局和规则）。 */
  get(id: string): LevelPackage | null {
    return this.items.find((i) => i.id === id)?.pkg ?? null;
  }

  /** 保存一关。同一份布局已经保存过时不重复保存。 */
  save(pkg: LevelPackage): SaveResult {
    const existing = this.items.find((i) => i.id === pkg.layoutHash);
    if (existing) return { ok: true, id: existing.id, duplicate: true };
    const order = this.items.reduce((max, i) => (i.order === Number.MAX_SAFE_INTEGER ? max : Math.max(max, i.order + 1)), 0);
    const record = encode(pkg, order);
    if (!record) return { ok: false, error: '只有由说明书生成的关卡才能保存' };
    const saved: LevelPackage = { ...pkg, key: `saved:${record.id}` };
    this.items = [...this.items, { id: record.id, order, pkg: saved, error: null }];
    const write = this.store.put(record.id, record).then(
      () => {
        if (this.problem !== null) {
          this.problem = null;
          this.emit();
        }
      },
      (error: unknown) => {
        this.failed(`关卡“${pkg.title}”没有保存`, error);
      },
    );
    void this.track(write);
    this.emit();
    return { ok: true, id: record.id, duplicate: false };
  }

  remove(id: string): Promise<void> {
    if (!this.items.some((i) => i.id === id)) return Promise.resolve();
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    return this.track(
      this.store.delete(id).then(
        () => undefined,
        (error: unknown) => {
          this.failed('关卡没有从存储里删除', error);
        },
      ),
    );
  }
}
