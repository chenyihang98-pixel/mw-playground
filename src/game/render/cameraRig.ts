// 第三人称跟随相机。只负责视角，不参与模拟；它的水平朝向 yaw 作为输入的一部分传给模拟。
// 这里的数值是镜头手感参数，不是玩法规格。

import type { PerspectiveCamera } from 'three';

const DISTANCE = 5.2;
const FOCUS_HEIGHT = 1.35;
const MIN_PITCH = -0.15;
const MAX_PITCH = 1.15;
const MOUSE_SENSITIVITY = 0.0035;
const KEY_TURN_SPEED = 2.2; // 弧度/秒
const FOLLOW_RATE = 12;

export class CameraRig {
  yaw: number;
  pitch = 0.32;
  private focus: { x: number; y: number; z: number } | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    initialYaw: number,
  ) {
    this.yaw = initialYaw;
  }

  /** 鼠标位移（像素）。向右移动视角向右转，向上移动视角抬起。 */
  look(dx: number, dy: number): void {
    this.yaw -= dx * MOUSE_SENSITIVITY;
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + dy * MOUSE_SENSITIVITY));
  }

  /** 方向键：turn = -1 左转 / 1 右转，tilt = -1 低头 / 1 抬头。 */
  turn(turn: number, tilt: number, dt: number): void {
    this.yaw -= turn * KEY_TURN_SPEED * dt;
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch - tilt * KEY_TURN_SPEED * 0.5 * dt));
  }

  reset(yaw: number, target: { x: number; y: number; z: number }): void {
    this.yaw = yaw;
    this.pitch = 0.32;
    this.focus = { x: target.x, y: target.y + FOCUS_HEIGHT, z: target.z };
    this.update(target, 0);
  }

  update(target: { x: number; y: number; z: number }, dt: number): void {
    const goal = { x: target.x, y: target.y + FOCUS_HEIGHT, z: target.z };
    if (this.focus === null) {
      this.focus = goal;
    } else {
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      this.focus = {
        x: this.focus.x + (goal.x - this.focus.x) * k,
        y: this.focus.y + (goal.y - this.focus.y) * k,
        z: this.focus.z + (goal.z - this.focus.z) * k,
      };
    }
    const horizontal = Math.cos(this.pitch) * DISTANCE;
    this.camera.position.set(
      this.focus.x - Math.sin(this.yaw) * horizontal,
      Math.max(0.3, this.focus.y + Math.sin(this.pitch) * DISTANCE),
      this.focus.z - Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.focus.x, this.focus.y, this.focus.z);
  }
}
