// 开发用的夹具预览：夹具生成器在内存里生成 GLB，用 GLTFLoader.parse 加载，用 AnimationMixer 播放片段。

import { AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction, type AnimationClip, type Mesh, type Object3D, type Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getFixture, toArrayBuffer, type FixtureId } from '../asset/fixtures';

export interface ClipState {
  readonly name: string;
  readonly duration: number;
  /** 加载后 clip.userData 里有没有 loop 键。 */
  readonly hasLoop: boolean;
  /** 加载后的 clip.userData.loop（原样）。 */
  readonly loop: unknown;
}

export interface PreviewState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly fixtureId: FixtureId | null;
  readonly clips: readonly ClipState[];
  readonly activeClip: number | null;
  /** mixer.time：所有更新累计的时间（秒）。 */
  readonly mixerTime: number;
  /** 当前动作的 time（秒）。 */
  readonly actionTime: number | null;
}

type Listener = (state: PreviewState) => void;

function isMesh(obj: Object3D): obj is Mesh {
  return (obj as Partial<Mesh>).isMesh === true;
}

export class FixturePreview {
  private root: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private clips: AnimationClip[] = [];
  private action: AnimationAction | null = null;
  private status: PreviewState['status'] = 'idle';
  private error: string | null = null;
  private fixtureId: FixtureId | null = null;
  private activeClip: number | null = null;
  private loadToken = 0;
  private readonly listeners: Listener[] = [];

  constructor(private readonly scene: Scene) {}

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    const state = this.state();
    for (const l of this.listeners) l(state);
  }

  async load(id: FixtureId): Promise<void> {
    const spec = getFixture(id);
    if (!spec.previewable) throw new Error(`夹具 ${id} 不能在页面里预览`);
    const token = ++this.loadToken;
    this.status = 'loading';
    this.error = null;
    this.notify();
    try {
      const gltf = await new GLTFLoader().parseAsync(toArrayBuffer(spec.build()), '');
      if (token !== this.loadToken) return; // 已经有更新的加载请求
      this.clear();
      this.root = gltf.scene;
      this.scene.add(gltf.scene);
      this.mixer = new AnimationMixer(gltf.scene);
      this.clips = gltf.animations;
      this.fixtureId = id;
      this.status = 'ready';
      if (this.clips.length > 0) this.play(0);
      else this.notify();
    } catch (error) {
      if (token !== this.loadToken) return;
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      this.notify();
      throw error;
    }
  }

  play(index: number): void {
    const clip = this.clips[index];
    if (!this.mixer || !clip) return;
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    // 只有原始 extras.loop 为 false 的片段播放一次；其他情况循环播放。
    if (clip.userData.loop === false) {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(LoopRepeat, Infinity);
    }
    action.reset().play();
    this.action = action;
    this.activeClip = index;
    this.notify();
  }

  update(delta: number): void {
    this.mixer?.update(delta);
  }

  private clear(): void {
    this.mixer?.stopAllAction();
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((obj) => {
        if (isMesh(obj)) {
          const mesh = obj;
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of materials) m.dispose();
        }
      });
    }
    this.root = null;
    this.mixer = null;
    this.clips = [];
    this.action = null;
    this.activeClip = null;
  }

  state(): PreviewState {
    return {
      status: this.status,
      error: this.error,
      fixtureId: this.fixtureId,
      clips: this.clips.map((clip) => ({
        name: clip.name,
        duration: clip.duration,
        hasLoop: Object.hasOwn(clip.userData, 'loop'),
        loop: clip.userData.loop,
      })),
      activeClip: this.activeClip,
      mixerTime: this.mixer?.time ?? 0,
      actionTime: this.action?.time ?? null,
    };
  }
}
