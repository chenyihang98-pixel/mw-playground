// 关卡工坊的浏览器端状态（P8）：生成、取消、预览、确认、放弃、回退。不碰 DOM，界面（workshopPanel.ts）只负责显示。
// - 每个异步结果回来时，先确认它还属于当前的生成：放弃过、开始了新的生成之后，迟到的生成或确认响应一律丢弃，
//   不保存、不加载、不改界面。
// - 确认进行中也可以放弃或重新生成：之后迟到的确认响应被丢弃，这一关不会被保存（服务端那边定稿了也不写入）。
// - 按生成标识只写入一次“已保存”。

import type { LevelPackage } from '../game/levels/package';
import type { WorkshopClient, HealthResult } from './client';
import { packageOfWire } from './level';
import type { Fallback, Preview, RosterPersonSnapshot } from './protocol';

export interface WorkshopControllerHost {
  /** 确认后：保存（P5 的保存模块）并加载这一关。 */
  applyLevel(pkg: LevelPackage): void;
  /** 最终失败：加载内置的回退关卡，返回它的标题。 */
  applyFallback(): string;
}

export type WorkshopView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly generationId: string | null; readonly startedAt: number }
  | {
      readonly kind: 'preview';
      readonly generationId: string;
      readonly version: number;
      readonly serviceId: string;
      readonly preview: Preview;
      readonly pkg: LevelPackage;
      readonly confirming: boolean;
      /** 确认没成功时的说明（预览还在，可以再试）。 */
      readonly error: string | null;
    }
  | { readonly kind: 'fallback'; readonly generationId: string; readonly fallback: Fallback; readonly title: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'saved'; readonly generationId: string; readonly title: string }
  | { readonly kind: 'message'; readonly level: 'error' | 'warning' | 'info'; readonly text: string };

export class WorkshopController {
  private viewNow: WorkshopView = { kind: 'idle' };
  private healthNow: HealthResult | null = null;
  /** 已经写进“已保存”的生成标识（按生成标识只写一次）。 */
  private readonly saved = new Set<string>();
  private savesNow = 0;
  /** 每次开始新的生成、放弃、取消时加一：异步结果回来时用它判断是否还属于当前。 */
  private epoch = 0;

  constructor(
    private readonly client: WorkshopClient,
    private readonly host: WorkshopControllerHost,
    private readonly onChange: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get view(): WorkshopView {
    return this.viewNow;
  }

  get health(): HealthResult | null {
    return this.healthNow;
  }

  get saves(): number {
    return this.savesNow;
  }

  private set(view: WorkshopView): void {
    this.viewNow = view;
    this.onChange();
  }

  async checkHealth(): Promise<void> {
    this.healthNow = null;
    this.onChange();
    const health = await this.client.health();
    this.healthNow = health;
    this.onChange();
  }

  /** 模型能不能用（不能用时给出原因）。 */
  get usable(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const health = this.healthNow;
    if (!health) return { ok: false, reason: '正在检查工坊服务…' };
    if (health.kind === 'unreachable') return { ok: false, reason: health.reason };
    if (!health.health.available) return { ok: false, reason: health.health.reason ?? '模型不可用' };
    return { ok: true };
  }

  /** 生成进行中：不能再开始新的生成（同一时间只发一个）。 */
  get locked(): boolean {
    return this.viewNow.kind === 'running';
  }

  async generate(text: string, roster: readonly RosterPersonSnapshot[]): Promise<void> {
    if (text.trim() === '' || this.locked || !this.usable.ok) return;
    const previous = this.viewNow;
    if (previous.kind === 'preview') void this.client.discard(previous.generationId);
    const epoch = ++this.epoch;
    this.set({ kind: 'running', generationId: null, startedAt: this.now() });
    const result = await this.client.generate(text.trim(), roster, (generationId) => {
      if (this.epoch === epoch && this.viewNow.kind === 'running') this.set({ ...this.viewNow, generationId });
    });
    // 迟到的结果（取消过、或者已经开始了新的生成）：丢弃
    if (this.epoch !== epoch || result.kind === 'stale') return;
    switch (result.kind) {
      case 'busy':
        this.set({ kind: 'message', level: 'warning', text: `工坊正忙：${result.message}。请稍后再试。` });
        return;
      case 'unavailable':
        this.set({ kind: 'message', level: 'warning', text: result.reason });
        void this.checkHealth();
        return;
      case 'failed':
        this.set({ kind: 'message', level: 'error', text: result.message });
        return;
      case 'response':
        break;
    }
    const response = result.response;
    if (response.status === 'cancelled') {
      this.set({ kind: 'cancelled' });
      return;
    }
    if (response.status === 'fallback') {
      const title = this.host.applyFallback();
      this.set({ kind: 'fallback', generationId: response.generationId, fallback: response.fallback, title });
      return;
    }
    const wire = packageOfWire(response.preview.level);
    if (!wire.ok) {
      this.set({ kind: 'message', level: 'error', text: wire.error });
      return;
    }
    this.set({
      kind: 'preview',
      generationId: response.generationId,
      version: response.version,
      serviceId: response.serviceId,
      preview: response.preview,
      pkg: wire.pkg,
      confirming: false,
      error: null,
    });
  }

  cancel(): void {
    if (this.viewNow.kind !== 'running') return;
    this.epoch++;
    this.client.cancel();
    this.set({ kind: 'cancelled' });
  }

  async confirm(): Promise<void> {
    const view = this.viewNow;
    if (view.kind !== 'preview' || view.confirming) return;
    const epoch = this.epoch;
    this.set({ ...view, confirming: true, error: null });
    const result = await this.client.confirm(view.generationId, view.version, view.serviceId);
    // 这期间预览已经不是当前的了（放弃、重来、开始了新的生成）：丢弃这个迟到的确认响应，不保存、不加载
    const current = this.viewNow;
    if (this.epoch !== epoch || current.kind !== 'preview' || current.generationId !== view.generationId) return;
    if (result.kind === 'expired') {
      this.set({ kind: 'message', level: 'warning', text: result.message });
      return;
    }
    if (result.kind === 'failed') {
      this.set({ ...current, confirming: false, error: `没有确认成功：${result.message}` });
      return;
    }
    const wire = packageOfWire(result.response.level);
    if (!wire.ok || wire.pkg.layoutHash !== view.pkg.layoutHash) {
      this.set({ kind: 'message', level: 'error', text: wire.ok ? '定稿和预览不一致' : wire.error });
      return;
    }
    // 按生成标识只写入一次
    if (!this.saved.has(view.generationId)) {
      this.saved.add(view.generationId);
      this.savesNow++;
      this.host.applyLevel(wire.pkg);
    }
    this.set({ kind: 'saved', generationId: view.generationId, title: wire.pkg.title });
  }

  /** 放弃预览（确认进行中也可以放弃：之后迟到的确认响应被丢弃）。返回有没有放弃。 */
  discard(): boolean {
    const view = this.viewNow;
    if (view.kind !== 'preview') return false;
    this.epoch++;
    void this.client.discard(view.generationId);
    this.set({ kind: 'idle' });
    return true;
  }
}
