// 导入的资产：加载结果（模板场景 + 原片段）、片段分析、用户设置，以及创建实例。
// 模板场景从不播放动画，也不加入任何场景；每个实例用 SkeletonUtils.clone 复制，有自己的骨骼和 AnimationMixer。

import { AnimationMixer, Group, PropertyBinding, type AnimationClip, type Box3, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { SPEC } from '../game/spec';
import {
  classifyLoop,
  decideClips,
  planAnimations,
  type AnimationPlan,
  type ClipDecision,
  type ClipFacts,
  type Playback,
  type Purpose,
  type Slots,
} from './clipRules';
import { IMPORT_LIMITS } from './limits';
import { applyBindPose, bindPoseClip, parallelTraverse, type BindPose } from './bindPose';
import { analyzeRootMotion, lockHorizontalMotion, type RootMotion } from './motion';
import { applyNormalization, clampHeight, DEFAULT_NORMALIZE, type NormalizedSize, type NormalizeSettings } from './normalize';
import type { ImportFormat } from './precheck';
import { collectResources, disposeInstancedMeshes, disposeResources, disposeSkeletons, type LoadedStats } from './resources';

/** 文件内容的 SHA-256（十六进制）。浏览器和 Node 都有 crypto.subtle。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 片段的稳定标识：文件内容的 SHA-256 + 片段序号。 */
export function clipKey(assetId: string, index: number): string {
  return `${assetId}#${String(index)}`;
}

function maxKeyframes(clip: AnimationClip): number {
  return clip.tracks.reduce((n, t) => Math.max(n, t.times.length), 0);
}

export interface AssetInput {
  readonly id: string;
  readonly fileName: string;
  readonly format: ImportFormat;
  readonly sizeBytes: number;
  readonly scene: Object3D;
  readonly clips: readonly AnimationClip[];
  /** 绑定姿态（computeBindPose(scene, clips)；没有蒙皮时为 null）。bounds 按它计算。 */
  readonly bindPose: BindPose | null;
  readonly bounds: Box3;
  readonly stats: LoadedStats;
  readonly notices: readonly string[];
  readonly warnings: readonly string[];
}

export interface ClipView {
  readonly index: number;
  readonly key: string;
  readonly name: string;
  readonly duration: number;
  readonly decision: ClipDecision;
  readonly loopRaw: ClipFacts['loopRaw'];
  readonly rootMotion: RootMotion;
  readonly locked: boolean;
}

/** 游戏场景里导入实例的数量限制（导入卡片里的预览不算）。 */
export class InstanceRegistry {
  private live = 0;

  constructor(readonly max: number = IMPORT_LIMITS.instancesMax) {}

  get count(): number {
    return this.live;
  }

  tryAcquire(): boolean {
    if (this.live >= this.max) return false;
    this.live++;
    return true;
  }

  release(): void {
    this.live = Math.max(0, this.live - 1);
  }
}

export class InstanceLimitError extends Error {}

export class ImportedAsset {
  readonly id: string;
  readonly fileName: string;
  readonly format: ImportFormat;
  readonly sizeBytes: number;
  /** 加载出来的场景（模板）。不播放动画，不加入场景，只用来克隆实例。 */
  readonly template: Object3D;
  /** 原片段。永远不修改。 */
  readonly clips: readonly AnimationClip[];
  readonly bounds: Box3;
  readonly stats: LoadedStats;
  readonly notices: readonly string[];
  readonly warnings: readonly string[];
  readonly rootMotion: readonly RootMotion[];
  /** 绑定姿态（带骨骼的模型才有）：包围盒按它计算。 */
  readonly bindPose: BindPose | null;
  /** 绑定姿态的片段（带骨骼的模型才有）：“绑定姿态”兜底用它淡入淡出。轨道路径和文件里的片段一致。 */
  readonly bindClip: AnimationClip | null;
  private readonly loops: readonly ReturnType<typeof classifyLoop>[];

  // 用户设置（只在内存里）
  private normalize: NormalizeSettings = DEFAULT_NORMALIZE;
  /** 手动用途和手动播放方式分开保存。 */
  readonly purposeOverrides = new Map<number, Purpose>();
  readonly playbackOverrides = new Map<number, Playback>();
  private readonly lockedMotion = new Set<number>();
  private readonly lockedClips = new Map<number, AnimationClip>();
  private readonly instances = new Set<ModelInstance>();
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(input: AssetInput) {
    this.id = input.id;
    this.fileName = input.fileName;
    this.format = input.format;
    this.sizeBytes = input.sizeBytes;
    this.template = input.scene;
    this.clips = input.clips;
    this.bounds = input.bounds;
    this.stats = input.stats;
    this.notices = input.notices;
    this.warnings = input.warnings;
    this.loops = input.clips.map((clip) => classifyLoop(clip.userData));
    this.rootMotion = input.clips.map((clip) => analyzeRootMotion(clip, this.template));
    this.bindPose = input.bindPose;
    this.bindClip = input.bindPose ? bindPoseClip(input.bindPose) : null;
  }

  /** 设置变化时通知（实例重新归一化、动画重新选择片段）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  key(index: number): string {
    return clipKey(this.id, index);
  }

  get settings(): NormalizeSettings {
    return this.normalize;
  }

  setDisplayHeight(height: number): void {
    this.normalize = { ...this.normalize, displayHeight: clampHeight(height) };
    this.changed();
  }

  rotateQuarter(direction: 1 | -1): void {
    this.normalize = { ...this.normalize, quarterTurns: (((this.normalize.quarterTurns + direction) % 4) + 4) % 4 };
    this.changed();
  }

  setPurpose(index: number, purpose: Purpose | null): void {
    if (purpose === null) this.purposeOverrides.delete(index);
    else this.purposeOverrides.set(index, purpose);
    this.changed();
  }

  setPlayback(index: number, playback: Playback | null): void {
    if (playback === null) this.playbackOverrides.delete(index);
    else this.playbackOverrides.set(index, playback);
    this.changed();
  }

  /** 能明确识别承担整体位移的节点时，才能锁定水平位移。 */
  canLockMotion(index: number): boolean {
    return this.rootMotion[index]?.kind === 'identified';
  }

  setMotionLocked(index: number, locked: boolean): void {
    if (locked && !this.canLockMotion(index)) throw new Error('该片段不能锁定水平位移');
    if (locked) this.lockedMotion.add(index);
    else this.lockedMotion.delete(index);
    this.changed();
  }

  isMotionLocked(index: number): boolean {
    return this.lockedMotion.has(index);
  }

  facts(): ClipFacts[] {
    return this.clips.map((clip, index) => {
      const motion = this.rootMotion[index];
      const loop = this.loops[index] ?? { raw: 'missing' as const, value: undefined };
      return {
        index,
        name: clip.name,
        duration: clip.duration,
        keyframes: maxKeyframes(clip),
        loopRaw: loop.raw,
        loopValue: loop.value,
        rootMotionActive: motion?.kind === 'identified' && motion.flagged && !this.lockedMotion.has(index),
      };
    });
  }

  decisions(): { clips: ClipDecision[]; slots: Slots; plan: AnimationPlan } {
    const { clips, slots } = decideClips(this.facts(), { purpose: this.purposeOverrides, playback: this.playbackOverrides });
    return { clips, slots, plan: planAnimations(slots, SPEC.move) };
  }

  clipViews(): ClipView[] {
    const { clips } = this.decisions();
    const facts = this.facts();
    return clips.map((decision, index) => ({
      index,
      key: this.key(index),
      name: this.clips[index]?.name ?? `animation_${String(index)}`,
      duration: this.clips[index]?.duration ?? 0,
      decision,
      loopRaw: facts[index]?.loopRaw ?? 'missing',
      rootMotion: this.rootMotion[index] ?? { kind: 'none' },
      locked: this.lockedMotion.has(index),
    }));
  }

  /** 游戏用的片段：勾选了锁定水平位移时用锁定后的副本，否则用原片段。 */
  gameClip(index: number): AnimationClip | null {
    const original = this.clips[index];
    if (!original) return null;
    if (!this.lockedMotion.has(index)) return original;
    const cached = this.lockedClips.get(index);
    if (cached) return cached;
    const motion = this.rootMotion[index];
    if (motion?.kind !== 'identified') return original;
    const locked = lockHorizontalMotion(original, this.template, motion);
    this.lockedClips.set(index, locked);
    return locked;
  }

  /** 锁定之后，游戏用的片段副本里剩下的最大水平位移（模型空间）；没锁定时为 null。用来核对锁定的效果。 */
  lockedResidual(index: number): number | null {
    if (!this.lockedMotion.has(index)) return null;
    const clip = this.gameClip(index);
    if (!clip) return null;
    const motion = analyzeRootMotion(clip, this.template);
    return motion.kind === 'identified' ? motion.maxHorizontal : null;
  }

  /** 创建一个独立的实例（SkeletonUtils.clone）。registry 给出时计入游戏场景的实例上限。 */
  createInstance(registry?: InstanceRegistry): ModelInstance {
    if (this.disposed) throw new Error('资产已经释放');
    if (registry && !registry.tryAcquire()) {
      throw new InstanceLimitError(`同屏的导入实例已经有 ${String(registry.max)} 个，不能再加入`);
    }
    const instance = new ModelInstance(this, registry);
    this.instances.add(instance);
    return instance;
  }

  /** 实例释放时调用。 */
  forget(instance: ModelInstance): void {
    this.instances.delete(instance);
  }

  get instanceCount(): number {
    return this.instances.size;
  }

  /** 释放所有实例和模板的几何、材质、贴图。 */
  dispose(): { geometries: number; materials: number; textures: number } {
    if (this.disposed) return { geometries: 0, materials: 0, textures: 0 };
    for (const instance of [...this.instances]) instance.dispose();
    this.disposed = true;
    this.listeners.clear();
    disposeInstancedMeshes(this.template);
    return disposeResources(collectResources(this.template));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * 一个实例：外层节点 swayPivot（整体摆动用）→ outer（归一化）→ object（克隆的场景）。
 * 每个实例有自己的骨骼和 AnimationMixer；几何、材质、贴图与模板共享，由资产统一释放。
 */
export class ModelInstance {
  readonly swayPivot = new Group();
  readonly outer = new Group();
  readonly object: Object3D;
  /** 这个实例自己的 AnimationMixer（播放状态不与其他实例共享）。 */
  readonly mixer: AnimationMixer;
  /** 模板节点的 UUID → 克隆节点的 UUID（无名节点的轨道按 UUID 指定目标）。 */
  private readonly uuidMap = new Map<string, string>();
  private readonly retargeted = new Map<AnimationClip, AnimationClip>();
  private released = false;
  private size: NormalizedSize;
  private readonly unsubscribe: () => void;

  constructor(
    readonly asset: ImportedAsset,
    private readonly registry?: InstanceRegistry,
  ) {
    this.swayPivot.name = 'imported-sway';
    this.outer.name = 'imported-outer';
    this.object = cloneSkinned(asset.template);
    parallelTraverse(asset.template, this.object, (source, cloned) => {
      this.uuidMap.set(source.uuid, cloned.uuid);
    });
    this.mixer = new AnimationMixer(this.object);
    this.outer.add(this.object);
    this.swayPivot.add(this.outer);
    this.size = applyNormalization(this.outer, asset.bounds, asset.settings);
    this.unsubscribe = asset.onChange(() => {
      this.size = applyNormalization(this.outer, asset.bounds, asset.settings);
    });
  }

  normalizedSize(): NormalizedSize {
    return this.size;
  }

  /** 把这个实例的骨骼直接摆成资产的绑定姿态（不经过 mixer；用在测试和工具里，游戏里用绑定姿态片段淡入淡出）。 */
  poseBind(): void {
    const pose = this.asset.bindPose;
    if (!pose) return;
    const byUuid = new Map<string, Object3D>();
    this.object.traverse((obj) => byUuid.set(obj.uuid, obj));
    applyBindPose(pose, (uuid) => {
      const mapped = this.uuidMap.get(uuid);
      return mapped === undefined ? undefined : byUuid.get(mapped);
    });
    this.object.updateMatrixWorld(true);
  }

  /**
   * 这个实例上播放用的片段。GLTFLoader 给无名节点的轨道用模板节点的 UUID 指定目标，
   * 克隆后节点的 UUID 变了，所以这类片段为每个实例生成一份把目标改成克隆节点的副本；原片段不改。
   * 所有轨道都指向有名字的节点时，直接用原片段。
   */
  clipFor(clip: AnimationClip): AnimationClip {
    const cached = this.retargeted.get(clip);
    if (cached) return cached;
    const remap = (trackName: string): string | null => {
      const { nodeName } = PropertyBinding.parseTrackName(trackName);
      const mapped = this.uuidMap.get(nodeName);
      return mapped !== undefined && trackName.startsWith(nodeName) ? mapped + trackName.slice(nodeName.length) : null;
    };
    let result = clip;
    if (clip.tracks.some((track) => remap(track.name) !== null)) {
      result = clip.clone();
      result.userData = structuredClone(clip.userData);
      for (const track of result.tracks) track.name = remap(track.name) ?? track.name;
    }
    this.retargeted.set(clip, result);
    return result;
  }

  /** 释放这个实例：从场景移除，释放它自己的骨骼；不碰共享的几何、材质、贴图，不影响其他实例。 */
  dispose(): void {
    if (this.released) return;
    this.released = true;
    this.unsubscribe();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    this.swayPivot.removeFromParent();
    disposeSkeletons(this.object);
    disposeInstancedMeshes(this.object);
    this.registry?.release();
    this.asset.forget(this);
  }

  get isDisposed(): boolean {
    return this.released;
  }
}
