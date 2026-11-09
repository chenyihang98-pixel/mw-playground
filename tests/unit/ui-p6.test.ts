// P6 的单元测试：重做环境之后雨仍在下落、视觉预设的值不变、难度估计的分界、导入卡片的说法（M3）、静音开关的存储。

import { DirectionalLight, HemisphereLight, Scene, type LineSegments } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MUTE_STORAGE_KEY, SoundBoard } from '../../src/game/audio/sound';
import { GEN_CONFIG } from '../../src/game/level/gen/config';
import { builtinEntries, builtinPackage } from '../../src/game/levels/catalog';
import { Environment, WEATHER_FOG } from '../../src/game/render/environment';
import { DIFFICULTY_THRESHOLDS, difficultyOf, estimateDifficulty, sourceBadge } from '../../src/game/ui/levelInfo';
import { poseWording } from '../../src/import/ui/wording';

function environment(): { scene: Scene; env: Environment } {
  const scene = new Scene();
  scene.add(new HemisphereLight(), new DirectionalLight());
  return { scene, env: new Environment(scene) };
}

describe('视觉预设（P6 只改观感，不改值）', () => {
  it('雾的远近和 P5 一样：晴天没有、起雾 6–34 m、下雨 14–70 m', () => {
    expect(WEATHER_FOG).toEqual({ clear: null, fog: { near: 6, far: 34 }, rain: { near: 14, far: 70 } });
    const { env } = environment();
    env.apply({ theme: 'sand', time: 'dusk', weather: 'fog' });
    expect(env.snapshot()).toMatchObject({ theme: 'sand', time: 'dusk', weather: 'fog', fog: { near: 6, far: 34 }, rain: false });
  });

  it('雨丝每一帧都在下落（天空跟着镜头不影响雨），暂停（dt = 0）时不动；渲染用的就是这份坐标', () => {
    const { scene, env } = environment();
    env.apply({ theme: 'snow', time: 'night', weather: 'rain' });
    env.setLevelSize(36, 36);
    const focus = { x: 2, y: 0, z: 3 };
    const camera = { x: 2, y: 3, z: -2 };
    const frames: number[][] = [Array.from(env.rainPositions())];
    for (let i = 0; i < 3; i++) {
      env.update(1 / 60, focus, camera);
      frames.push(Array.from(env.rainPositions()));
    }
    for (let i = 1; i < frames.length; i++) expect(frames[i]).not.toEqual(frames[i - 1]);
    // 只有 y 在变（下落）
    const [first, last] = [frames[0] ?? [], frames.at(-1) ?? []];
    for (let i = 0; i < first.length; i += 3) {
      expect(last[i]).toBe(first[i]);
      expect(last[i + 2]).toBe(first[i + 2]);
    }
    const paused = Array.from(env.rainPositions());
    env.update(0, focus, camera);
    // dt = 0 时只按 float32 重新算一次线段的上端，误差在 1e-5 以内
    const drift = Math.max(...Array.from(env.rainPositions()).map((v, i) => Math.abs(v - (paused[i] ?? NaN))));
    expect(drift).toBeLessThan(1e-5);
    const rain = scene.getObjectByName('rain') as LineSegments;
    expect(rain.visible).toBe(true);
    expect(rain.geometry.getAttribute('position').array).toBe(env.rainPositions());
    expect(env.snapshot()).toMatchObject({ rain: true, fog: { near: 14, far: 70 } });
  });
});

describe('难度估计', () => {
  it('分界取 P5 三档难度系数相邻两档的中点', () => {
    const f = GEN_CONFIG.timing.intent;
    expect(DIFFICULTY_THRESHOLDS.relaxed).toBeCloseTo((f.relaxed + f.normal) / 2, 9);
    expect(DIFFICULTY_THRESHOLDS.normal).toBeCloseTo((f.normal + f.tense) / 2, 9);
    expect(difficultyOf(f.relaxed)).toBe('轻松');
    expect(difficultyOf(f.normal)).toBe('普通');
    expect(difficultyOf(f.tense)).toBe('紧张');
  });

  it('每个内置关卡都有来源和难度估计；系数 =（时间限制 − 余量）/ 路线时间', () => {
    for (const e of builtinEntries()) {
      const pkg = builtinPackage(e.id);
      if (!pkg) throw new Error(`没有内置关卡 ${e.id}`);
      const d = estimateDifficulty(pkg);
      expect(d.label, e.id).not.toBeNull();
      expect(d.factor).toBeCloseTo((pkg.rules.timeLimit - GEN_CONFIG.timing.margin) / (d.routeSeconds ?? NaN), 9);
      expect(sourceBadge(pkg, e.kind).text).toBe(e.kind === 'generated' ? '内置 · 生成' : '内置 · 手工');
      // 估计结果按布局缓存：同一关再算一次得到同一个对象
      expect(estimateDifficulty(pkg)).toBe(d);
    }
  });
});

describe('导入卡片的说法（M3）', () => {
  it('没有骨骼的模型把兜底的“绑定姿态”说成“静止姿态”；带骨骼的照旧', () => {
    expect(poseWording('没有“待机”的片段：使用绑定姿态', false)).toBe('没有“待机”的片段：使用静止姿态');
    expect(poseWording('没有“待机”的片段：使用绑定姿态', true)).toBe('没有“待机”的片段：使用绑定姿态');
    expect(poseWording('STL 使用默认材质', false)).toBe('STL 使用默认材质');
  });
});

describe('静音开关', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('存进 localStorage，下次读回来', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
    const first = new SoundBoard();
    expect(first.snapshot()).toMatchObject({ muted: false, persisted: true });
    let changed = 0;
    first.onChange(() => changed++);
    first.toggle();
    expect(store.get(MUTE_STORAGE_KEY)).toBe('1');
    expect(changed).toBe(1);
    expect(new SoundBoard().snapshot()).toMatchObject({ muted: true, persisted: true });
  });

  it('localStorage 读写都抛错：按没有静音处理（点静音也不静音），不抛错；没有 AudioContext 时播放也不抛错', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('测试：禁止使用 localStorage', 'SecurityError');
      },
    });
    const sound = new SoundBoard();
    expect(sound.snapshot()).toMatchObject({ muted: false, persisted: false });
    expect(() => {
      sound.play('collect');
    }).not.toThrow();
    expect(() => {
      sound.toggle();
    }).not.toThrow();
    expect(sound.snapshot()).toMatchObject({ muted: false, persisted: false });
    expect(sound.storageAvailable).toBe(false);
    sound.play('win');
    expect(sound.snapshot().played).toMatchObject({ collect: 1, win: 1, lose: 0 });
  });

  it('能读但写入抛错（例如配额满了）：静音不生效，仍按没有静音处理', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('测试：写不进去', 'QuotaExceededError');
        },
      },
    });
    const sound = new SoundBoard();
    expect(sound.snapshot()).toMatchObject({ muted: false, persisted: true });
    let changed = 0;
    sound.onChange(() => changed++);
    sound.setMuted(true);
    expect(sound.snapshot()).toMatchObject({ muted: false, persisted: false });
    expect(sound.muted).toBe(false);
    expect(changed).toBe(1);
  });
});
