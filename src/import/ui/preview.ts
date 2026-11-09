// 导入卡片里的预览视口：独立的渲染器和场景，放一个预览实例（不计入游戏场景的实例上限）。
// 每个片段可以单独预览播放。

import {
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type AnimationAction,
} from 'three';
import type { ImportedAsset, ModelInstance } from '../asset';

export class PreviewViewport {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 4 / 3, 0.05, 50);
  private instance: ModelInstance | null = null;
  private action: AnimationAction | null = null;
  private clipIndex: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'import-preview';
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // P6：和界面一致的深色底、柔和的天光和一盏暖色主光
    this.scene.background = new Color(0x1a222d);
    this.scene.add(new HemisphereLight(0xdfeaff, 0x3a4352, 1.7));
    const sun = new DirectionalLight(0xfff1dc, 1.9);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    const rim = new DirectionalLight(0x8fb8ff, 0.7);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(rim);
    const grid = new GridHelper(4, 8, 0x4a5a6e, 0x2c3644);
    this.scene.add(grid);
  }

  show(asset: ImportedAsset, clipIndex: number | null): void {
    this.clear();
    this.instance = asset.createInstance();
    this.scene.add(this.instance.swayPivot);
    this.unsubscribe = asset.onChange(() => {
      this.frame();
      if (this.clipIndex !== null) this.play(this.clipIndex);
    });
    this.frame();
    if (clipIndex !== null) this.play(clipIndex);
  }

  private frame(): void {
    const height = this.instance?.normalizedSize().height ?? 1.75;
    const size = this.instance?.normalizedSize();
    const extent = Math.max(height, size?.width ?? 0, size?.depth ?? 0);
    const distance = extent * 1.75 + 0.6;
    this.camera.position.set(distance * 0.42, height * 0.7, distance);
    this.camera.lookAt(0, height * 0.48, 0);
  }

  /** 单独预览一个片段（用游戏里会用的片段：勾选了锁定水平位移时是锁定后的副本）。 */
  play(index: number): void {
    const instance = this.instance;
    if (!instance) return;
    const gameClip = instance.asset.gameClip(index);
    if (!gameClip) return;
    const clip = instance.clipFor(gameClip);
    instance.mixer.stopAllAction();
    const decision = instance.asset.decisions().clips[index];
    const loops = decision?.playback !== 'once';
    const action = instance.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loops ? LoopRepeat : LoopOnce, loops ? Infinity : 1);
    action.clampWhenFinished = !loops;
    action.play();
    this.action = action;
    this.clipIndex = index;
  }

  update(dt: number): void {
    if (!this.instance) return;
    this.instance.mixer.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  snapshot(): { clipIndex: number | null; playing: boolean; mixerTime: number } {
    return {
      clipIndex: this.clipIndex,
      playing: this.action?.isRunning() ?? false,
      mixerTime: this.instance?.mixer.time ?? 0,
    };
  }

  currentInstance(): ModelInstance | null {
    return this.instance;
  }

  clear(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.instance?.dispose();
    this.instance = null;
    this.action = null;
    this.clipIndex = null;
  }

  dispose(): void {
    this.clear();
    this.renderer.dispose();
  }
}
