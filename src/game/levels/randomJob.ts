// “随机一关”的一次生成（P5）：最多尝试 GEN_CONFIG.random.briefs 份随机说明书，每份最多 attempts 次布局尝试和一次程序调整。
// 成功就给出预览（由界面确认、重来或放弃）；全部失败就交给调用方加载内置的回退关卡；中途取消就结束这次生成，
// 不加载回退关卡。生成在主线程上运行；每份说明书之间让出一次（schedule），取消在两份之间生效。
// 检查器拒绝了生成器做出的布局（rejected）是程序缺陷：立即停止，不再换说明书继续生成，把缺陷和具体原因报出来
// （状态 defect，并在控制台记一条错误）；调用方随后加载回退关卡，保证有一关可玩，但不把缺陷当作普通失败。
// 不依赖界面，测试里用同步的 schedule 驱动。

import { GEN_CONFIG } from '../level/gen/config';
import { produceLevel, type ProduceResult } from '../level/gen/pipeline';
import { deriveSeed } from '../level/gen/random';
import { randomBrief, type RosterPerson } from '../level/gen/randomBrief';
import { packageOfProduced, type LevelPackage } from './package';
import { t } from '../../i18n';

export type RandomJobState =
  | { readonly kind: 'running'; readonly tried: number; readonly total: number }
  | { readonly kind: 'preview'; readonly pkg: LevelPackage; readonly tried: number; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly tried: number; readonly reasons: readonly string[] }
  /** 程序缺陷：检查器拒绝了生成器做出的布局。立即停止，不再尝试别的说明书。 */
  | { readonly kind: 'defect'; readonly tried: number; readonly problems: readonly string[] }
  | { readonly kind: 'cancelled'; readonly tried: number };

export interface RandomJobDeps {
  /** 这次生成的根种子（浏览器里来自 crypto.getRandomValues；测试里固定）。 */
  readonly seed: string;
  /** 名册里现有的人物（随机说明书的出场人物从这里选）。 */
  readonly people: readonly RosterPerson[];
  /** 让出一次再继续（浏览器里是 setTimeout；测试里可以直接调用）。 */
  readonly schedule: (step: () => void) => void;
  /** 生成函数（默认 produceLevel；测试可以替换）。 */
  readonly produce?: typeof produceLevel;
  readonly briefs?: number;
}

/** 失败原因的一句话说明。 */
export function describeFailure(result: Exclude<ProduceResult, { ok: true }>): string {
  switch (result.kind) {
    case 'brief':
      return t('random.reasonBrief', { problems: result.problems.map((p) => `${p.path}：${p.message}`).join(t('common.semicolon')) });
    case 'cannot-fit':
    case 'too-far':
      return result.adjustment ? t('random.reasonAdjusted', { message: result.message, change: result.adjustment.change }) : result.message;
    case 'rejected':
      return t('random.reasonDefect', { problems: result.problems.map((p) => p.message).join(t('common.semicolon')) });
  }
}

export class RandomLevelJob {
  private stateNow: RandomJobState;
  private cancelled = false;
  private readonly total: number;
  private readonly reasons: string[] = [];

  constructor(
    private readonly deps: RandomJobDeps,
    private readonly onUpdate: (state: RandomJobState) => void,
  ) {
    this.total = deps.briefs ?? GEN_CONFIG.random.briefs;
    this.stateNow = { kind: 'running', tried: 0, total: this.total };
  }

  get state(): RandomJobState {
    return this.stateNow;
  }

  private set(state: RandomJobState): void {
    this.stateNow = state;
    this.onUpdate(state);
  }

  start(): void {
    this.set(this.stateNow);
    this.deps.schedule(() => {
      this.step(0);
    });
  }

  /** 取消：结束这次生成，不加载回退关卡。生成中或预览中都可以取消。 */
  cancel(): void {
    if (this.stateNow.kind === 'running' || this.stateNow.kind === 'preview') {
      this.cancelled = true;
      this.set({ kind: 'cancelled', tried: this.stateNow.tried });
    }
  }

  private step(index: number): void {
    if (this.cancelled) return;
    const people = this.deps.people;
    const brief = randomBrief(deriveSeed(this.deps.seed, `brief-${String(index)}`), people);
    const produce = this.deps.produce ?? produceLevel;
    const result = produce(brief, deriveSeed(this.deps.seed, `level-${String(index)}`), { rosterIds: new Set(people.map((p) => p.id)) });
    const tried = index + 1;
    if (result.ok) {
      const notes: string[] = [];
      if (result.level.adjustment) notes.push(t('workshop.adjusted', { change: result.level.adjustment.change, message: result.level.adjustment.message }));
      if (this.reasons.length > 0) notes.push(t('random.failedBefore', { count: String(this.reasons.length), reasons: this.reasons.join(t('common.semicolon')) }));
      this.set({ kind: 'preview', pkg: packageOfProduced(result.level), tried, notes });
      return;
    }
    if (result.kind === 'rejected') {
      // 程序缺陷不靠重试掩盖：不换下一份说明书，直接停止并报出来
      const problems = result.problems.map((p) => p.message);
      console.error(t('random.defectStop', { problems: problems.join(t('common.semicolon')) }));
      this.set({ kind: 'defect', tried, problems });
      return;
    }
    this.reasons.push(describeFailure(result));
    if (tried >= this.total) {
      this.set({ kind: 'failed', tried, reasons: [...this.reasons] });
      return;
    }
    this.set({ kind: 'running', tried, total: this.total });
    this.deps.schedule(() => {
      this.step(index + 1);
    });
  }
}
