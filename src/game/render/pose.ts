// 程序化姿态：根据角色的运动状态算出各关节的角度。纯函数，不依赖 three。
// 角度都是绕本地 X 轴的旋转（弧度）：大腿、手臂为负表示向前摆；膝盖、肘部为正表示弯曲。

import { SPEC } from '../spec';

export interface PoseInput {
  /** 水平速度（米/秒）。 */
  readonly speed: number;
  readonly grounded: boolean;
  /** 竖直速度（米/秒）。 */
  readonly vy: number;
  /** 步态相位（弧度），随走过的距离增加。 */
  readonly gaitPhase: number;
  /** 渲染时间（秒），只用于待机时的呼吸起伏。 */
  readonly time: number;
}

export interface Pose {
  readonly hipL: number;
  readonly hipR: number;
  readonly kneeL: number;
  readonly kneeR: number;
  readonly shoulderL: number;
  readonly shoulderR: number;
  readonly elbowL: number;
  readonly elbowR: number;
  /** 躯干前倾（弧度）。 */
  readonly lean: number;
  /** 身体整体的上下起伏（米）。 */
  readonly bob: number;
  /** 手臂外展（弧度，绕 Z 轴）。 */
  readonly armSpread: number;
}

export type Gait = 'idle' | 'walk' | 'run' | 'jump';

/** 步态分类：在空中算跳，速度接近跑速算跑，有速度算走，否则待机。 */
export function gaitOf(input: Pick<PoseInput, 'speed' | 'grounded'>): Gait {
  if (!input.grounded) return 'jump';
  if (input.speed > (SPEC.move.walkSpeed + SPEC.move.runSpeed) / 2) return 'run';
  if (input.speed > 0.1) return 'walk';
  return 'idle';
}

/** 每走一米步态相位增加多少（弧度）：走路一步约 0.7 m，跑步一步约 1.1 m。 */
export function gaitPhaseRate(speed: number): number {
  const stride = speed > (SPEC.move.walkSpeed + SPEC.move.runSpeed) / 2 ? 2.2 : 1.4;
  return (2 * Math.PI) / stride;
}

export function computePose(input: PoseInput): Pose {
  const gait = gaitOf(input);
  if (gait === 'jump') {
    // 上升时收腿抬臂，下落时腿伸直准备落地
    const rising = input.vy > 0;
    return {
      hipL: rising ? -0.9 : -0.35,
      hipR: rising ? -0.25 : -0.1,
      kneeL: rising ? 1.3 : 0.4,
      kneeR: rising ? 0.6 : 0.25,
      shoulderL: -2.3,
      shoulderR: -2.1,
      elbowL: -0.3,
      elbowR: -0.3,
      lean: 0.1,
      bob: 0,
      armSpread: 0.35,
    };
  }
  if (gait === 'idle') {
    const breath = Math.sin(input.time * 2.2);
    return {
      hipL: 0,
      hipR: 0,
      kneeL: 0.02,
      kneeR: 0.02,
      shoulderL: 0.05 * breath,
      shoulderR: -0.05 * breath,
      elbowL: -0.15,
      elbowR: -0.15,
      lean: 0.02 * breath,
      bob: 0.008 * breath,
      armSpread: 0.08,
    };
  }
  const running = gait === 'run';
  const amplitude = running ? 0.85 : 0.5;
  const s = Math.sin(input.gaitPhase);
  const c = Math.cos(input.gaitPhase);
  return {
    hipL: -amplitude * s,
    hipR: amplitude * s,
    // 腿向后摆、离地时弯膝
    kneeL: Math.max(0, c) * (running ? 1.3 : 0.6) + 0.05,
    kneeR: Math.max(0, -c) * (running ? 1.3 : 0.6) + 0.05,
    // 手臂与同侧腿反向摆
    shoulderL: amplitude * 0.8 * s,
    shoulderR: -amplitude * 0.8 * s,
    elbowL: running ? -1.3 : -0.35,
    elbowR: running ? -1.3 : -0.35,
    lean: running ? 0.22 : 0.06,
    bob: Math.abs(s) * (running ? 0.05 : 0.025),
    armSpread: 0.06,
  };
}
