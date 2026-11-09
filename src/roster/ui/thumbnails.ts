// 名册卡片的缩略图（P6）：运行时用一个小的离屏渲染器画出来，只放在内存里，不写进存储（存储格式不变）。
// 名册恢复期间不生成；恢复完以后排队，每次只画一个（setTimeout 分开），不拖慢、不阻塞恢复。
// 姿态：待机片段（没有就用走）的第一帧；都没有时是静止姿态。转向改了会重画。

import { DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { ImportedAsset } from '../../import/asset';

/** 缩略图的边长（像素）。 */
const SIZE = 128;

interface Entry {
  readonly turns: number;
  readonly url: string;
}

export class ThumbnailRenderer {
  private renderer: WebGLRenderer | null = null;
  private broken = false;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(28, 1, 0.05, 60);
  private readonly cache = new WeakMap<ImportedAsset, Entry>();
  private readonly queue: ImportedAsset[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = true;
  private rendered = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.scene.add(new HemisphereLight(0xe8f0ff, 0x404a5a, 1.8));
    const key = new DirectionalLight(0xfff0db, 2.1);
    key.position.set(2, 3.5, 3);
    this.scene.add(key);
    const rim = new DirectionalLight(0x9cc2ff, 0.9);
    rim.position.set(-2.5, 2, -2.5);
    this.scene.add(rim);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** 已经画好的缩略图（data URL）；还没画或转向改了时为 null。 */
  get(asset: ImportedAsset): string | null {
    const entry = this.cache.get(asset);
    return entry?.turns === asset.settings.quarterTurns ? entry.url : null;
  }

  /** 需要这个资产的缩略图：没有就排队。 */
  request(asset: ImportedAsset): void {
    if (this.broken || asset.isDisposed || this.get(asset) !== null || this.queue.includes(asset)) return;
    this.queue.push(asset);
    this.schedule();
  }

  /** 名册恢复期间暂停（恢复完再开始画）。 */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.schedule();
  }

  snapshot(): { readonly rendered: number; readonly queued: number; readonly paused: boolean; readonly available: boolean } {
    return { rendered: this.rendered, queued: this.queue.length, paused: this.paused, available: !this.broken };
  }

  private schedule(): void {
    if (this.paused || this.timer !== null || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.step();
    }, 0);
  }

  private step(): void {
    const asset = this.queue.shift();
    if (asset && !asset.isDisposed && this.get(asset) === null) {
      const url = this.draw(asset);
      if (url !== null) {
        this.cache.set(asset, { turns: asset.settings.quarterTurns, url });
        this.rendered++;
        for (const listener of this.listeners) listener();
      }
    }
    this.schedule();
  }

  private ensureRenderer(): WebGLRenderer | null {
    if (this.renderer || this.broken) return this.renderer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(SIZE, SIZE, false);
      this.renderer.setClearColor(0x000000, 0);
    } catch {
      // 画不了缩略图时卡片显示占位图标，不影响名册
      this.broken = true;
      this.queue.length = 0;
    }
    return this.renderer;
  }

  private draw(asset: ImportedAsset): string | null {
    const renderer = this.ensureRenderer();
    if (!renderer) return null;
    const instance = asset.createInstance();
    try {
      instance.poseBind();
      const { slots } = asset.decisions();
      const index = slots.idle ?? slots.walk;
      const clip = index === null ? null : asset.gameClip(index);
      if (clip) {
        instance.mixer.clipAction(instance.clipFor(clip)).play();
        instance.mixer.update(0);
      }
      this.scene.add(instance.swayPivot);
      const size = instance.normalizedSize();
      const h = Math.max(0.2, size.height);
      const extent = Math.max(h, size.width, size.depth);
      const distance = extent * 1.85 + 0.2;
      this.camera.position.set(distance * 0.42, h * 0.62, distance);
      this.camera.lookAt(0, h * 0.5, 0);
      this.camera.updateProjectionMatrix();
      renderer.render(this.scene, this.camera);
      return renderer.domElement.toDataURL('image/png');
    } catch {
      return null;
    } finally {
      instance.dispose();
    }
  }
}
