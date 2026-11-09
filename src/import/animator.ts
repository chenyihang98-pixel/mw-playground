// 导入角色的动画驱动：按模拟状态（待机、走、跑、跳、落地）切换片段，淡入淡出。
// 跳只播一次；其他片段循环与否按片段的播放方式（手动 > 明确的 loop > 推断）。
// 没有适用的移动动作时，移动时让模型整体上下晃动、向前倾（只是整体摆动，不是步态）。

import { LoopOnce, LoopRepeat, type AnimationAction, type Object3D } from 'three';
import type { CharacterModel, CharacterMotion } from '../game/render/characterView';
import { gaitOf } from '../game/render/pose';
import type { ModelInstance } from './asset';
import type { AnimationPlan, MotionSource } from './clipRules';
import { CLIP_RULES } from './limits';

export type MotionState = 'idle' | 'walk' | 'run' | 'jump' | 'land';

export interface AnimatorSnapshot {
  readonly state: MotionState;
  /** 正在播放（权重最大）的片段序号；绑定姿态或没有片段时为 null。 */
  readonly clipIndex: number | null;
  readonly clipName: string | null;
  readonly source: MotionSource['kind'] | null;
  readonly timeScale: number;
  readonly mixerTime: number;
  readonly swaying: boolean;
}

function sourceId(source: MotionSource): string {
  switch (source.kind) {
    case 'clip':
      return `clip:${String(source.index)}:${String(source.timeScale)}`;
    case 'firstFrame':
      return `first:${String(source.index)}`;
    default:
      return source.kind;
  }
}

export class ImportedCharacterModel implements CharacterModel {
  readonly object: Object3D;
  private plan: AnimationPlan;
  private state: MotionState = 'idle';
  private current: { id: string; action: AnimationAction | null; source: MotionSource } | null = null;
  private wasGrounded = true;
  private landTimer = 0;
  private swayPhase = 0;
  private swayAmount = 0;
  private readonly unsubscribe: () => void;

  constructor(readonly instance: ModelInstance) {
    this.object = instance.swayPivot;
    this.plan = instance.asset.decisions().plan;
    this.unsubscribe = instance.asset.onChange(() => {
      // 设置变了（用途、播放方式、锁定）：重新选片段，下一帧重新开始当前状态
      this.plan = instance.asset.decisions().plan;
      this.stopCurrent(0);
    });
    this.apply(this.plan.idle, 0);
  }

  private playbackLoops(index: number, forceOnce: boolean): boolean {
    if (forceOnce) return false;
    const decision = this.instance.asset.decisions().clips[index];
    return decision?.playback !== 'once';
  }

  private stopCurrent(fade: number): void {
    if (this.current?.action) {
      if (fade > 0) this.current.action.fadeOut(fade);
      else this.current.action.stop();
    }
    this.current = null;
  }

  private apply(source: MotionSource, fade: number, forceOnce = false): void {
    const id = sourceId(source) + (forceOnce ? ':once' : '');
    if (this.current?.id === id) return;
    const previous = this.current;
    let action: AnimationAction | null = null;
    if (source.kind === 'clip' || source.kind === 'firstFrame') {
      const clip = this.instance.asset.gameClip(source.index);
      if (clip) {
        action = this.instance.mixer.clipAction(clip);
        action.reset();
        action.enabled = true;
        if (source.kind === 'firstFrame') {
          // 第一帧静止
          action.setLoop(LoopRepeat, Infinity);
          action.time = 0;
          action.paused = true;
          action.setEffectiveTimeScale(1);
        } else {
          const loops = this.playbackLoops(source.index, forceOnce);
          action.setLoop(loops ? LoopRepeat : LoopOnce, loops ? Infinity : 1);
          action.clampWhenFinished = !loops;
          action.paused = false;
          action.setEffectiveTimeScale(source.timeScale);
        }
        action.setEffectiveWeight(1);
        // 同一个片段换播放方式（例如走的第一帧 → 走，或用跑放慢当走）时是同一个 action，不再淡入，避免短暂回到绑定姿态
        if (fade > 0 && previous?.action && previous.action !== action) action.fadeIn(fade);
        action.play();
      }
    }
    if (previous?.action && previous.action !== action) {
      if (fade > 0) previous.action.fadeOut(fade);
      else previous.action.stop();
    }
    this.current = { id, action, source };
  }

  private locomotionSource(state: 'idle' | 'walk' | 'run'): MotionSource {
    if (state === 'idle') return this.plan.idle;
    const source = state === 'walk' ? this.plan.walk : this.plan.run;
    // 整体摆动：底下仍然播待机（或绑定姿态），摆动加在外层的摆动节点上
    return source.kind === 'sway' ? this.plan.idle : source;
  }

  update(motion: CharacterMotion, dt: number): void {
    const gait = gaitOf({ speed: motion.horizontalSpeed, grounded: motion.grounded });
    const ground: 'idle' | 'walk' | 'run' = gait === 'jump' ? 'idle' : gait;
    if (!motion.grounded) {
      this.state = 'jump';
      this.landTimer = 0;
    } else if (!this.wasGrounded) {
      this.state = 'land';
      this.landTimer = CLIP_RULES.landHoldSeconds;
    } else if (this.landTimer > 0) {
      this.landTimer -= dt;
      this.state = this.landTimer > 0 ? 'land' : ground;
    } else {
      this.state = ground;
    }
    this.wasGrounded = motion.grounded;

    if (this.state === 'jump') {
      // 跳只播一次；没有跳的片段时保持当前动作
      if (this.plan.jump) this.apply(this.plan.jump, CLIP_RULES.fadeSeconds, true);
      else if (!this.current) this.apply(this.locomotionSource(ground), CLIP_RULES.fadeSeconds);
    } else if (this.state === 'land') {
      this.apply(this.locomotionSource(ground), CLIP_RULES.landFadeSeconds);
    } else {
      this.apply(this.locomotionSource(this.state), CLIP_RULES.fadeSeconds);
    }

    this.instance.mixer.update(dt);
    this.updateSway(motion, ground, dt);
  }

  private updateSway(motion: CharacterMotion, ground: 'idle' | 'walk' | 'run', dt: number): void {
    const moving = this.plan.sway && motion.grounded && ground !== 'idle';
    const target = moving ? Math.min(1, motion.horizontalSpeed / 5) : 0;
    this.swayAmount += (target - this.swayAmount) * (1 - Math.exp(-dt * 10));
    this.swayPhase += motion.horizontalSpeed * dt * 6;
    const pivot = this.instance.swayPivot;
    pivot.position.y = Math.abs(Math.sin(this.swayPhase)) * 0.06 * this.swayAmount;
    pivot.rotation.x = 0.18 * this.swayAmount;
  }

  snapshot(): AnimatorSnapshot {
    const source = this.current?.source ?? null;
    const index = source && (source.kind === 'clip' || source.kind === 'firstFrame') ? source.index : null;
    return {
      state: this.state,
      clipIndex: index,
      clipName: index === null ? null : (this.instance.asset.clips[index]?.name ?? null),
      source: source?.kind ?? null,
      timeScale: source?.kind === 'clip' ? source.timeScale : 0,
      mixerTime: this.instance.mixer.time,
      swaying: this.swayAmount > 0.05,
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.instance.dispose();
  }
}
