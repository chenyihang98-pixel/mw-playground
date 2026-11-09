// 玩家控制器：按相机方向移动、跑、跳、重力、上坡下坡、从边缘掉落。纯函数。

import { SPEC } from '../spec';
import { moveCapsule } from './collision';
import { groundAt, type Vec3, type World } from './world';

/** 一步模拟的输入。由输入层根据键盘和相机生成；测试直接构造。 */
export interface InputFrame {
  /** W = 1，S = -1。 */
  readonly forward: number;
  /** D = 1，A = -1。 */
  readonly right: number;
  /** 按住 Shift。 */
  readonly run: boolean;
  /** 这一步按下了空格（边沿：只在按下后的第一步为 true）。 */
  readonly jump: boolean;
  /** 相机水平朝向（弧度）。0 表示相机看向 +Z。 */
  readonly cameraYaw: number;
}

export const NO_INPUT: InputFrame = Object.freeze({ forward: 0, right: 0, run: false, jump: false, cameraYaw: 0 });

export interface PlayerState {
  /** 脚底中心。 */
  readonly position: Vec3;
  readonly vy: number;
  readonly grounded: boolean;
  /** 朝向（弧度，0 表示面向 +Z）。 */
  readonly facing: number;
  /** 上一步实际的水平速度（米/秒，碰撞之后）。 */
  readonly horizontalSpeed: number;
  readonly running: boolean;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 输入对应的世界方向（XZ）。长度不超过 1：斜着走不会超速。 */
export function moveDirection(input: InputFrame): { x: number; z: number } {
  let f = Math.max(-1, Math.min(1, finiteOr(input.forward, 0)));
  let r = Math.max(-1, Math.min(1, finiteOr(input.right, 0)));
  const length = Math.hypot(f, r);
  if (length > 1) {
    f /= length;
    r /= length;
  }
  const yaw = finiteOr(input.cameraYaw, 0);
  // 前 = (sin yaw, cos yaw)；右 = 前 × 上 = (-cos yaw, sin yaw)
  return {
    x: Math.sin(yaw) * f - Math.cos(yaw) * r,
    z: Math.cos(yaw) * f + Math.sin(yaw) * r,
  };
}

function turnToward(current: number, target: number, maxStep: number): number {
  let delta = target - current;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

export function spawnPlayer(world: World, x: number, z: number, yaw: number): PlayerState {
  return {
    position: { x, y: groundAt(world, x, z), z },
    vy: 0,
    grounded: true,
    facing: yaw,
    horizontalSpeed: 0,
    running: false,
  };
}

export function stepPlayer(world: World, player: PlayerState, input: InputFrame, dt: number): PlayerState {
  const direction = moveDirection(input);
  const speed = input.run ? SPEC.move.runSpeed : SPEC.move.walkSpeed;
  const allowance = player.grounded ? SPEC.move.stepHeight : 0;
  const start = player.position;
  const moved = moveCapsule(world, start.x, start.z, direction.x * speed * dt, direction.z * speed * dt, start.y, allowance);

  let vy = player.vy;
  let grounded = player.grounded;
  let y = start.y;
  if (grounded && input.jump) {
    vy = SPEC.jump.speed;
    grounded = false;
  }
  if (!grounded) {
    vy -= SPEC.jump.gravity * dt;
    y += vy * dt;
  }
  const support = groundAt(world, moved.x, moved.z);
  if (y <= support) {
    // 落地或迈上台阶
    y = support;
    vy = 0;
    grounded = true;
  } else if (grounded && y - support <= SPEC.move.stepHeight) {
    // 下坡或下小台阶时贴地
    y = support;
    vy = 0;
  } else {
    grounded = false;
  }

  const moving = direction.x !== 0 || direction.z !== 0;
  const facing = moving
    ? turnToward(player.facing, Math.atan2(direction.x, direction.z), SPEC.move.turnRate * dt)
    : player.facing;

  return {
    position: { x: moved.x, y, z: moved.z },
    vy,
    grounded,
    facing,
    horizontalSpeed: Math.hypot(moved.x - start.x, moved.z - start.z) / dt,
    running: input.run && moving,
  };
}
