// 视觉预设（P5）：主题、时间、天气在场景里的基本效果。只读关卡的设置，不影响模拟。P6 再整理。
// - 主题（grass / sand / snow）：地面和网格的颜色（见 LevelView 的 THEME_COLORS）。
// - 时间（day / dusk / night）：天空颜色、环境光和太阳光的颜色和强度。
// - 天气（clear / fog / rain）：雾（fog 浓、rain 淡、clear 没有）；rain 另有下落的雨滴粒子。
// 不做水面（地图边界照旧）。

import {
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  Points,
  PointsMaterial,
  type Scene,
} from 'three';
import type { TimeOfDay, VisualPreset, Weather } from '../level/gen/brief';

interface TimeLook {
  readonly sky: number;
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  readonly sun: number;
  readonly sunIntensity: number;
}

export const TIME_LOOKS: Readonly<Record<TimeOfDay, TimeLook>> = {
  day: { sky: 0xbfd8ee, hemiSky: 0xffffff, hemiGround: 0x7a6a55, hemiIntensity: 1.4, sun: 0xffffff, sunIntensity: 2 },
  dusk: { sky: 0xe7a77c, hemiSky: 0xffd2a8, hemiGround: 0x5a4060, hemiIntensity: 1.0, sun: 0xff9a5a, sunIntensity: 1.3 },
  night: { sky: 0x141c33, hemiSky: 0x6a7cb8, hemiGround: 0x101018, hemiIntensity: 0.55, sun: 0x9fb4ff, sunIntensity: 0.45 },
};

export const WEATHER_FOG: Readonly<Record<Weather, { near: number; far: number } | null>> = {
  clear: null,
  fog: { near: 6, far: 34 },
  rain: { near: 14, far: 70 },
};

const RAIN_DROPS = 1500;
const RAIN_BOX = { width: 36, height: 14 };
const RAIN_SPEED = 14;

export interface EnvironmentSnapshot {
  readonly theme: string;
  readonly time: string;
  readonly weather: string;
  readonly sky: string;
  readonly fog: { readonly near: number; readonly far: number } | null;
  readonly rain: boolean;
  readonly sunIntensity: number;
}

export class Environment {
  private readonly hemi: HemisphereLight | null;
  private readonly sun: DirectionalLight | null;
  private readonly rain: Points;
  private readonly drops: Float32Array;
  private visual: VisualPreset = { theme: 'grass', time: 'day', weather: 'clear' };

  constructor(private readonly scene: Scene) {
    this.hemi = (scene.children.find((c) => (c as Partial<HemisphereLight>).isHemisphereLight === true) as HemisphereLight | undefined) ?? null;
    this.sun = (scene.children.find((c) => (c as Partial<DirectionalLight>).isDirectionalLight === true) as DirectionalLight | undefined) ?? null;
    // 雨滴的位置由固定的公式铺开（不用随机数，每次都一样）
    this.drops = new Float32Array(RAIN_DROPS * 3);
    for (let i = 0; i < RAIN_DROPS; i++) {
      this.drops[i * 3] = ((i * 7919) % 1000) / 1000 * RAIN_BOX.width - RAIN_BOX.width / 2;
      this.drops[i * 3 + 1] = ((i * 104729) % 1000) / 1000 * RAIN_BOX.height;
      this.drops[i * 3 + 2] = ((i * 1299709) % 1000) / 1000 * RAIN_BOX.width - RAIN_BOX.width / 2;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.drops, 3));
    this.rain = new Points(geometry, new PointsMaterial({ color: 0xaac4e8, size: 0.07, transparent: true, opacity: 0.75 }));
    this.rain.name = 'rain';
    this.rain.visible = false;
    this.rain.frustumCulled = false;
    scene.add(this.rain);
  }

  apply(visual: VisualPreset): void {
    this.visual = visual;
    const look = TIME_LOOKS[visual.time];
    this.scene.background = new Color(look.sky);
    if (this.hemi) {
      this.hemi.color.setHex(look.hemiSky);
      this.hemi.groundColor.setHex(look.hemiGround);
      this.hemi.intensity = look.hemiIntensity;
    }
    if (this.sun) {
      this.sun.color.setHex(look.sun);
      this.sun.intensity = look.sunIntensity;
    }
    const fog = WEATHER_FOG[visual.weather];
    this.scene.fog = fog ? new Fog(look.sky, fog.near, fog.far) : null;
    this.rain.visible = visual.weather === 'rain';
  }

  /** 每帧：雨滴下落并跟着镜头所看的位置。暂停时 dt 为 0。 */
  update(dt: number, focus: { readonly x: number; readonly y: number; readonly z: number }): void {
    if (!this.rain.visible) return;
    this.rain.position.set(focus.x, focus.y - 2, focus.z);
    const position = this.rain.geometry.getAttribute('position');
    for (let i = 0; i < RAIN_DROPS; i++) {
      let y = (this.drops[i * 3 + 1] ?? 0) - RAIN_SPEED * dt;
      if (y < 0) y += RAIN_BOX.height;
      this.drops[i * 3 + 1] = y;
    }
    position.needsUpdate = true;
  }

  snapshot(): EnvironmentSnapshot {
    const fog = this.scene.fog as Fog | null;
    return {
      theme: this.visual.theme,
      time: this.visual.time,
      weather: this.visual.weather,
      sky: `#${(this.scene.background as Color).getHexString()}`,
      fog: fog ? { near: fog.near, far: fog.far } : null,
      rain: this.rain.visible,
      sunIntensity: this.sun?.intensity ?? 0,
    };
  }
}
